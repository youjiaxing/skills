#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sendCodex, requestStatus } from './codex.mjs';

const HELP = `Usage:
  node agent.mjs send --thread UUID [--message TEXT] [options]
  node agent.mjs status --request-id ID [--refresh] [options]

send reads the message from stdin when --message is omitted.
Prints a JSON request record. No Feishu connection is started in this version.

Options:
  --request-id ID       Idempotency key; generated for a new send if omitted
  --codex PATH          Native executable; desktop follows Windows Desktop registration
                        (or CODEX_CLI_PATH; default: codex)
  --state-dir PATH      Journal/lock directory (or YJX_FEISHU_AGENT_HOME)
                       Default: ~/.yjx-feishu-agent
  --cwd PATH            Process working directory (default: current directory)
  --timeout-ms N        Send/wait budget, default 180000; never auto-resends
  --refresh            status only: reconcile persisted history without sending
  -h, --help           Show help

send exit codes: 0 completed, 2 blocked/failed/interrupted, 3 unconfirmed/pending.
status exit code 0 means the record was read; inspect its status field.
On Windows use the native codex.exe, not a .cmd/.ps1 shim.
`;

export function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === '--help' || command === '-h') return { help: true };
  if (!['send', 'status'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const options = { command };
  const keys = { '--thread': 'threadId', '--message': 'message', '--request-id': 'requestId',
    '--codex': 'codex', '--state-dir': 'stateDir', '--cwd': 'cwd', '--timeout-ms': 'timeoutMs' };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--refresh') { options.refresh = true; continue; }
    const key = keys[flag];
    if (!key) throw new Error(`Unknown option: ${flag}`);
    if (Object.hasOwn(options, key)) throw new Error(`Repeated option: ${flag}`);
    const value = args.shift();
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    options[key] = key === 'timeoutMs' ? Number(value) : value;
  }
  if (command === 'send' && (!options.threadId || options.refresh)) throw new Error('send requires --thread and does not accept --refresh');
  if (command === 'status' && (!options.requestId || options.threadId || options.message !== undefined)) {
    throw new Error('status requires --request-id and does not accept --thread/--message');
  }
  return options;
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(HELP); return 0; }
  if (options.command === 'send' && options.message === undefined) {
    if (process.stdin.isTTY) throw new Error('Supply --message or pipe the message on stdin');
    process.stdin.setEncoding('utf8');
    options.message = '';
    for await (const chunk of process.stdin) options.message += chunk;
  }
  const record = options.command === 'send' ? await sendCodex(options) : await requestStatus(options);
  process.stdout.write(`${JSON.stringify(record)}\n`);
  if (options.command === 'status' || record.status === 'completed') return 0;
  return ['blocked', 'failed', 'interrupted'].includes(record.status) ? 2 : 3;
}

function isEntrypoint() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isEntrypoint()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stdout.write(`${JSON.stringify({ status: 'error', message: error.message })}\n`);
    process.exitCode = 2;
  });
}
