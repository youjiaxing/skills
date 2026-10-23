#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultStateDir } from './codex.mjs';
import { loadCredentials } from './feishu-credentials.mjs';
import { receiverPaths, receiverStatus, recoverReceiverLock, readJson, atomicJson, processAlive } from './receiver-runtime.mjs';
import { withReceiverControl, recoveryEnabled, setRecovery, ensureReceiver, recordRuntimeFailure } from './receiver-recovery.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./feishu.mjs', import.meta.url));
const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const unxml = (value) => value.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

export function windowsArgument(value) {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

export function taskDefinition({ sid, node, args, cwd }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>yjx-feishu-agent receiver; starts when the current user logs on</Description></RegistrationInfo>
  <Principals><Principal id="CurrentUser"><UserId>${xml(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(sid)}</UserId></LogonTrigger></Triggers>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
  <Actions Context="CurrentUser"><Exec><Command>${xml(node)}</Command><Arguments>${xml(args)}</Arguments><WorkingDirectory>${xml(cwd)}</WorkingDirectory></Exec></Actions>
</Task>`;
}

export function legacyTaskDefinition({ sid, node, args, cwd }) {
  return taskDefinition({ sid, node, args, cwd })
    .replace('<RegistrationInfo><Description>yjx-feishu-agent receiver; starts when the current user logs on</Description></RegistrationInfo>', '<RegistrationInfo><Description>yjx-feishu-agent receiver; manual start, no automatic trigger</Description></RegistrationInfo>')
    .replace(`<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(sid)}</UserId></LogonTrigger></Triggers>`, '');
}

export function previousTaskDefinition({ sid, node, args, cwd }) {
  return taskDefinition({ sid, node, args, cwd })
    .replace('<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>', '');
}

export function watchdogDefinition(options) {
  return taskDefinition(options)
    .replace(/<Triggers>[\s\S]*?<\/Triggers>/, '<Triggers><TimeTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>');
}

export function matchesTask(definition, expected, { logonUser } = {}) {
  // Task Scheduler reorders and indents RestartOnFailure children on export.
  const restart = text => {
    const block=text.match(/<RestartOnFailure>([\s\S]*?)<\/RestartOnFailure>/)?.[1];
    if (block===undefined) return null;
    return ['Interval','Count'].map(tag=>block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]);
  };
  if (JSON.stringify(restart(definition))!==JSON.stringify(restart(expected))) return false;
  const triggerActual = definition.match(/<Triggers>[\s\S]*?<\/Triggers>/)?.[0] ?? '';
  const triggerExpected = expected.match(/<Triggers>[\s\S]*?<\/Triggers>/)?.[0] ?? '';
  const timeSignature = value => {
    let body = value.match(/^<Triggers>\s*<TimeTrigger>([\s\S]*?)<\/TimeTrigger>\s*<\/Triggers>$/)?.[1];
    if (body === undefined) return null;
    const repetition = body.match(/<Repetition>([\s\S]*?)<\/Repetition>/)?.[1];
    if (repetition === undefined) return null;
    body = body.replace(/<Repetition>[\s\S]*?<\/Repetition>/, '');
    const fields = (source, keys) => {
      const result = {};
      for (const [key, fallback] of keys) {
        const matches = [...source.matchAll(new RegExp(`<${key}>([^<]*)</${key}>`, 'g'))];
        if (matches.length > 1) return null;
        result[key] = matches[0]?.[1] ?? fallback;
        source = source.replace(new RegExp(`<${key}>[^<]*</${key}>`, 'g'), '');
      }
      return source.trim() ? null : result;
    };
    const trigger = fields(body, [['StartBoundary', null], ['Enabled', 'true']]);
    const repeat = fields(repetition, [['Interval', null], ['StopAtDurationEnd', 'false']]);
    return trigger && repeat ? { ...trigger, ...repeat } : null;
  };
  if (/<TimeTrigger>/.test(triggerExpected)) {
    const actual = timeSignature(triggerActual);
    if (!actual || JSON.stringify(actual) !== JSON.stringify(timeSignature(triggerExpected))) return false;
  }
  if (!/<TimeTrigger>/.test(triggerExpected) && /<TimeTrigger>|<CalendarTrigger>|<EventTrigger>/.test(triggerActual)) return false;
  const expectedHasLogon = /<LogonTrigger>/.test(triggerExpected);
  const actualHasLogon = /<LogonTrigger>/.test(triggerActual);
  if (expectedHasLogon !== actualHasLogon) return false;
  if (!expectedHasLogon && !/<TimeTrigger>/.test(triggerExpected) &&
      triggerActual.replace(/<\/?Triggers>/g, '').trim()) return false;
  if (expectedHasLogon) {
    const logon = triggerActual.match(/^<Triggers>\s*<LogonTrigger>([\s\S]*?)<\/LogonTrigger>\s*<\/Triggers>$/)?.[1];
    if (!logon || (logon.match(/<UserId>/g) ?? []).length !== 1 || (logon.match(/<Enabled>/g) ?? []).length > 1) return false;
    const user = unxml(logon.match(/<UserId>([^<]+)<\/UserId>/)?.[1] ?? '');
    const wanted = unxml(triggerExpected.match(/<UserId>([^<]+)<\/UserId>/)?.[1] ?? '');
    if (user !== wanted && (!logonUser || user.toLowerCase() !== logonUser.toLowerCase())) return false;
    if ((logon.match(/<Enabled>([^<]*)<\/Enabled>/)?.[1] ?? 'true') !== 'true') return false;
    if (logon.replace(/<UserId>[^<]+<\/UserId>|<Enabled>[^<]*<\/Enabled>/g, '').trim()) return false;
  }
  definition = definition.replace(/<Triggers>[\s\S]*?<\/Triggers>/, '<Triggers />');
  expected = expected.replace(/<Triggers>[\s\S]*?<\/Triggers>/, '<Triggers />');
  const fields = ['UserId', 'LogonType', 'RunLevel', 'Command', 'Arguments', 'WorkingDirectory',
    'MultipleInstancesPolicy', 'DisallowStartIfOnBatteries', 'StopIfGoingOnBatteries',
    'AllowHardTerminate', 'AllowStartOnDemand', 'Enabled', 'ExecutionTimeLimit'];
  if ((definition.match(/<Exec>/g) ?? []).length !== 1) return false;
  if ((definition.match(/<Actions\b/g) ?? []).length !== 1) return false;
  const actions = definition.match(/<Actions\b[^>]*>([\s\S]*?)<\/Actions>/)?.[1];
  if (actions === undefined || actions.replace(/<Exec>[\s\S]*?<\/Exec>/, '').trim()) return false;
  if (/<ComHandler[\s/>]/.test(definition)) return false;
  // Windows omits these default-valued elements when exporting registered XML.
  // Other settings (notably battery behavior and PT0S) must remain explicit.
  const defaults = { RunLevel: 'LeastPrivilege', AllowStartOnDemand: 'true', Enabled: 'true' };
  return fields.every((tag) => {
    const actual = definition.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? defaults[tag];
    const wanted = expected.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];
    if (actual === undefined && wanted === undefined) return true;
    return actual !== undefined && wanted !== undefined && unxml(actual) === unxml(wanted);
  });
}

async function startWindows(paths, stateDir, { installWatchdog = true } = {}) {
  const { stdout: identity } = await execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = identity.match(/S-1-5-\d+(?:-\d+)+/)?.[0];
  const logonUser = identity.match(/^\s*"([^"]+)"/)?.[1];
  if (!sid) throw new Error('Cannot determine current Windows user SID');
  const oldArgs = [script, 'serve', '--state-dir', stateDir].map(windowsArgument).join(' ');
  const args = [script, 'serve', '--managed', '--state-dir', stateDir].map(windowsArgument).join(' ');
  const expected = taskDefinition({ sid, node: process.execPath, args, cwd: path.dirname(script) });
  const specFile = path.join(paths.runtime, 'task.xml');
  const installation = path.join(paths.runtime, 'task-registration.json');
  const known = await readJson(installation);
  if (known) {
    if (known.stateDir !== stateDir) throw new Error('Task belongs to another state directory');
    const result = await execute('schtasks.exe', ['/Query', '/TN', paths.taskName, '/XML'], { windowsHide: true, encoding: 'buffer' });
    const buffer = result.stdout;
    const registered = (buffer[0] === 0xff && buffer[1] === 0xfe) || buffer[1] === 0 ? buffer.toString('utf16le') : buffer.toString('utf8');
    if (!matchesTask(registered, expected, { logonUser })) {
      const oldOptions = { sid, node: process.execPath, args: oldArgs, cwd: path.dirname(script) };
      const historical = [taskDefinition(oldOptions), previousTaskDefinition(oldOptions), legacyTaskDefinition(oldOptions)];
      if (!historical.some(definition => matchesTask(registered, definition, { logonUser }))) throw new Error('Registered task differs; refusing to run or replace it');
      await writeFile(specFile, Buffer.from(`\ufeff${expected}`, 'utf16le'), { mode: 0o600 });
      await execute('schtasks.exe', ['/Create', '/TN', paths.taskName, '/XML', specFile, '/F'], { windowsHide: true });
    }
  } else {
    await writeFile(specFile, Buffer.from(`\ufeff${expected}`, 'utf16le'), { mode: 0o600 });
    // No /F: never silently overwrite a task we have not registered.
    await execute('schtasks.exe', ['/Create', '/TN', paths.taskName, '/XML', specFile], { windowsHide: true });
    await atomicJson(installation, { stateDir, taskName: paths.taskName });
  }
  if (installWatchdog) await installWindowsWatchdog(paths, stateDir, sid);
  const verified = await execute('schtasks.exe', ['/Query', '/TN', paths.taskName, '/XML'], { windowsHide: true, encoding: 'buffer' });
  if (!matchesTask(decodeTask(verified.stdout), expected, { logonUser })) throw new Error('Receiver task read-back differs');
  await execute('schtasks.exe', ['/Run', '/TN', paths.taskName], { windowsHide: true });
}

function decodeTask(buffer) {
  return (buffer[0] === 0xff && buffer[1] === 0xfe) || buffer[1] === 0 ? buffer.toString('utf16le') : buffer.toString('utf8');
}

async function installWindowsWatchdog(paths, stateDir, sid) {
  const taskName = `${paths.taskName}-watchdog`;
  const installation = path.join(paths.runtime, 'watchdog-registration.json');
  const args = [fileURLToPath(import.meta.url), 'ensure', '--state-dir', stateDir].map(windowsArgument).join(' ');
  const expected = watchdogDefinition({ sid, node: process.execPath, args, cwd: path.dirname(script) });
  const known = await readJson(installation);
  if (known) {
    if (known.stateDir !== stateDir || known.taskName !== taskName) throw new Error('Watchdog belongs to another installation');
    const existing = await execute('schtasks.exe', ['/Query', '/TN', taskName, '/XML'], { windowsHide: true, encoding: 'buffer' });
    if (!matchesTask(decodeTask(existing.stdout), expected)) throw new Error('Watchdog task differs; refusing replacement');
  } else {
    const definition = path.join(paths.runtime, 'watchdog.xml');
    await writeFile(definition, Buffer.from(`\ufeff${expected}`, 'utf16le'), { mode: 0o600 });
    await execute('schtasks.exe', ['/Create', '/TN', taskName, '/XML', definition], { windowsHide: true });
    await atomicJson(installation, { stateDir, taskName });
  }
  const verified = await execute('schtasks.exe', ['/Query', '/TN', taskName, '/XML'], { windowsHide: true, encoding: 'buffer' });
  if (!matchesTask(decodeTask(verified.stdout), expected)) throw new Error('Watchdog task read-back differs');
}

async function startPosix(paths, stateDir) {
  const log = await open(path.join(paths.runtime, 'receiver.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [script, 'serve', '--managed', '--state-dir', stateDir], {
      detached: true, stdio: ['ignore', log.fd, log.fd], cwd: path.dirname(script), shell: false,
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
}

export async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help') {
    process.stdout.write('Usage: node receiver.mjs start|stop|status|recover-lock|ensure [--state-dir PATH]\nWindows: current-user logon task plus a one-minute recovery watchdog. stop disables managed auto-start until start.\nmacOS/Linux: detached Node process; ensure is a one-shot recovery check, no scheduler installed.\nrecover-lock is explicit and only removes a receiver lock whose PID is confirmed absent.\n');
    return;
  }
  if (!['start', 'stop', 'status', 'recover-lock', 'ensure'].includes(command) ||
      (rest.length && (rest.length !== 2 || rest[0] !== '--state-dir' || !rest[1]))) throw new Error('Invalid arguments');
  const stateDir = path.resolve(rest[1] ?? defaultStateDir());
  const { appId } = await loadCredentials(stateDir);
  const paths = receiverPaths(appId);
  const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const status = await receiverStatus(appId);
  if (command === 'status') {
    print({ ...status, recovery: { enabled: await recoveryEnabled(paths, stateDir),
      watchdog: await readJson(path.join(paths.runtime, 'watchdog-status.json')),
      lastFailure: await readJson(path.join(paths.runtime, 'last-failure.json')) } });
    return;
  }
  if (command === 'recover-lock') {
    print({ recovered: await recoverReceiverLock(appId), ...await receiverStatus(appId) });
    return;
  }
  if (command === 'ensure') {
    try {
      const result = await withReceiverControl(paths, async () => ensureReceiver({
        enabled: await recoveryEnabled(paths, stateDir), status: await receiverStatus(appId),
        start: () => process.platform === 'win32' ? startWindows(paths, stateDir, { installWatchdog: false }) : startPosix(paths, stateDir),
      }));
      await atomicJson(path.join(paths.runtime, 'watchdog-status.json'), { ...result, checkedAt: new Date().toISOString() });
      print(result);
      if (result.recovery === 'blocked') process.exitCode = 2;
    } catch (error) { await recordRuntimeFailure(paths, error, 'watchdog'); throw error; }
    return;
  }
  if (command === 'stop') {
    const owner = await withReceiverControl(paths, async () => {
      await setRecovery(paths, stateDir, false);
      const current = await receiverStatus(appId);
      if (current.state === 'stopped' || current.state === 'stale_lock') return null;
      if (current.state !== 'running') throw new Error('Receiver identity is not confirmed; recovery disabled, inspect before stopping');
      const currentOwner = await readJson(path.join(paths.lock, 'owner.json'));
      await atomicJson(path.join(paths.runtime, 'stop.json'), { pid: currentOwner.pid, token: currentOwner.token });
      return currentOwner;
    });
    if (!owner) { print(await receiverStatus(appId)); return; }
    for (let i = 0; i < 200; i += 1) {
      await delay(1000);
      const next = await receiverStatus(appId);
      if (next.state === 'stopped' && processAlive(owner.pid) === false) { print(next); return; }
    }
    throw new Error('Graceful stop is still pending; inspect status instead of force-killing');
  }
  await withReceiverControl(paths, async () => {
    const current = await receiverStatus(appId);
    if (!['running', 'stopped'].includes(current.state)) throw new Error('Receiver lock needs inspection; use status and explicit recover-lock for a dead owner');
    await setRecovery(paths, stateDir, true);
    await rm(path.join(paths.runtime, 'stop.json'), { force: true });
    // Also register/verify the watchdog when the receiver is already running.
    if (process.platform === 'win32') await startWindows(paths, stateDir);
    else if (current.state !== 'running') await startPosix(paths, stateDir);
  });
  for (let i = 0; i < 80; i += 1) {
    await delay(500);
    const next = await receiverStatus(appId);
    if (next.state === 'running' && next.connection === 'connected') { print(next); return; }
  }
  throw new Error('Receiver not connected within 40 seconds; inspect status and runtime directory');
}

try {
  if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    main(process.argv.slice(2)).catch((error) => {
      // Own operational errors only; never print subprocess stdout/stderr or credentials.
      process.stderr.write(error.cmd ? 'OS receiver task operation failed; inspect Task Scheduler.\n' : `${error.message}\n`);
      process.exitCode = 1;
    });
  }
} catch { /* Import only. */ }
