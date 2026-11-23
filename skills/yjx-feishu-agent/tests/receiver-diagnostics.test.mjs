import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { receiverDiagnosis, windowsDiagnostics } from '../scripts/receiver-diagnostics.mjs';
import { receiverPaths } from '../scripts/receiver-runtime.mjs';

const execute = promisify(execFile);
const input = { taskName: 'yjx-feishu-agent-00000000000000000000', receiverPid: null, observedAt: '2026-11-23T01:00:00.000Z' };

test('diagnosis reads damaged state without recovering locks or exposing private payloads', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'yjx-diagnose-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = receiverPaths('cli_fixture', home);
  await mkdir(paths.lock, { recursive: true });
  await mkdir(paths.runtime, { recursive: true });
  const files = new Map([
    [path.join(paths.lock, 'owner.json'), 'private-corrupt-owner'],
    [path.join(paths.runtime, 'status.json'), JSON.stringify({ connection: 'stopped', failure: { message: 'private-error' } })],
    [path.join(paths.runtime, 'recovery.json'), 'private-corrupt-policy'],
    [path.join(paths.runtime, 'last-failure.json'), JSON.stringify({ pid: 1, code: 'RUNTIME_FAILURE', systemCode: 'EPERM', stage: 'serve_exit', message: 'private-sdk-body' })],
  ]);
  for (const [file, value] of files) await writeFile(file, value);
  const names = await readdir(paths.runtime);
  const result = await receiverDiagnosis('cli_fixture', path.join(home, 'state'), { home, platform: 'linux' });
  assert.equal(result.receiver.state, 'incomplete_lock');
  assert.equal(result.recovery.state, 'unreadable');
  assert.equal(result.lastFailure.systemCode, 'EPERM');
  assert.doesNotMatch(JSON.stringify(result), /private-/);
  for (const [file, value] of files) assert.equal(await readFile(file, 'utf8'), value);
  assert.deepEqual(await readdir(paths.runtime), names);
});

test('Windows bridge reports protocol and transport failures without stderr or command payloads', async () => {
  for (const output of ['not-json-private-payload', '{}', 'null']) {
    const result = await windowsDiagnostics(input, { run: async () => ({ stdout: output }) });
    assert.equal(result.state, 'query_failed');
    assert.equal(result.task.reason, 'invalid_response');
    assert.doesNotMatch(JSON.stringify(result), /private/);
  }
  let attempts = 0;
  const result = await windowsDiagnostics(input, { run: async (_exe, args, options) => {
    attempts += 1;
    assert.equal(args.includes('-EncodedCommand'), true);
    const { section, ...request } = JSON.parse(options.env.YJX_RECEIVER_DIAG_INPUT);
    assert.deepEqual(request, input);
    assert.equal(['task', 'process', 'taskHistory', 'systemHistory'].includes(section), true);
    assert.equal(options.windowsHide, true);
    throw Object.assign(new Error('private-command'), { killed: true, stdout: 'private-token', stderr: 'private-secret' });
  } });
  assert.equal(attempts, 4);
  assert.equal(result.task.timedOut, true);
  assert.equal(result.task.reason, 'os_query_failed');
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('one Windows query timing out preserves other task and event evidence', async () => {
  const result = await windowsDiagnostics(input, { run: async (_exe, _args, options) => {
    const { section } = JSON.parse(options.env.YJX_RECEIVER_DIAG_INPUT);
    if (section === 'process') throw Object.assign(new Error('private-CIM-error'), { killed: true });
    const value = section === 'task' ? { state: 'available', restart: { count: 3, interval: 'PT1M' } }
      : { state: section === 'taskHistory' ? 'disabled' : 'no_records' };
    return { stdout: JSON.stringify({ protocolVersion: 1, section, value }) };
  } });
  assert.equal(result.state, 'partial');
  assert.deepEqual(result.task.restart, { count: 3, interval: 'PT1M' });
  assert.equal(result.process.timedOut, true);
  assert.equal(result.taskHistory.state, 'disabled');
  assert.equal(result.systemHistory.state, 'no_records');
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

async function powershell(body) {
  const source = fileURLToPath(new URL('../scripts/receiver-diagnostics.ps1', import.meta.url)).replaceAll("'", "''");
  const script = `. '${source}'\n${body}`;
  const { stdout } = await execute(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 20000, env: { ...process.env, YJX_RECEIVER_DIAG_INPUT: JSON.stringify(input) } });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}

test('event adapter distinguishes disabled, no matching events and denied queries', { skip: process.platform !== 'win32' }, async () => {
  const results = await powershell(`
    $script:mode = 'disabled'
    function Get-WinEvent {
      param($ListLog, $FilterXml, $MaxEvents, $ErrorAction)
      if ($ListLog) { return [pscustomobject]@{ IsEnabled = $script:mode -ne 'disabled' } }
      if ($script:mode -eq 'empty') {
        $record = New-Object System.Management.Automation.ErrorRecord ([Exception]'private-message'), 'NoMatchingEventsFound', 'ObjectNotFound', $null
        throw $record
      }
      throw [UnauthorizedAccessException]'private-access-error'
    }
    $results = @()
    foreach ($modeValue in @('disabled', 'empty', 'denied')) {
      $script:mode = $modeValue
      $results += EventEvidence 'Microsoft-Windows-TaskScheduler/Operational' 30 $true
    }
    $results | ConvertTo-Json -Depth 10 -Compress
  `);
  assert.deepEqual(results.map(result => result.state), ['disabled', 'no_records', 'query_failed']);
  assert.equal(results[2].errorCode, '0x80070005');
  assert.doesNotMatch(JSON.stringify(results), /private/);
});

test('event adapter bounds output and strips raw event and action payloads', { skip: process.platform !== 'win32' }, async () => {
  const result = await powershell(`
    function Get-WinEvent {
      param($ListLog, $FilterXml, $MaxEvents, $ErrorAction)
      if ($ListLog) { return [pscustomobject]@{ IsEnabled = $true } }
      if ($MaxEvents -ne 31) { throw 'unbounded event query' }
      foreach ($n in 1..31) {
        $record = [pscustomobject]@{ Id = 201; RecordId = $n; TimeCreated = [DateTime]'2026-11-22'; Message = 'private-message' }
        $record | Add-Member ScriptMethod ToXml { '<Event><EventData><Data Name="ProcessId">123</Data><Data Name="ResultCode">0</Data><Data Name="ActionName">private-arguments</Data></EventData></Event>' }
        $record
      }
    }
    EventEvidence 'Microsoft-Windows-TaskScheduler/Operational' 30 $true | ConvertTo-Json -Depth 10 -Compress
  `);
  assert.equal(result.state, 'available');
  assert.equal(result.events.length, 30);
  assert.equal(result.truncated, true);
  assert.equal(result.events[0].data.ProcessId, 123);
  assert.equal(result.events[0].data.ResultCode, 0);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});
