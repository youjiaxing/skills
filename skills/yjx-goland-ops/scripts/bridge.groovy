import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.execution.*
import com.intellij.execution.impl.ExecutionManagerImpl
import com.intellij.execution.runners.ExecutionEnvironmentBuilder
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.execution.ui.RunContentManager
import com.intellij.execution.process.ProcessListener
import com.intellij.xdebugger.*
import com.intellij.xdebugger.breakpoints.*
import com.intellij.xdebugger.frame.*
import com.intellij.xdebugger.evaluation.XDebuggerEvaluator
import com.intellij.xdebugger.impl.ui.tree.nodes.XValuePresentationUtil
import org.jdom.Element
import com.intellij.openapi.util.JDOMUtil
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.concurrent.*
import java.util.concurrent.atomic.*

// This fixed program is loaded through ideScript. User input is JSON, never source.
def gson = new GsonBuilder().disableHtmlEscaping().create()
def req = gson.fromJson(requestFile.getText('UTF-8'), Map)
def uuid = { UUID.randomUUID().toString() }
def sha = { value -> MessageDigest.getInstance('SHA-256').digest(value.toString().getBytes(StandardCharsets.UTF_8)).encodeHex().toString() }
def now = { System.currentTimeMillis() }
def samePath = { a, b ->
    if (!a || !b) return false
    try { return Files.isSameFile(new File(a.toString()).toPath(), new File(b.toString()).toPath()) }
    catch (Throwable ignored) { return false }
}
def atomic = { File file, Object data ->
    file.parentFile.mkdirs()
    def tmp = new File(file.parentFile, file.name + '.' + uuid() + '.tmp')
    try {
        tmp.setText(gson.toJson(data), 'UTF-8')
        Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
    } finally { tmp.delete() }
}
def secretPattern = ~/(?i)(password|passwd|secret|token|authorization|cookie|api.?key|credential)/
def secrets = new HashSet<String>()
def cleanText = { Object input ->
    def text = input == null ? null : input.toString()
    if (text == null) return null
    secrets.each { s -> if (s.size() >= 4) text = text.replace(s, '[REDACTED]') }
    text = text.replaceAll(/(?i)((?:--?)(?:password|passwd|token|secret|api-key)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/, '$1[REDACTED]')
    text
}
def scrub
scrub = { Object value ->
    if (value instanceof Map) return value.collectEntries { k, v -> [(k.toString()): secretPattern.matcher(k.toString()).find() ? '[REDACTED]' : scrub(v)] }
    if (value instanceof Collection) return value.collect { scrub(it) }
    if (value instanceof CharSequence) return cleanText(value)
    value
}
def respond = { Map response ->
    response.requestId = req.requestId
    atomic(new File(requestFile.parentFile, 'result.json'), scrub(response))
}
def fail = { String code, String message -> throw new IllegalStateException(code + ': ' + message) }
def errorResponse = { Throwable t ->
    def message = t.message ?: t.toString()
    def match = message =~ /^([A-Z][A-Z0-9_]+): (.*)$/
    [outcome: 'failed', code: match.matches() ? match[0][1] : 'IDE_ERROR', message: cleanText(match.matches() ? match[0][2] : message)]
}
def app = ApplicationManager.getApplication()
if (req.version != 1 || !(req.requestId ==~ /[a-f0-9-]{36}/) || requestFile.parentFile.name != req.requestId ||
        !samePath(requestFile.parentFile.parentFile.parentFile.path, req.dataRoot)) {
    respond([outcome: 'failed', code: 'INVALID_REQUEST', message: '请求目录或协议版本不匹配'])
    return
}
if (ProcessHandle.current().pid() != (req.expectedPid as long) || !samePath(PathManager.configPath, req.profile)) {
    respond([outcome: 'failed', code: 'WRONG_IDE', message: '实际 IDE 实例与指定 PID/profile 不匹配，未执行操作'])
    return
}
def registry
synchronized (app) {
    def key = Key.findKeyByName('yjx.goland.ops.v1') ?: Key.create('yjx.goland.ops.v1')
    registry = app.getUserData(key)
    if (registry == null) {
        registry = [
            boot: uuid(), requests: [:], busy: [:], runs: new IdentityHashMap(), debugs: new IdentityHashMap(), knownSecrets: new HashSet<String>(),
            projects: new IdentityHashMap(), breakpoints: new IdentityHashMap(), consoleDocuments: new IdentityHashMap(),
        ]
        app.putUserData(key, registry)
    }
}
if (registry.knownSecrets == null) registry.knownSecrets = new HashSet<String>()
if (registry.consoleDocuments == null) registry.consoleDocuments = new IdentityHashMap()
secrets.addAll(registry.knownSecrets)
def args = req.args ?: [:]
args.limit = Math.min(200, Math.max(1, (args.limit ?: 50) as int))
def operation = req.operation
def record
synchronized (registry) {
    if (registry.requests.containsKey(req.requestId)) {
        respond(registry.requests[req.requestId].result ?: [outcome: 'pending', code: 'ALREADY_REGISTERED'])
        return
    }
    record = [id: req.requestId, operation: operation, profile: req.profile, project: req.project, at: now(), deadline: req.deadline as long,
              root: req.dataRoot, result: [outcome: 'pending', code: 'QUEUED'], dispatched: false, done: false]
    registry.requests[req.requestId] = record
}
def publish = { Map result ->
    result.requestId = record.id
    result.bootId = registry.boot
    record.result = scrub(result)
    record.flush = {
        try { respond(record.result); record.receiptError = null }
        catch (IOException failure) { record.receiptError = cleanText(failure.message) }
    }
    // Windows scanners/readers may transiently deny atomic replacement. Retrying a
    // receipt must never replay, invalidate, or reclassify a confirmed IDE action.
    record.flush()
}
def finish = { Map result ->
    record.done = true
    record.tick = null
    record.reconcile = null
    if (record.busyKey && registry.busy[record.busyKey]?.is(record)) registry.busy.remove(record.busyKey)
    publish(result)
}
def failRequest = { Throwable t ->
    record.tick = null
    record.observerError = cleanText(t.toString())
    if (record.mutationOccurred && operation in ['config.clone', 'config.update']) {
        publish([outcome: 'unknown', code: 'CONFIG_PARTIALLY_APPLIED', message: '配置可能已修改，保存未确认；查询原请求，不重放', cause: cleanText(t.message)])
    } else if (record.startDispatchAttempted || (record.dispatched && !(operation == 'run.restart' && record.previousSessionStopped))) {
        publish([outcome: 'unknown', code: 'DISPATCH_STATE_UNCONFIRMED', message: '动作可能已派发，已停止重复推进；先核实会话和原请求', cause: cleanText(t.message)])
    } else {
        def response = errorResponse(t)
        if (record.previousSessionStopped) response.previousSessionState = 'stopped'
        finish(response)
    }
}
record.onError = failRequest
def watch
watch = { Closure condition, boolean runNow = true ->
    def tick
    tick = {
        if (record.done || record.advancing) return
        record.advancing = true
        try {
            record.polls = (record.polls ?: 0) + 1
            def answer = condition()
            if (answer?.handoff) return
            if (answer?.outcome in ['pending', 'unknown']) { record.tick = null; publish(answer); return }
            if (answer != null) { finish(answer); return }
            if (now() > record.deadline && record.result.outcome != 'unknown')
                publish([outcome: 'unknown', code: 'ACTION_UNRESOLVED', message: '动作已派发，仍在等待真实状态；查询原请求，不重放'])
        } catch (Throwable t) { failRequest(t) }
        finally { record.advancing = false }
    }
    record.tick = tick
    if (runNow) tick()
    if (!record.done && record.result.outcome == 'pending')
        publish([outcome: 'pending', code: 'AWAITING_STATE', phase: record.phase, message: '动作已派发，等待后置状态'])
}
def rememberSecrets = { configuration ->
    try { configuration.customEnvironment.each { k, v -> if (secretPattern.matcher(k.toString()).find() && v) { secrets.add(v.toString()); registry.knownSecrets.add(v.toString()) } } } catch (Throwable ignored) {}
}
def configSnapshot = { settings ->
    JDOMUtil.writeElement(settings.writeScheme())
}
def configRevision = { settings -> sha(configSnapshot(settings)) }
def canonicalElement
canonicalElement = { Element element ->
    element == null ? null : [
        name: element.name,
        attributes: element.attributes.collectEntries { [(it.name): it.value] }.sort(),
        text: element.textTrim,
        children: element.children.collect { canonicalElement(it) },
    ]
}
def configurationState = { configuration ->
    def element = new Element('configuration')
    configuration.writeExternal(element)
    canonicalElement(element)
}
def confirmPersistence = { p, settings ->
    def directory = new File(p.basePath, '.idea/runConfigurations')
    List<File> files
    if (settings.isStoredInLocalWorkspace()) files = [new File(p.basePath, '.idea/workspace.xml')]
    else if (settings.isStoredInArbitraryFileInProject()) {
        def specified = new File(settings.pathIfStoredInArbitraryFileInProject)
        files = [specified.absolute ? specified : new File(p.basePath, specified.path)]
    } else files = (directory.listFiles() ?: []).findAll { it.name.endsWith('.xml') }.take(2000)
    for (def file : files) {
        if (!file.isFile() || file.length() > 16 * 1024 * 1024) continue
        try {
            def root = JDOMUtil.load(file)
            List<Element> configurations = []
            if (root.name == 'configuration') configurations.add(root)
            else if (root.name == 'component') configurations.addAll(root.getChildren('configuration'))
            else if (root.name == 'project') root.getChildren('component').findAll { it.getAttributeValue('name') == 'RunManager' }.each { configurations.addAll(it.getChildren('configuration')) }
            def persisted = configurations.find { it.getAttributeValue('name') == settings.name && it.getAttributeValue('type') == settings.type.id }
            if (persisted == null) continue
            def copy = persisted.clone()
            com.intellij.openapi.components.PathMacroManager.getInstance(p).expandPaths(copy)
            def loaded = settings.clone()
            loaded.configuration.readExternal(copy)
            def tasksEqual = canonicalElement(settings.writeScheme().getChild('method')) == canonicalElement(persisted.getChild('method'))
            if (configurationState(loaded.configuration) == configurationState(settings.configuration) && tasksEqual)
                return [confirmed: true, file: file.canonicalPath]
        } catch (Throwable ignored) { /* No disk confirmation is reported as unknown, never as a successful save. */ }
    }
    [confirmed: false]
}
def callIf = { Object object, String method, Object fallback ->
    object.metaClass.respondsTo(object, method) ? object."$method"() : fallback
}
def sdkInfo = { configuration ->
    if (configuration.type.id != 'GoApplicationRunConfiguration') return [state: 'unsupported']
    try {
        def serviceClass = configuration.class.classLoader.loadClass('com.goide.sdk.GoSdkService')
        def service = serviceClass.getMethod('getInstance', com.intellij.openapi.project.Project).invoke(null, configuration.project)
        def sdk = service.getSdk(configuration.configurationModule.module)
        return sdk == null ? [state: 'not-configured'] : [state: 'configured', home: sdk.homeUrl, version: sdk.version?.toString()]
    } catch (Throwable ignored) { return [state: 'unavailable'] }
}
def configInfo = { settings ->
    def c = settings.configuration
    rememberSecrets(c)
    def env = callIf(c, 'getCustomEnvironment', [:])
    def source = settings.isStoredInArbitraryFileInProject() ? settings.pathIfStoredInArbitraryFileInProject :
        (settings.shared ? '.idea/runConfigurations' : '.idea/workspace.xml')
    [
        id: settings.uniqueID, name: settings.name, type: settings.type.id, revision: configRevision(settings),
        storage: [shared: settings.shared, source: source],
        workingDirectory: callIf(c, 'getWorkingDirectory', null),
        programArguments: callIf(c, 'getParams', callIf(c, 'getProgramParameters', null)),
        goToolArguments: callIf(c, 'getGoToolParams', null),
        kind: callIf(c, 'getKind', null)?.toString(), files: callIf(c, 'getFilePaths', null),
        package: callIf(c, 'getPackage', null), directory: callIf(c, 'getDirectoryPath', null),
        environment: env.collectEntries { k, v -> [(k): '[REDACTED]'] },
        inheritEnvironment: callIf(c, 'isPassParentEnvironment', null),
        module: callIf(c, 'getConfigurationModule', null)?.module?.name,
        sdk: sdkInfo(c),
        beforeRun: c.beforeRunTasks.collect { [provider: it.providerId.toString(), enabled: it.enabled] },
    ]
}
def consoleObject = { descriptor ->
    def c = descriptor.executionConsole
    for (int i = 0; i < 4 && c != null; i++) {
        if (c.metaClass.respondsTo(c, 'getText') || c.metaClass.respondsTo(c, 'getEditor')) return c
        if (c.metaClass.respondsTo(c, 'getDelegate')) { c = c.delegate; continue }
        break
    }
    null
}
def consoleText = { descriptor ->
    def c = consoleObject(descriptor)
    if (c == null || !c.metaClass.respondsTo(c, 'getEditor')) return null
    def document = c.editor?.document
    if (document == null) return null
    int end = document.textLength
    document.getText(new TextRange(Math.max(0, end - 262144), end))
}
def selectedProject = {
    if (!req.project) fail('PROJECT_REQUIRED', '此操作需要 --project 完整项目路径')
    def matches = ProjectManager.getInstance().openProjects.findAll { it.basePath && samePath(it.basePath, req.project) }
    if (matches.size() != 1) fail('PROJECT_NOT_OPEN', '目标项目未唯一打开')
    matches[0]
}
def selectedConfig = { p ->
    if (!args.config) fail('CONFIG_REQUIRED', '需要 --config 精确名称或 ID')
    def matches = RunManager.getInstance(p).allSettings.findAll { it.name == args.config || it.uniqueID == args.config }
    if (matches.size() != 1) fail('CONFIG_AMBIGUOUS', '运行配置未唯一匹配')
    matches[0]
}
def configKey = { p, settings -> p.basePath + '\n' + settings.uniqueID }
def localGo = { settings ->
    if (settings.type.id != 'GoApplicationRunConfiguration') fail('UNSUPPORTED_CONFIGURATION', '首批执行控制仅支持本地 Go Build/Application 配置')
    if (callIf(settings.configuration, 'getDefaultTargetName', null)) fail('REMOTE_TARGET_UNSUPPORTED', '首批不执行远程运行目标')
}
def runSessions = { p ->
    def em = ExecutionManager.getInstance(p)
    RunContentManager.getInstance(p).allDescriptors.findAll { it.processHandler != null }.collect { d ->
        def h = d.processHandler
        def entry = registry.runs[h]
        if (entry == null) {
            entry = [token: uuid(), handler: h, descriptor: d, project: p.basePath]
            registry.runs[h] = entry
        }
        entry.descriptor = d
        def settings = em.getConfigurations(d).toList()
        def executors = em.getExecutors(d).collect { it.id }
        entry.configurations = settings
        entry.executors = executors
        entry
    }
}
def runInfo = { entry ->
    def h = entry.handler
    [
        session: entry.token, name: entry.descriptor.displayName, executor: entry.executors,
        configurations: entry.configurations.collect { [id: it.uniqueID, name: it.name] },
        state: h.processTerminated ? 'stopped' : (h.processTerminating ? 'stopping' : 'running'),
        exitCode: h.exitCode, executionId: entry.descriptor.executionId,
    ]
}
def chooseRun = { p ->
    def entries = runSessions(p)
    def matches
    if (args.session) matches = entries.findAll { it.token == args.session }
    else {
        def settings = selectedConfig(p)
        matches = entries.findAll { !it.handler.processTerminated && it.configurations.any { it.uniqueID == settings.uniqueID } }
    }
    if (matches.size() != 1) fail('SESSION_AMBIGUOUS', '会话未唯一匹配，先查询 run status 并指定 --session')
    if (matches[0].executors.contains('Debug')) fail('DEBUG_SESSION_REQUIRES_DEBUG_COMMAND', '目标是 Debug 会话；使用 debug list 后通过 Debug 命令控制')
    if (!matches[0].executors.contains('Run')) fail('RUN_EXECUTOR_UNVERIFIED', '无法证明目标是普通 Run 会话，未执行控制')
    matches[0]
}
def acquire = { String key ->
    def prior = registry.busy[key]
    if (prior && !prior.is(record)) fail('BUSY', '配置或会话有未决请求 ' + prior.id)
    registry.busy[key] = record
    record.busyKey = key
}
def ensureNoActive = { p, settings ->
    def active = runSessions(p).findAll { !it.handler.processTerminated && it.configurations.any { c -> c.uniqueID == settings.uniqueID } }
    if (active) fail('ALREADY_RUNNING', '已有运行或调试会话；先查询对应会话，不重复启动')
    def debug = XDebuggerManager.getInstance(p).debugSessions.any {
        !it.stopped && (it.runProfile.is(settings.configuration) ||
                (it.runProfile.name == settings.name && it.runProfile.type.id == settings.type.id))
    }
    if (debug) fail('ALREADY_RUNNING', '该配置已有 Debug 会话；不隐式转换或并行启动普通 Run')
}
def checkConfiguration = { settings ->
    rememberSecrets(settings.configuration)
    settings.configuration.checkConfiguration()
}
def attachOutput = { handler ->
    synchronized (record) {
        if (record.observedHandlers == null) record.observedHandlers = Collections.newSetFromMap(new IdentityHashMap())
        if (!record.observedHandlers.add(handler)) return
    }
    handler.addProcessListener([
        onTextAvailable: { event, type ->
            synchronized (record) {
                record.output = ((record.output ?: '') + event.text).takeRight(32768)
            }
        }
    ] as ProcessListener)
}
def debugEntry, debugInfo, chooseDebug, pauseContext, selectFrame, debugAction
def breakpointInfo, breakpointAction
def startRun
startRun = { p, settings, boolean debug ->
    localGo(settings)
    checkConfiguration(settings)
    ensureNoActive(p, settings)
    acquire(configKey(p, settings))
    def executor = debug ? DefaultDebugExecutor.getDebugExecutorInstance() : DefaultRunExecutor.getRunExecutorInstance()
    def environment = ExecutionEnvironmentBuilder.create(executor, settings).build()
    for (def otherExecutor : [DefaultRunExecutor.getRunExecutorInstance(), DefaultDebugExecutor.getDebugExecutorInstance()]) {
        def candidateEnvironment = ExecutionEnvironmentBuilder.create(otherExecutor, settings).build()
        if (ExecutionManager.getInstance(p).isStarting(settings.uniqueID, otherExecutor.id, candidateEnvironment.runner.runnerId))
            fail('BUSY', 'IDE 已有此配置的构建或启动任务，未重复派发')
    }
    def connection = p.messageBus.connect()
    def matches = { env -> env.is(environment) }
    connection.subscribe(ExecutionManager.EXECUTION_TOPIC, [
        processStartScheduled: { String executorId, env -> if (matches(env)) record.phase = 'scheduled' },
        processStarting: { Object... event ->
            if (event.length >= 2 && matches(event[1])) {
                record.phase = 'starting'
                if (event.length > 2) { record.handler = event[2]; attachOutput(event[2]) }
            }
        },
        processNotStarted: { Object... event ->
            if (event.length >= 2 && matches(event[1])) {
                record.launchFailure = event.length > 2 && event[2] != null ? event[2].toString() : 'IDE reported processNotStarted; no detailed cause was retained'
                record.phase = 'not-started'
                connection.disconnect()
            }
        },
        processStarted: { String executorId, env, handler ->
            if (matches(env)) { record.handler = handler; record.phase = 'running'; attachOutput(handler) }
        },
        processTerminated: { String executorId, env, handler, int exitCode ->
            if (matches(env)) { record.phase = 'terminated'; record.exitCode = exitCode; connection.disconnect() }
        },
    ] as ExecutionListener)
    record.environment = environment
    record.phase = 'accepted'
    def startedCondition = {
        if (record.launchFailure) return [outcome: 'failed', code: 'PROCESS_NOT_STARTED', phase: record.phase, message: record.launchFailure, output: record.output ?: '']
        if (record.handler?.processTerminated) {
            // Go compilation is replayed into the IDE console, not the synthetic exit handler.
            // Allow deferred console output to settle before reporting the actual compiler evidence.
            if (!record.exitObservedAt) record.exitObservedAt = now()
            def descriptor = RunContentManager.getInstance(p).findContentDescriptor(executor, record.handler)
            if (descriptor != null && descriptor.processHandler?.is(record.handler)) {
                if (!record.consoleFlushScheduled) {
                    record.consoleFlushScheduled = true
                    def console = consoleObject(descriptor)
                    if (console != null && console.metaClass.respondsTo(console, 'performWhenNoDeferredOutput', Runnable))
                        console.performWhenNoDeferredOutput({ record.consoleFlushed = true } as Runnable)
                    else record.consoleFlushed = true
                }
                if (!record.consoleFlushed && now() - record.exitObservedAt < 3000) return null
                def text = consoleText(descriptor)
                if (text != null && text.length() >= (record.output ?: '').length()) record.output = text.takeRight(32768)
            }
            if (now() - record.exitObservedAt < 500) return null
            def compileFailure = record.handler.class.name.contains('GoNopProcessHandler') && record.handler.exitCode != 0
            record.phase = compileFailure ? 'compilation-failed' : 'terminated'
            return [outcome: 'failed', code: compileFailure ? 'COMPILATION_FAILED' : 'PROCESS_EXITED', phase: record.phase,
                    exitCode: record.handler.exitCode, output: record.output ?: '',
                    evidenceScope: 'retained IDE console; output channels may be merged or truncated']
        }
        if (record.phase == 'running' && !debug) {
            def entry = runSessions(p).find { it.handler.is(record.handler) }
            if (entry) return [outcome: 'ok', state: 'running', session: entry.token, configuration: settings.uniqueID, processReadyOnly: true]
        }
        if (debug && record.phase == 'running') {
            def sessions = XDebuggerManager.getInstance(p).debugSessions.findAll { !it.stopped && it.runProfile.is(environment.runProfile) }
            if (sessions.size() == 1) return [outcome: 'ok', debug: debugInfo(debugEntry(p, sessions[0]))]
        }
        null
    }
    watch(startedCondition, false)
    record.startDispatchAttempted = true
    record.dispatched = true
    try {
        ProgramRunnerUtil.executeConfiguration(environment, false, true)
        record.startDispatchReturned = true
        record.tick?.call()
    } catch (Throwable t) { failRequest(t) }
}

// Debug support is defined below; never serialize an IDE object to the protocol.
def execute = {
    if (registry.requests.size() > 1024) {
        def removable = registry.requests.values().findAll {
            it.done && it.id != record.id && it.id != args.request && (!it.handler || it.handler.processTerminated)
        }.sort { it.at }
        removable.take(Math.max(0, registry.requests.size() - 768)).each { registry.requests.remove(it.id) }
    }
    if (registry.runs.size() > 256) {
        def old = registry.runs.entrySet().collect { [key: it.key, value: it.value] }.findAll { it.key.processTerminated && it.value.token != args.session }
        old.take(Math.max(0, registry.runs.size() - 192)).each { registry.runs.remove(it.key) }
    }
    if (registry.debugs.size() > 128) {
        def old = registry.debugs.entrySet().collect { [key: it.key, value: it.value] }.findAll { it.key.stopped && it.value.token != args.session }
        old.take(Math.max(0, registry.debugs.size() - 96)).each { registry.debugs.remove(it.key) }
    }
    if (now() > record.deadline) { finish([outcome: 'failed', code: 'EXPIRED_BEFORE_DISPATCH', message: '请求在执行前过期，未执行动作']); return }
    if (operation == 'project.list') {
        finish([outcome: 'ok', pid: ProcessHandle.current().pid(), profile: PathManager.configPath,
                projects: ProjectManager.getInstance().openProjects.collect { [path: it.basePath, name: it.name, initialized: it.initialized] }])
        return
    }
    if (operation == 'attempt.show') {
        secrets.addAll(registry.knownSecrets)
        def target = registry.requests[args.request]
        if (target) {
            if (!samePath(target.profile, req.profile) || !(target.project == null && req.project == null) && !samePath(target.project, req.project))
                fail('REQUEST_TARGET_MISMATCH', '原请求不属于此 profile/project')
            if (target.reconcile != null && !target.done) target.reconcile()
            if (target.tick != null && !target.done) target.tick()
            finish([outcome: 'ok', attempt: [requestId: target.id, operation: target.operation, phase: target.phase,
                    result: target.result, output: target.output ?: '', exitCode: target.exitCode, polls: target.polls, observerError: target.observerError, receiptError: target.receiptError]])
        } else {
            def file = new File(req.dataRoot, 'requests/' + args.request + '/result.json')
            if (!(args.request ==~ /[a-f0-9-]{36}/) || !file.isFile()) fail('ATTEMPT_NOT_FOUND', '当前 IDE 没有该请求证据')
            def journal = gson.fromJson(new File(file.parentFile, 'journal.json').getText('UTF-8'), Map)
            if (!samePath(journal.profile, req.profile) || !(journal.project == null && req.project == null) && !samePath(journal.project, req.project))
                fail('REQUEST_TARGET_MISMATCH', '历史请求不属于此 profile/project')
            finish([outcome: 'ok', cached: true, attempt: gson.fromJson(file.getText('UTF-8'), Map)])
        }
        return
    }
    if (operation == 'doctor') {
        def project = req.project ? ProjectManager.getInstance().openProjects.find { samePath(it.basePath, req.project) } : null
        def dialogs = java.awt.Window.windows.findAll { it.visible && it instanceof javax.swing.JDialog }.collect { [title: it.title, modal: it.modal] }
        finish([outcome: 'ok', profile: PathManager.configPath, pid: ProcessHandle.current().pid(), version: com.intellij.openapi.application.ApplicationInfo.getInstance().fullVersion,
                bridgeAvailable: true, projectOpen: project != null, initialized: project?.initialized,
                indexing: project ? DumbService.getInstance(project).isDumb() : null, dialogs: dialogs,
                trust: project ? com.intellij.ide.impl.TrustedProjects.getTrustedState(project).toString() : 'project-not-open',
                sdk: project ? RunManager.getInstance(project).allSettings.findAll { it.type.id == 'GoApplicationRunConfiguration' }.take(1).collect { sdkInfo(it.configuration) } : [],
                modules: project ? com.intellij.openapi.module.ModuleManager.getInstance(project).modules.collect { it.name } : [],
                configurations: project ? RunManager.getInstance(project).allSettings.collect { [id: it.uniqueID, name: it.name, type: it.type.id] } : []])
        return
    }
    def p = selectedProject()
    if (operation == 'project.probe') {
        def blocked = java.awt.Window.windows.any { it.visible && it instanceof javax.swing.JDialog && it.modal }
        finish([outcome: blocked ? 'blocked' : 'ok', code: blocked ? 'IDE_MODAL_DIALOG' : null,
                project: [path: p.basePath, initialized: p.initialized, indexing: DumbService.getInstance(p).isDumb()]])
        return
    }
    if (operation == 'config.list') { finish([outcome: 'ok', configurations: RunManager.getInstance(p).allSettings.collect { configInfo(it) }]); return }
    if (operation in ['config.show', 'config.check']) {
        def settings = selectedConfig(p)
        def info = configInfo(settings)
        if (operation == 'config.check') {
            try { checkConfiguration(settings); info.validation = [state: 'passed'] }
            catch (Throwable t) { info.validation = [state: 'failed', message: cleanText(t.message)] }
        }
        finish([outcome: 'ok', configuration: info]); return
    }
    if (operation in ['config.clone', 'config.update']) {
        def settings = selectedConfig(p)
        def before = configInfo(settings)
        def key = configKey(p, settings)
        acquire(key)
        if (operation == 'config.update' && (!args.revision || args.revision != before.revision)) fail('REVISION_CONFLICT', 'config update 必须提供当前 --revision')
        def patch = args.patch ?: [:]
        if (!(patch instanceof Map)) fail('INVALID_PATCH', 'patch 必须是 JSON 对象')
        def supported = ['workingDirectory', 'programArguments', 'goToolArguments', 'kind', 'files', 'package', 'directory', 'environment', 'removeEnvironment', 'inheritEnvironment'] as Set
        if (patch.keySet().any { !supported.contains(it) }) fail('UNSUPPORTED_PATCH_FIELD', 'patch 包含未支持字段')
        for (def field : ['workingDirectory', 'programArguments', 'goToolArguments', 'package', 'directory'])
            if (patch.containsKey(field) && patch[field] != null && !(patch[field] instanceof String))
                fail('INVALID_PATCH_TYPE', '字符串字段类型不正确')
        if (patch.containsKey('files') && (!(patch.files instanceof List) || patch.files.size() > 100 || patch.files.any { !(it instanceof String) }))
            fail('INVALID_PATCH_TYPE', 'files 必须是有界字符串列表')
        if (patch.containsKey('environment') && (!(patch.environment instanceof Map) || patch.environment.size() > 1000))
            fail('INVALID_PATCH_TYPE', 'environment 必须是有界对象')
        if (patch.containsKey('removeEnvironment') && (!(patch.removeEnvironment instanceof List) || patch.removeEnvironment.any { !(it instanceof String) }))
            fail('INVALID_PATCH_TYPE', 'removeEnvironment 必须是字符串列表')
        if (patch.containsKey('kind') && !(patch.kind in ['FILE', 'PACKAGE', 'DIRECTORY'])) fail('INVALID_PATCH_TYPE', '无效 Go 入口类型')
        localGo(settings)
        if (operation == 'config.clone') {
            if (!args.name || RunManager.getInstance(p).allSettings.any { it.name == args.name }) fail('NAME_CONFLICT', 'clone 需要未占用的 --name')
        }
        def candidate = settings.clone()
        candidate.folderName = settings.folderName
        candidate.configuration.beforeRunTasks = settings.configuration.beforeRunTasks.collect { it.clone() }
        def c = candidate.configuration
        if (patch.containsKey('workingDirectory')) c.setWorkingDirectory(patch.workingDirectory ?: '')
        if (patch.containsKey('programArguments')) c.setParams(patch.programArguments ?: '')
        if (patch.containsKey('goToolArguments')) c.setGoToolParams(patch.goToolArguments ?: '')
        if (patch.containsKey('kind')) {
            def kindClass = c.class.classLoader.loadClass('com.goide.execution.GoBuildingRunConfiguration$Kind')
            c.setKind(Enum.valueOf(kindClass, patch.kind.toString()))
        }
        if (patch.containsKey('files')) c.setFilePaths((patch.files ?: []).collect { it.toString() })
        if (patch.containsKey('package')) c.setPackage(patch.package ?: '')
        if (patch.containsKey('directory')) c.setDirectoryPath(patch.directory ?: '')
        if (patch.containsKey('environment') || patch.containsKey('removeEnvironment')) {
            def values = new HashMap(c.customEnvironment)
            (patch.environment ?: [:]).each { k, v -> if (!(v instanceof String)) fail('INVALID_ENVIRONMENT', '环境变量值必须是字符串'); values[k.toString()] = v }
            (patch.removeEnvironment ?: []).each { values.remove(it.toString()) }
            c.setCustomEnvironment(values)
        }
        if (patch.containsKey('inheritEnvironment')) {
            if (!(patch.inheritEnvironment instanceof Boolean)) fail('INVALID_ENVIRONMENT', 'inheritEnvironment 必须是布尔值')
            c.setPassParentEnvironment(patch.inheritEnvironment)
        }
        if (operation == 'config.clone') {
            candidate.name = args.name
            candidate.temporary = false
            candidate.storeInLocalWorkspace()
            candidate.configuration.onConfigurationCopied()
            if (candidate.configuration.metaClass.respondsTo(candidate.configuration, 'clearAutoManagedMetadata')) candidate.configuration.clearAutoManagedMetadata()
        }
        checkConfiguration(candidate)
        if (configRevision(settings) != before.revision) fail('REVISION_CONFLICT', '验证期间配置发生变化')
        record.dispatched = true
        record.mutationOccurred = true
        app.runWriteAction({
            if (operation == 'config.clone') RunManager.getInstance(p).addConfiguration(candidate)
            else {
                def element = new Element('configuration')
                candidate.configuration.writeExternal(element)
                settings.configuration.readExternal(element)
                RunManager.getInstance(p).addConfiguration(settings)
            }
        } as Runnable)
        def targetSettings = operation == 'config.clone' ? candidate : settings
        def expectedRevision = configRevision(targetSettings)
        record.reconcile = {
            if (record.done) return true
            def disk = confirmPersistence(p, targetSettings)
            if (configRevision(targetSettings) == expectedRevision && disk.confirmed) {
                finish([outcome: 'ok', configuration: configInfo(targetSettings), before: before, persistence: disk,
                        saveScope: 'normal IDE project save may include other pending settings'])
                return true
            }
            false
        }
        p.save()
        if (!record.reconcile())
            publish([outcome: 'unknown', code: 'PERSISTENCE_UNCONFIRMED', configuration: configInfo(targetSettings),
                     message: '内存已修改，磁盘保存尚未确认；查询原请求，不重放修改'])
        return
    }
    if (operation == 'run.status') {
        def sessions = runSessions(p)
        if (args.session) sessions = sessions.findAll { it.token == args.session }
        if (args.config) { def settings = selectedConfig(p); sessions = sessions.findAll { it.configurations.any { it.uniqueID == settings.uniqueID } } }
        finish([outcome: 'ok',
                ide: [pid: ProcessHandle.current().pid(), profile: new File(PathManager.configPath).canonicalPath],
                project: [path: new File(p.basePath).canonicalPath, name: p.name],
                sessions: sessions.collect { runInfo(it) },
                pending: registry.busy.values().findAll { it.busyKey?.startsWith(p.basePath + '\n') }.collect { [requestId: it.id, phase: it.phase] }]); return
    }
    if (operation in ['run.start', 'debug.start']) { startRun(p, selectedConfig(p), operation == 'debug.start'); return }
    if (operation in ['run.stop', 'run.restart']) {
        def entry = chooseRun(p)
        if (entry.configurations.size() != 1) fail('CONFIG_AMBIGUOUS', '会话无法唯一关联配置')
        def settings = entry.configurations[0]
        localGo(settings)
        if (operation == 'run.restart') checkConfiguration(settings)
        acquire(configKey(p, settings))
        record.dispatched = true
        ExecutionManagerImpl.stopProcess(entry.descriptor)
        watch {
            if (!entry.handler.processTerminated) return null
            if (operation == 'run.stop') return [outcome: 'ok', state: 'stopped', session: entry.token, exitCode: entry.handler.exitCode]
            // Stop exactly this handler before launching; native restart may stop incompatible sessions.
            record.previousSessionStopped = true
            if (record.restartStartEntered) return [outcome: 'unknown', code: 'RESTART_START_UNCONFIRMED', previousSessionState: 'stopped']
            record.restartStartEntered = true
            startRun(p, settings, false)
            [handoff: true]
        }
        return
    }
    if (operation == 'logs') {
        def entries = runSessions(p)
        def matches = args.session ? entries.findAll { it.token == args.session } : entries.findAll { it.configurations.any { it.name == args.config || it.uniqueID == args.config } }
        if (matches.size() != 1) fail('SESSION_AMBIGUOUS', 'logs 需要唯一 --session，或唯一 --config 会话')
        def entry = matches[0]
        entry.configurations.each { rememberSecrets(it.configuration) }
        def console = consoleObject(entry.descriptor)
        def document = console != null && console.metaClass.respondsTo(console, 'getEditor') ? console.editor?.document : null
        if (document == null) fail('CONSOLE_UNSUPPORTED', '当前控制台类型不支持有界读取；不猜测日志路径')
        def documentState = registry.consoleDocuments[document]
        if (documentState == null) {
            documentState = [id: uuid(), generation: uuid()]
            registry.consoleDocuments[document] = documentState
            document.addDocumentListener([
                documentChanged: { event ->
                    if (event.oldLength != 0 || event.offset != event.document.textLength - event.newLength) documentState.generation = uuid()
                },
            ] as DocumentListener, p)
        }
        int length = document.textLength
        int base = Math.max(0, length - 262144)
        def text = document.getText(new TextRange(base, length))
        def prefix = text
        def gap = false
        if (args.cursor) {
            try {
                def cursor = gson.fromJson(new String(Base64.urlDecoder.decode(args.cursor.toString()), StandardCharsets.UTF_8), Map)
                def offset = cursor.offset as int
                if (cursor.boot != registry.boot || cursor.session != entry.token || cursor.document != documentState.id ||
                        cursor.generation != documentState.generation || offset < base || offset > length) gap = true
                else prefix = text.substring(offset - base)
            } catch (Throwable ignored) { gap = true }
        }
        def lines = prefix.readLines()
        if (args.filter) lines = lines.findAll { it.contains(args.filter.toString()) }
        def limit = Math.min(1000, (args.tail ?: 100) as int)
        def output = lines.takeRight(limit).join('\n').takeRight(65536)
        def cursor = Base64.urlEncoder.withoutPadding().encodeToString(gson.toJson([boot: registry.boot, session: entry.token, document: documentState.id, generation: documentState.generation, offset: length]).getBytes(StandardCharsets.UTF_8))
        finish([outcome: 'ok', session: entry.token, output: output, gap: gap, truncated: base > 0 || lines.size() > limit || prefix.length() > 65536, cursor: cursor, scope: 'retained IDE console tail window'])
        return
    }
    if (operation.startsWith('debug.')) { debugAction(p); return }
    if (operation.startsWith('breakpoint.')) { breakpointAction(p); return }
    fail('UNKNOWN_OPERATION', '未知操作')
}

def refreshPause = { entry ->
    def s = entry.session
    def ctx = s.stopped ? null : s.suspendContext
    if (!s.stopped && s.suspended && ctx != null) {
        if (entry.context == null || !entry.context.is(ctx)) {
            entry.context = ctx
            entry.pause = uuid()
            entry.frames = [:]
            entry.values = [:]
            entry.frameObjects = new IdentityHashMap()
        }
    } else {
        entry.context = null; entry.pause = null; entry.frames = [:]; entry.values = [:]; entry.frameObjects = new IdentityHashMap()
    }
    entry
}
debugEntry = { p, s ->
    def entry = registry.debugs[s]
    if (entry == null) {
        def candidates = RunManager.getInstance(p).allSettings.findAll { it.configuration.is(s.runProfile) }
        if (!candidates) candidates = RunManager.getInstance(p).allSettings.findAll { it.name == s.runProfile.name && it.type.id == s.runProfile.type.id }
        entry = [token: uuid(), project: p.basePath, session: s, settings: candidates.size() == 1 ? candidates[0] : null,
                 frames: [:], values: [:], frameObjects: new IdentityHashMap()]
        registry.debugs[s] = entry
        s.addSessionListener([
            sessionPaused: { -> app.invokeLater({ refreshPause(entry) } as Runnable) },
            sessionResumed: { -> app.invokeLater({ refreshPause(entry) } as Runnable) },
            sessionStopped: { -> app.invokeLater({ refreshPause(entry) } as Runnable) },
        ] as XDebugSessionListener)
    }
    refreshPause(entry)
}
debugInfo = { entry ->
    refreshPause(entry)
    def s = entry.session
    def position = entry.context?.activeExecutionStack?.topFrame?.sourcePosition
    [session: entry.token, configuration: entry.settings?.uniqueID, name: s.sessionName,
     state: s.stopped ? 'stopped' : (s.suspended ? 'paused' : 'running'), pause: entry.pause,
     position: position ? [file: position.file.path, line: position.line + 1] : null]
}
chooseDebug = { p ->
    XDebuggerManager.getInstance(p).debugSessions.each { debugEntry(p, it) }
    def entries = registry.debugs.values().findAll { samePath(it.project, p.basePath) }
    def matches
    if (args.session) matches = entries.findAll { it.token == args.session }
    else if (args.config) {
        def settings = selectedConfig(p)
        matches = entries.findAll { !it.session.stopped && it.settings?.uniqueID == settings.uniqueID }
    } else matches = entries.findAll { !it.session.stopped }
    if (matches.size() != 1) fail('DEBUG_SESSION_AMBIGUOUS', '先 debug list，使用 --session 选择唯一调试会话')
    refreshPause(matches[0])
}
pauseContext = { entry, boolean required ->
    refreshPause(entry)
    if (entry.session.stopped || !entry.pause) fail('NOT_PAUSED', '调试会话未暂停')
    if ((required && !args.pause) || (args.pause && args.pause != entry.pause)) fail('STALE_PAUSE', '暂停标识缺失或已过期，重新查询 debug status')
    [token: entry.pause, context: entry.context]
}
def frameHandle = { entry, frame ->
    def token = entry.frameObjects[frame]
    if (!token) { token = uuid(); entry.frameObjects[frame] = token; entry.frames[token] = frame }
    token
}
selectFrame = { entry, pause ->
    if (args.frame) {
        def frame = entry.frames[args.frame]
        if (frame == null) fail('STALE_FRAME', '栈帧句柄已过期或不属于此暂停')
        return [token: args.frame, frame: frame]
    }
    def frame = pause.context.activeExecutionStack?.topFrame
    if (frame == null) fail('FRAME_UNAVAILABLE', '当前暂停没有可读取的顶层栈帧')
    [token: frameHandle(entry, frame), frame: frame]
}
def stillPaused = { entry, pause ->
    refreshPause(entry)
    !record.done && entry.pause == pause.token && entry.context?.is(pause.context) && now() <= record.deadline
}
def readWatchdog = { entry, pause ->
    def tick
    tick = {
        if (record.done) return
        if (!stillPaused(entry, pause)) {
            finish([outcome: 'failed', code: now() > record.deadline ? 'READ_TIMEOUT' : 'STALE_PAUSE', message: '读取结果已过期或调试状态已改变'])
            return
        }
    }
    record.tick = tick
    publish([outcome: 'pending', code: 'AWAITING_DEBUG_READ'])
}
debugAction = { p ->
    if (operation in ['debug.list', 'debug.status']) {
        XDebuggerManager.getInstance(p).debugSessions.each { debugEntry(p, it) }
        if (operation == 'debug.status' && (args.session || args.config)) finish([outcome: 'ok', debug: debugInfo(chooseDebug(p))])
        else finish([outcome: 'ok', sessions: registry.debugs.values().findAll { samePath(it.project, p.basePath) }.collect { debugInfo(it) }])
        return
    }
    def entry = chooseDebug(p)
    def s = entry.session
    if (operation == 'debug.wait') {
        if (!(args.state in ['paused', 'running', 'stopped'])) fail('INVALID_STATE', 'wait 需要 --state paused|running|stopped')
        watch {
            def info = debugInfo(entry)
            if (info.state == args.state) return [outcome: 'ok', debug: info]
            if (now() > record.deadline) return [outcome: 'blocked', code: 'WAIT_TIMEOUT', debug: info]
            null
        }
        return
    }
    if (operation in ['debug.pause', 'debug.continue', 'debug.step-over', 'debug.stop']) {
        if (s.stopped) fail('SESSION_STOPPED', '此调试会话已终止')
        if (entry.settings == null) fail('CONFIG_AMBIGUOUS', '无法唯一关联调试配置')
        localGo(entry.settings)
        def prior = entry.pending
        def interrupt = operation in ['debug.pause', 'debug.stop']
        if (prior && !prior.done && !interrupt) fail('BUSY', '调试会话有未决请求 ' + prior.id)
        if (operation in ['debug.continue', 'debug.step-over'] || (operation == 'debug.stop' && s.suspended)) pauseContext(entry, true)
        if (operation == 'debug.pause' && s.suspended) { finish([outcome: 'ok', debug: debugInfo(entry)]); return }
        def oldPause = entry.pause
        def key = configKey(p, entry.settings)
        if (prior && !prior.done && interrupt) {
            prior.interruptedBy = record.id
            prior.busyKey = null
            registry.busy[key] = record
            record.busyKey = key
        } else acquire(key)
        entry.pending = record
        record.dispatched = true
        if (operation == 'debug.pause') s.pause()
        else if (operation == 'debug.stop') s.stop()
        else if (operation == 'debug.continue') s.resume()
        else s.stepOver(false)
        watch {
            def info = debugInfo(entry)
            if (record.interruptedBy && (info.state == 'paused' || info.state == 'stopped'))
                return [outcome: 'failed', code: 'INTERRUPTED', interruptedBy: record.interruptedBy, debug: info]
            if (operation == 'debug.stop') {
                def handler = s.debugProcess.processHandler
                if (s.stopped && handler != null && handler.processTerminated) return [outcome: 'ok', debug: info]
                return null
            }
            if (operation == 'debug.pause' && info.state == 'paused') return [outcome: 'ok', debug: info]
            if (operation == 'debug.pause' && info.state == 'stopped') return [outcome: 'failed', code: 'SESSION_TERMINATED', message: '程序在暂停完成前已退出', debug: info]
            if (operation == 'debug.continue' && (info.state != 'paused' || info.pause != oldPause)) return [outcome: 'ok', debug: info]
            if (operation == 'debug.step-over' && (info.state == 'stopped' || (info.state == 'paused' && info.pause != oldPause))) return [outcome: 'ok', debug: info]
            null
        }
        return
    }
    def pause = pauseContext(entry, false)
    readWatchdog(entry, pause)
    def callbackError = { String message -> if (!record.done) finish([outcome: 'failed', code: 'DEBUG_READ_FAILED', message: message]) }
    if (operation == 'debug.stack') {
        def frames = new ConcurrentLinkedQueue()
        pause.context.activeExecutionStack.computeStackFrames(0, [
            isObsolete: { -> !stillPaused(entry, pause) },
            errorOccurred: { String message -> callbackError(message) },
            addStackFrames: { List batch, boolean last ->
                try {
                    if (!stillPaused(entry, pause)) { callbackError('暂停已改变'); return }
                    batch.take(Math.max(0, (args.limit as int) - frames.size())).each { f ->
                        def pos = f.sourcePosition
                        frames.add([frame: frameHandle(entry, f), file: pos?.file?.path, line: pos ? pos.line + 1 : null])
                    }
                    if (last || frames.size() >= (args.limit as int)) finish([outcome: 'ok', session: entry.token, pause: pause.token, frames: frames.toList(), truncated: !last])
                } catch (Throwable t) { callbackError(t.toString()) }
            },
        ] as XExecutionStack.XStackFrameContainer)
        return
    }
    def frame = selectFrame(entry, pause)
    def render = { String name, XValue value, Closure completed ->
        def sent = new AtomicBoolean(false)
        value.computePresentation([
            isObsolete: { -> !stillPaused(entry, pause) },
            setPresentation: { Object... a ->
                try {
                    if (!stillPaused(entry, pause) || !sent.compareAndSet(false, true)) return
                    def text = a.length == 4 ? a[2] : XValuePresentationUtil.computeValueText(a[1])
                    def type = a.length == 4 ? a[1] : a[1].type
                    def token = uuid()
                    entry.values[token] = [object: value, frame: frame.token]
                    completed([name: name, type: type, value: text?.toString()?.take(4096), valueHandle: token,
                               truncated: text != null && text.toString().length() > 4096])
                } catch (Throwable t) { callbackError(t.toString()) }
            },
            setFullValueEvaluator: { ignored -> },
        ] as XValueNode, XValuePlace.TREE)
    }
    if (operation == 'debug.eval') {
        if (!(args.expression instanceof String) || !(args.expression ==~ /[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/))
            fail('UNSAFE_EXPRESSION', '仅接受变量和字段访问链')
        def evaluator = frame.frame.evaluator
        if (evaluator == null) fail('EVALUATOR_UNAVAILABLE', '此栈帧没有表达式求值器')
        evaluator.evaluate(args.expression, [
            errorOccurred: { String message -> callbackError(message) },
            evaluated: { XValue value ->
                try { render(args.expression, value) { item -> finish([outcome: 'ok', session: entry.token, pause: pause.token, frame: frame.token, result: item]) } }
                catch (Throwable t) { callbackError(t.toString()) }
            },
        ] as XDebuggerEvaluator.XEvaluationCallback, frame.frame.sourcePosition)
        return
    }
    if (operation == 'debug.variables') {
        def container = frame.frame
        if (args.value) {
            def value = entry.values[args.value]
            if (!value || value.frame != frame.token) fail('STALE_VALUE', '变量句柄不属于此栈帧或已过期')
            container = value.object
        }
        def rows = new ConcurrentLinkedQueue()
        def pending = new AtomicInteger(1)
        def enumerationFinished = new AtomicBoolean(false)
        def truncated = new AtomicBoolean(false)
        def endOne = {
            if (pending.decrementAndGet() == 0 && stillPaused(entry, pause))
                finish([outcome: 'ok', session: entry.token, pause: pause.token, frame: frame.token, variables: rows.toList(), truncated: truncated.get()])
        }
        def addValue = { String name, XValue value ->
            if (rows.size() + pending.get() > (args.limit as int)) { truncated.set(true); return }
            pending.incrementAndGet()
            render(name, value) { row -> rows.add(row); endOne() }
        }
        container.computeChildren([
            isObsolete: { -> !stillPaused(entry, pause) },
            addChildren: { XValueChildrenList list, boolean last ->
                try {
                    if (!stillPaused(entry, pause)) return
                    for (int i = 0; i < list.size(); i++) addValue(list.getName(i), list.getValue(i))
                    list.topValues.each { addValue(it.name, it) }
                    (list.topGroups + list.bottomGroups).each { group ->
                        if (rows.size() >= (args.limit as int)) { truncated.set(true); return }
                        def token = uuid()
                        entry.values[token] = [object: group, frame: frame.token]
                        rows.add([name: group.name, type: 'group', valueHandle: token])
                    }
                    if (last && enumerationFinished.compareAndSet(false, true)) endOne()
                } catch (Throwable t) { callbackError(t.toString()) }
            },
            tooManyChildren: { Object... ignored -> truncated.set(true); if (enumerationFinished.compareAndSet(false, true)) endOne() },
            setAlreadySorted: { boolean ignored -> },
            setErrorMessage: { Object... a -> callbackError(a[0].toString()) },
            setMessage: { Object... ignored -> },
        ] as XCompositeNode)
        return
    }
    fail('UNKNOWN_OPERATION', '未知调试操作')
}

def breakpointState = { bp ->
    def pos = bp.sourcePosition
    def properties = bp.properties?.getState()
    [file: pos?.file?.canonicalPath, line: pos ? pos.line + 1 : null, type: bp.type.id, enabled: bp.enabled,
     condition: bp.conditionExpression?.expression, suspend: bp.suspendPolicy.toString(), log: bp.logExpressionObject?.expression,
     logMessage: bp.logMessage, logStack: bp.logStack, group: callIf(bp, 'getGroup', null),
     properties: properties instanceof Element ? JDOMUtil.writeElement(properties) : gson.toJson(properties)]
}
def breakpointRevision = { bp -> sha(gson.toJson(breakpointState(bp))) }
def ledgerDirectory = new File(req.dataRoot, 'breakpoints/' + req.targetId)
def readLedger = { String id ->
    if (!(id ==~ /[a-f0-9-]{36}/)) return null
    def file = new File(ledgerDirectory, id + '.json')
    file.isFile() ? gson.fromJson(file.getText('UTF-8'), Map) : null
}
def saveLedger = { Map item -> atomic(new File(ledgerDirectory, item.id + '.json'), item) }
def ownedMarker = { bp ->
    def group = callIf(bp, 'getGroup', '') ?: ''
    group.startsWith('yjx-goland-ops/') ? group.substring('yjx-goland-ops/'.length()) : null
}
breakpointInfo = { bp ->
    def id = ownedMarker(bp)
    if (!id) {
        def entry = registry.breakpoints[bp]
        if (!entry) { entry = uuid(); registry.breakpoints[bp] = entry }
        id = entry
    }
    def pos = bp.sourcePosition
    [breakpoint: id, owned: ownedMarker(bp) != null, type: bp.type.id, file: pos?.file?.path,
     line: pos ? pos.line + 1 : null, enabled: bp.enabled, revision: breakpointRevision(bp)]
}
def checkBreakpointScope = { p ->
    def live = XDebuggerManager.getInstance(p).debugSessions.findAll { !it.stopped }.collect { debugEntry(p, it) }
    def targeted = args.session ? live.findAll { it.token == args.session } :
        (args.config ? live.findAll { it.settings?.name == args.config || it.settings?.uniqueID == args.config } : [])
    if (targeted.size() > 1 && !args.allowOtherSessions) fail('DEBUG_SESSION_AMBIGUOUS', '同配置有多个调试会话，需唯一 --session 或明确授权项目级影响')
    def others = live.findAll { !targeted.contains(it) }
    if (others && !args.allowOtherSessions) fail('BREAKPOINT_PROJECT_CONFLICT', '项目级断点可能影响其他调试会话；未获对应范围授权')
}
breakpointAction = { p ->
    def manager = XDebuggerManager.getInstance(p).breakpointManager
    if (operation == 'breakpoint.list') { finish([outcome: 'ok', breakpoints: manager.allBreakpoints.collect { breakpointInfo(it) }]); return }
    if (!(args.task instanceof String) || !(args.task ==~ /[A-Za-z0-9_.-]{1,80}/)) fail('TASK_REQUIRED', '修改断点需要 --task，使用字母数字及 ._-')
    acquire(p.basePath + '\nbreakpoints')
    checkBreakpointScope(p)
    if (operation == 'breakpoint.cleanup') {
        def outstanding = registry.busy.values().findAll { !it.is(record) && it.busyKey?.startsWith(p.basePath + '\n') }
        if (outstanding) fail('BUSY', '项目有未决控制请求，不能将超时视为任务结束')
        def results = []
        (ledgerDirectory.listFiles() ?: []).findAll { it.name.endsWith('.json') }.each { file ->
            def ledger = gson.fromJson(file.getText('UTF-8'), Map)
            if (!samePath(ledger.project, p.basePath) || !(ledger.tasks ?: []).contains(args.task)) return
            def bp = manager.allBreakpoints.find { ownedMarker(it) == ledger.id }
            if (!bp) { ledger.tasks.remove(args.task); ledger.state = 'absent'; saveLedger(ledger); results.add([breakpoint: ledger.id, state: 'absent']); return }
            if (ledger.state != 'created' || breakpointRevision(bp) != ledger.revision) {
                results.add([breakpoint: ledger.id, state: 'conflict']); return
            }
            ledger.tasks.remove(args.task)
            if (ledger.tasks) { saveLedger(ledger); results.add([breakpoint: ledger.id, state: 'retained-for-other-task']); return }
            app.runWriteAction({ manager.removeBreakpoint(bp) } as Runnable)
            ledger.state = 'removed'; saveLedger(ledger); results.add([breakpoint: ledger.id, state: 'removed'])
        }
        p.save()
        finish([outcome: results.any { it.state == 'conflict' } ? 'blocked' : 'ok', breakpoints: results]); return
    }
    if (operation == 'breakpoint.set') {
        if (!args.file || !args.line) fail('SOURCE_REQUIRED', 'set 需要 --file 和1起始 --line')
        def source = new File(p.basePath, args.file.toString()).canonicalFile
        def projectPath = new File(p.basePath).canonicalFile.toPath()
        if (!source.toPath().startsWith(projectPath)) fail('SOURCE_OUTSIDE_PROJECT', '断点源文件必须位于项目内')
        def vf = LocalFileSystem.getInstance().refreshAndFindFileByPath(source.path.replace('\\', '/'))
        if (vf == null) fail('SOURCE_NOT_FOUND', '源文件不存在')
        int line = (args.line as int) - 1
        def types = XDebuggerUtil.getInstance().lineBreakpointTypes.findAll { it.id == 'DlvLineBreakpoint' && it.canPutAt(vf, line, p) }
        if (types.size() != 1) fail('BREAKPOINT_UNSUPPORTED', '此位置无法创建 Go 行断点')
        def existing = manager.findBreakpointsAtLine(types[0], vf, line).toList()
        if (existing.size() > 1) fail('BREAKPOINT_AMBIGUOUS', '同位置存在多个断点')
        if (existing) {
            def bp = existing[0]
            def marker = ownedMarker(bp)
            def ledger = marker ? readLedger(marker) : null
            if (ledger && ledger.state == 'created' && ledger.revision == breakpointRevision(bp)) {
                if (!ledger.tasks.contains(args.task)) ledger.tasks.add(args.task)
                saveLedger(ledger)
            }
            finish([outcome: 'ok', reused: true, breakpoint: breakpointInfo(bp)]); return
        }
        def id = uuid()
        def ledger = [id: id, taskOwner: args.task, tasks: [args.task], project: p.basePath,
                      file: source.path, line: line + 1, type: types[0].id, state: 'creating', requestId: record.id]
        saveLedger(ledger)
        def bp
        record.dispatched = true
        app.runWriteAction({
            bp = manager.addLineBreakpoint(types[0], vf.url, line, types[0].createBreakpointProperties(vf, line))
            bp.setGroup('yjx-goland-ops/' + id)
        } as Runnable)
        ledger.revision = breakpointRevision(bp)
        ledger.state = 'created'
        saveLedger(ledger)
        p.save()
        finish([outcome: 'ok', breakpoint: breakpointInfo(bp)]); return
    }
    def matches = manager.allBreakpoints.findAll { breakpointInfo(it).breakpoint == args.breakpoint }
    if (matches.size() != 1) fail('BREAKPOINT_NOT_FOUND', '断点句柄不存在或已失效')
    def bp = matches[0]
    if (!args.revision || args.revision != breakpointRevision(bp)) fail('REVISION_CONFLICT', '断点已变化或缺少 --revision')
    def marker = ownedMarker(bp)
    def ledger = marker ? readLedger(marker) : null
    if (!marker && args.allowUserBreakpoint) {
        record.dispatched = true
        app.runWriteAction({
            if (operation == 'breakpoint.remove') manager.removeBreakpoint(bp)
            else if (operation == 'breakpoint.enable') bp.enabled = true
            else if (operation == 'breakpoint.disable') bp.enabled = false
            else fail('UNKNOWN_OPERATION', '未知断点操作')
        } as Runnable)
        p.save()
        finish([outcome: 'ok', explicitlyEditedUserBreakpoint: true,
                breakpoint: operation == 'breakpoint.remove' ? [breakpoint: args.breakpoint, state: 'removed', owned: false] : breakpointInfo(bp)])
        return
    }
    if (!ledger || !ledger.tasks.contains(args.task) || ledger.tasks.size() != 1)
        fail('BREAKPOINT_NOT_EXCLUSIVE', '不是当前任务独占的临时断点；用户明确要求修改既有断点时使用 --allow-user-breakpoint')
    if (ledger.state != 'created' || ledger.revision != breakpointRevision(bp))
        fail('BREAKPOINT_CHANGED_EXTERNALLY', '断点自登记后已被修改，不能重新认领为临时断点')
    record.dispatched = true
    app.runWriteAction({
        if (operation == 'breakpoint.remove') manager.removeBreakpoint(bp)
        else if (operation == 'breakpoint.enable') bp.enabled = true
        else if (operation == 'breakpoint.disable') bp.enabled = false
        else fail('UNKNOWN_OPERATION', '未知断点操作')
    } as Runnable)
    ledger.state = operation == 'breakpoint.remove' ? 'removed' : 'created'
    if (ledger.state == 'created') ledger.revision = breakpointRevision(bp)
    saveLedger(ledger)
    p.save()
    finish([outcome: 'ok', breakpoint: ledger.state == 'removed' ? [breakpoint: marker, state: 'removed'] : breakpointInfo(bp)])
}

def run = {
    try {
        record.modality = com.intellij.openapi.application.ModalityState.current()
        execute()
    }
    catch (Throwable t) { failRequest(t) }
}
if (operation in ['doctor', 'project.list', 'project.probe'])
    app.invokeLater(run as Runnable, com.intellij.openapi.application.ModalityState.any())
else {
    if (java.awt.Window.windows.any { it.visible && it instanceof javax.swing.JDialog && it.modal })
        finish([outcome: 'blocked', code: 'IDE_MODAL_DIALOG', message: '目标 IDE 存在模态对话框，未派发动作；先 doctor 检查'])
    else app.invokeLater(run as Runnable)
}
