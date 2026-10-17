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

export function matchesTask(definition, expected) {
  // Task Scheduler reorders and indents RestartOnFailure children on export.
  const restart = text => {
    const block=text.match(/<RestartOnFailure>([\s\S]*?)<\/RestartOnFailure>/)?.[1];
    if (block===undefined) return null;
    return ['Interval','Count'].map(tag=>block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]);
  };
  if (JSON.stringify(restart(definition))!==JSON.stringify(restart(expected))) return false;
  const triggerActual = definition.match(/<Triggers>[\s\S]*?<\/Triggers>/)?.[0] ?? '';
  const triggerExpected = expected.match(/<Triggers>[\s\S]*?<\/Triggers>/)?.[0] ?? '';
  const expectedHasLogon = /<LogonTrigger>/.test(triggerExpected);
  const actualHasLogon = /<LogonTrigger>/.test(triggerActual);
  if (expectedHasLogon !== actualHasLogon) return false;
  if (expectedHasLogon && !/<LogonTrigger>[\s\S]*?(?:<Enabled>true<\/Enabled>[\s\S]*?)?<UserId>[^<]+<\/UserId>[\s\S]*?<\/LogonTrigger>/.test(triggerActual)) return false;
  definition = definition.replace(/<Triggers>[\s\S]*?<\/Triggers>/, '<Triggers />');
  expected = expected.replace(/<Triggers>[\s\S]*?<\/Triggers>/, '<Triggers />');
  const fields = ['UserId', 'LogonType', 'RunLevel', 'Command', 'Arguments', 'WorkingDirectory',
    'MultipleInstancesPolicy', 'DisallowStartIfOnBatteries', 'StopIfGoingOnBatteries',
    'AllowHardTerminate', 'AllowStartOnDemand', 'Enabled', 'ExecutionTimeLimit'];
  if ((definition.match(/<Exec>/g) ?? []).length !== 1) return false;
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

async function startWindows(paths, stateDir) {
  const { stdout: identity } = await execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = identity.match(/S-1-5-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new Error('Cannot determine current Windows user SID');
  const args = [script, 'serve', '--state-dir', stateDir].map(windowsArgument).join(' ');
  const expected = taskDefinition({ sid, node: process.execPath, args, cwd: path.dirname(script) });
  const specFile = path.join(paths.runtime, 'task.xml');
  const installation = path.join(paths.runtime, 'task-registration.json');
  const known = await readJson(installation);
  if (known) {
    if (known.stateDir !== stateDir) throw new Error('Task belongs to another state directory');
    const result = await execute('schtasks.exe', ['/Query', '/TN', paths.taskName, '/XML'], { windowsHide: true, encoding: 'buffer' });
    const buffer = result.stdout;
    const registered = (buffer[0] === 0xff && buffer[1] === 0xfe) || buffer[1] === 0 ? buffer.toString('utf16le') : buffer.toString('utf8');
    if (!matchesTask(registered, expected)) {
      const previous = previousTaskDefinition({ sid, node: process.execPath, args, cwd: path.dirname(script) });
      const legacy = legacyTaskDefinition({ sid, node: process.execPath, args, cwd: path.dirname(script) });
      if (!matchesTask(registered, previous) && !matchesTask(registered, legacy)) throw new Error('Registered task differs; refusing to run or replace it');
      await writeFile(specFile, Buffer.from(`\ufeff${expected}`, 'utf16le'), { mode: 0o600 });
      await execute('schtasks.exe', ['/Create', '/TN', paths.taskName, '/XML', specFile, '/F'], { windowsHide: true });
    }
  } else {
    await writeFile(specFile, Buffer.from(`\ufeff${expected}`, 'utf16le'), { mode: 0o600 });
    // No /F: never silently overwrite a task we have not registered.
    await execute('schtasks.exe', ['/Create', '/TN', paths.taskName, '/XML', specFile], { windowsHide: true });
    await atomicJson(installation, { stateDir, taskName: paths.taskName });
  }
  await execute('schtasks.exe', ['/Run', '/TN', paths.taskName], { windowsHide: true });
}

async function startPosix(paths, stateDir) {
  const log = await open(path.join(paths.runtime, 'receiver.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [script, 'serve', '--state-dir', stateDir], {
      detached: true, stdio: ['ignore', log.fd, log.fd], cwd: path.dirname(script), shell: false,
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
}

export async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help') {
    process.stdout.write('Usage: node receiver.mjs start|stop|status|recover-lock [--state-dir PATH]\nWindows: current-user Task Scheduler task; starts at user logon, no password or elevation.\nmacOS/Linux: detached Node process. status reports the live connection heartbeat.\nrecover-lock is explicit and only removes a receiver lock whose PID is confirmed absent.\n');
    return;
  }
  if (!['start', 'stop', 'status', 'recover-lock'].includes(command) ||
      (rest.length && (rest.length !== 2 || rest[0] !== '--state-dir' || !rest[1]))) throw new Error('Invalid arguments');
  const stateDir = path.resolve(rest[1] ?? defaultStateDir());
  const { appId } = await loadCredentials(stateDir);
  const paths = receiverPaths(appId);
  const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const status = await receiverStatus(appId);
  if (command === 'status') { print(status); return; }
  if (command === 'recover-lock') {
    print({ recovered: await recoverReceiverLock(appId), ...await receiverStatus(appId) });
    return;
  }
  if (command === 'stop') {
    if (status.state === 'stopped' || status.state === 'stale_lock') { print(status); return; }
    if (status.state !== 'running') throw new Error('Receiver identity is not confirmed; refusing stop');
    const owner = await readJson(path.join(paths.lock, 'owner.json'));
    await atomicJson(path.join(paths.runtime, 'stop.json'), { pid: owner.pid, token: owner.token });
    for (let i = 0; i < 200; i += 1) {
      await delay(1000);
      const next = await receiverStatus(appId);
      if (next.state === 'stopped' && processAlive(owner.pid) === false) { print(next); return; }
    }
    throw new Error('Graceful stop is still pending; inspect status instead of force-killing');
  }
  if (status.state === 'running') { print(status); return; }
  if (status.state !== 'stopped') throw new Error('Receiver lock needs inspection; use status and explicit recover-lock for a dead owner');
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  await rm(path.join(paths.runtime, 'stop.json'), { force: true });
  if (process.platform === 'win32') await startWindows(paths, stateDir);
  else await startPosix(paths, stateDir);
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
