# Read-only OS bridge. Only fixed metadata is returned; no event messages,
# task arguments, process command lines or raw exceptions are serialized.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$inputData = $env:YJX_RECEIVER_DIAG_INPUT | ConvertFrom-Json
if ($inputData.taskName -notmatch '^yjx-feishu-agent-[a-f0-9]{20}$') { throw 'Invalid diagnostic task name' }
$untilTime = [DateTime]::Parse($inputData.observedAt).ToUniversalTime()
$sinceTime = $untilTime.AddDays(-7)

function HexCode($value) { return ('0x{0:X8}' -f ([int64]$value -band 4294967295L)) }
function QueryFailure($record) {
    $exception = $record.Exception
    while ($exception.InnerException) { $exception = $exception.InnerException }
    return @{ state = 'query_failed'; errorCode = (HexCode $exception.HResult) }
}
function IsoTime($value) {
    if ($null -eq $value -or ([DateTime]$value).Year -lt 2000) { return $null }
    return ([DateTime]$value).ToUniversalTime().ToString('o')
}
function TaskEvidence {
    try {
        $service = New-Object -ComObject 'Schedule.Service'
        $service.Connect()
        $folder = $service.GetFolder('\')
        try { $task = $folder.GetTask([string]$inputData.taskName) }
        catch {
            $failed = QueryFailure $_
            if ($failed.errorCode -in @('0x80070002', '0x8004130F')) { return @{ state = 'not_registered' } }
            return $failed
        }
        $definition = $task.Definition
        $actions = @($definition.Actions)
        $actionMatches = $null
        if ($null -ne $inputData.expectedAction) {
            $actionMatches = $actions.Count -eq 1 -and $actions[0].Type -eq 0 -and
                [string]::Equals($actions[0].Path, $inputData.expectedAction.node, [StringComparison]::OrdinalIgnoreCase) -and
                [string]::Equals($actions[0].Arguments, $inputData.expectedAction.args, [StringComparison]::Ordinal) -and
                [string]::Equals($actions[0].WorkingDirectory, $inputData.expectedAction.cwd, [StringComparison]::OrdinalIgnoreCase)
        }
        $triggers = @($definition.Triggers | ForEach-Object { @{ type = [int]$_.Type; enabled = [bool]$_.Enabled } })
        $resultValue = [int64]$task.LastTaskResult
        return @{ state = 'available'; taskName = [string]$inputData.taskName; enabled = [bool]$task.Enabled;
            taskState = @('unknown', 'disabled', 'queued', 'ready', 'running')[[int]$task.State];
            lastRunTime = (IsoTime $task.LastRunTime); nextRunTime = (IsoTime $task.NextRunTime);
            lastResult = @{ value = $resultValue; hex = (HexCode $resultValue) };
            restart = @{ count = [int]$definition.Settings.RestartCount; interval = [string]$definition.Settings.RestartInterval };
            triggers = $triggers; actionMatchesCurrentEntrypoint = $actionMatches }
    } catch { return (QueryFailure $_) }
}
function ProcessEvidence {
    $receiverPidValue = $inputData.receiverPid
    if ($null -eq $receiverPidValue) { return @{ state = 'not_requested'; reason = 'no_valid_owner_pid' } }
    try {
        $process = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f [int]$receiverPidValue) -ErrorAction Stop
        if ($null -eq $process) { return @{ state = 'not_found'; pid = [int]$receiverPidValue } }
        return @{ state = 'available'; pid = [int]$process.ProcessId; parentPid = [int]$process.ParentProcessId;
            name = [string]$process.Name; startedAt = (IsoTime $process.CreationDate) }
    } catch { return (QueryFailure $_) }
}
function EventEvidence([string]$logName, [int]$limit, [bool]$taskOnly) {
    $window = @{ since = $sinceTime.ToString('o'); until = $untilTime.ToString('o'); limit = $limit }
    try {
        $channel = Get-WinEvent -ListLog $logName -ErrorAction Stop
        $window.channel = @{ name = $logName; enabled = [bool]$channel.IsEnabled }
        if (-not $channel.IsEnabled) { return ($window + @{ state = 'disabled' }) }
        $sinceText = $sinceTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        $untilText = $untilTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        $systemFilter = "TimeCreated[@SystemTime&gt;='$sinceText' and @SystemTime&lt;='$untilText']"
        if ($taskOnly) {
            # taskName is a fixed-prefix hex identifier, never arbitrary XPath.
            $select = "*[System[$systemFilter] and EventData[Data[@Name='TaskName']='\$($inputData.taskName)']]"
        } else {
            $shutdownFilter = "(Provider[@Name='Microsoft-Windows-Kernel-Power'] and EventID=41) or (Provider[@Name='User32'] and EventID=1074) or (Provider[@Name='EventLog'] and (EventID=6005 or EventID=6006 or EventID=6008))"
            $select = "*[System[$systemFilter and ($shutdownFilter)]]"
        }
        $filter = "<QueryList><Query Id='0' Path='$logName'><Select Path='$logName'>$select</Select></Query></QueryList>"
        try { $records = @(Get-WinEvent -FilterXml $filter -MaxEvents ($limit + 1) -ErrorAction Stop) }
        catch {
            if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') {
                return ($window + @{ state = 'no_records'; events = @(); truncated = $false })
            }
            return ($window + (QueryFailure $_))
        }
        $events = @($records | Select-Object -First $limit | ForEach-Object {
            $record = $_
            $entry = @{ id = [int]$record.Id; recordId = [long]$record.RecordId; time = (IsoTime $record.TimeCreated) }
            if (-not $taskOnly) { $entry.provider = [string]$record.ProviderName }
            if ($taskOnly) {
                [xml]$eventXml = $record.ToXml()
                $data = @{}
                foreach ($field in $eventXml.Event.EventData.Data) {
                    $number = 0L
                    if ($field.Name -in @('ProcessID', 'ProcessId', 'EnginePID', 'ResultCode', 'ErrorValue') -and
                        [long]::TryParse([string]$field.'#text', [ref]$number)) {
                        $data[$field.Name] = $number
                    } elseif ($field.Name -in @('TaskInstanceId', 'InstanceId')) {
                        $guidValue = [guid]::Empty
                        if ([guid]::TryParse([string]$field.'#text', [ref]$guidValue)) { $data[$field.Name] = $guidValue.ToString() }
                    }
                }
                $entry.data = $data
            }
            $entry
        })
        return ($window + @{ state = 'available'; events = $events; truncated = $records.Count -gt $limit })
    } catch { return ($window + (QueryFailure $_)) }
}

if ($MyInvocation.InvocationName -ne '.') {
    $value = switch ([string]$inputData.section) {
        'task' { TaskEvidence }
        'process' { ProcessEvidence }
        'taskHistory' { EventEvidence 'Microsoft-Windows-TaskScheduler/Operational' 30 $true }
        'systemHistory' { EventEvidence 'System' 10 $false }
        default { throw 'Invalid diagnostic section' }
    }
    @{ protocolVersion = 1; section = [string]$inputData.section; value = $value } | ConvertTo-Json -Depth 10 -Compress
}
