#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile, realpath } from 'node:fs/promises';
import { Bridge, OpsError, resolveTarget, safeFieldExpression, validateIdentifier, observeRequest } from './lib/host.mjs';
import path from 'node:path';

const commands = new Set([
  'project.list', 'project.ensure', 'doctor',
  'config.list', 'config.show', 'config.check', 'config.clone', 'config.update',
  'run.start', 'run.status', 'run.stop', 'run.restart', 'attempt.show', 'logs',
  'debug.start', 'debug.list', 'debug.status', 'debug.wait', 'debug.pause', 'debug.continue',
  'debug.step-over', 'debug.stop', 'debug.stack', 'debug.variables', 'debug.eval',
  'breakpoint.list', 'breakpoint.set', 'breakpoint.enable', 'breakpoint.disable', 'breakpoint.remove', 'breakpoint.cleanup',
]);
const help = [
  'GoLand operations via official ideScript (Node >=20; no MCP).',
  'node scripts/goland-ops.mjs <command> [options]',
  '',
  'project list|ensure   doctor',
  'config list|show|check|clone|update',
  'run start|status|stop|restart    attempt show    logs',
  'debug start|list|status|wait|pause|continue|step-over|stop|stack|variables|eval',
  'breakpoint list|set|enable|disable|remove|cleanup',
  '',
  '--ide <launcher> --profile <config-dir> --project <directory>',
  '--properties <idea.properties> --vm-options <file> (custom IDE profiles)',
  '--config <exact name or ID> --session <token> --request <request ID>',
  '--name <clone name> --patch <JSON file> --revision <config revision>',
  '--file <project-relative source> --line <1-based> --breakpoint <ID> --task <task ID>',
  '--pause <pause token> --frame <frame token> --expression <variable.field>',
  '--tail <lines> --filter <substring> --cursor <cursor> --state <paused|running|stopped>',
  '--timeout-ms <milliseconds> --data-dir <private directory> --allow-other-sessions',
  '--allow-user-breakpoint (only when the task explicitly authorizes editing that breakpoint)',
  '',
  'JSON output. ok=0, failed=1, blocked=2, pending/unknown=3.',
  'Queries do not open an offline IDE. Use project ensure first.',
].join('\n');

export function parseCLI(argv) {
  const strings = ['ide', 'profile', 'project', 'properties', 'vm-options', 'data-dir', 'timeout-ms', 'config', 'session', 'request', 'request-id', 'name', 'patch', 'revision', 'file', 'line', 'breakpoint', 'task', 'pause', 'frame', 'expression', 'tail', 'filter', 'cursor', 'state', 'limit', 'value'];
  const options = Object.fromEntries(strings.map(name => [name, { type: 'string' }]));
  options.help = { type: 'boolean', short: 'h' };
  options['allow-other-sessions'] = { type: 'boolean' };
  options['allow-user-breakpoint'] = { type: 'boolean' };
  const parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  if (parsed.values.help || !parsed.positionals.length) return { help: true };
  const operation = parsed.positionals.join('.');
  if (!commands.has(operation)) throw new OpsError('UNKNOWN_COMMAND', '未知命令：' + operation);
  const v = parsed.values;
  const number = (name, fallback, min, max) => {
    const value = v[name] === undefined ? fallback : Number(v[name]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new OpsError('INVALID_ARGUMENT', name + ' 超出范围');
    return value;
  };
  if (operation === 'debug.eval' && !safeFieldExpression(v.expression)) throw new OpsError('UNSAFE_EXPRESSION', '首批求值仅接受变量名或字段访问链；不执行函数、赋值或任意代码');
  if (v.request) validateIdentifier(v.request);
  if (v['request-id']) validateIdentifier(v['request-id']);
  return {
    operation, timeout: number('timeout-ms', 30000, 500, 300000),
    target: { ide: v.ide, profile: v.profile, project: v.project, properties: v.properties, vmOptions: v['vm-options'], dataDir: v['data-dir'] },
    requestId: v['request-id'], patchFile: v.patch,
    args: {
      config: v.config, session: v.session, request: v.request, name: v.name, revision: v.revision,
      file: v.file, line: v.line === undefined ? undefined : number('line', 1, 1, 10000000),
      breakpoint: v.breakpoint, task: v.task, pause: v.pause, frame: v.frame, value: v.value,
      expression: v.expression, tail: number('tail', 100, 1, 1000), filter: v.filter,
      cursor: v.cursor, state: v.state, limit: number('limit', 50, 1, 200),
      allowOtherSessions: v['allow-other-sessions'] === true,
      allowUserBreakpoint: v['allow-user-breakpoint'] === true,
    },
  };
}
export async function main(argv = process.argv.slice(2)) {
  try {
    const command = parseCLI(argv);
    if (command.help) { console.log(help); return 0; }
    if (command.patchFile) {
      const raw = await readFile(path.resolve(command.patchFile), 'utf8');
      if (raw.length > 65536) throw new OpsError('PATCH_TOO_LARGE', '配置修改文件超过64KB');
      try { command.args.patch = JSON.parse(raw); }
      catch { throw new OpsError('INVALID_PATCH_JSON', '配置修改文件不是有效 JSON；为保护凭据，不输出解析原文'); }
    }
    const target = await resolveTarget(command.target);
    const bridge = new Bridge(target, { timeout: command.timeout });
    let result;
    if (command.operation === 'project.ensure') result = await bridge.ensureProject();
    else if (command.operation === 'attempt.show') {
      if (!command.args.request) throw new OpsError('REQUEST_REQUIRED', 'attempt show 需要 --request');
      if (!target.pid) {
        const observed = await observeRequest(target, command.args.request);
        result = observed.result
          ? { outcome: 'ok', cached: true, historical: true, originalTarget: observed.journal, attempt: observed.result }
          : { outcome: 'unknown', code: 'ORIGINAL_RESULT_UNAVAILABLE', originalTarget: observed.journal, message: 'IDE 已离线，原请求结果无法确认，未重放' };
      }
      else result = await bridge.send(command.operation, command.args, { id: command.requestId });
    } else result = await bridge.send(command.operation, command.args, { id: command.requestId });
    console.log(JSON.stringify(result, null, 2));
    return { ok: 0, failed: 1, blocked: 2, pending: 3, unknown: 3 }[result.outcome] ?? 1;
  } catch (error) {
    console.log(JSON.stringify({ outcome: 'failed', code: error.code || 'ERROR', message: error.message, ...(error.details || {}) }, null, 2));
    return 1;
  }
}
if (process.argv[1]) {
  const invoked = await realpath(path.resolve(process.argv[1])).catch(() => null);
  const self = await realpath(fileURLToPath(import.meta.url));
  const identity = value => process.platform === 'win32' ? value?.toLowerCase() : value;
  if (invoked && identity(invoked) === identity(self)) process.exitCode = await main();
}
