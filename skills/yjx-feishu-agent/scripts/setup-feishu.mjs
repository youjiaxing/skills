#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { saveCredentials, validateCredentials } from './feishu-credentials.mjs';

const HELP = `Usage: node setup-feishu.mjs --app-id cli_... [--state-dir PATH]

Requires Node.js 20+ and an interactive terminal on Windows, macOS or Linux.
Prompts for App Secret without echoing it. Never pass the secret as an argument.
Stores unencrypted JSON in ~/.yjx-feishu-agent/secrets/feishu.json
(or YJX_FEISHU_AGENT_HOME / --state-dir). Refuses to overwrite existing files.
Unix permissions: directory 0700, file 0600; Windows inherits directory ACLs.
Does not start a Feishu connection or validate credentials with Feishu.
`;

export function parseSetupArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--app-id': 'appId', '--state-dir': 'stateDir' }[args[i]];
    if (!key || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Invalid arguments; use --help. App Secret is accepted only at the hidden prompt');
    }
    options[key] = args[i + 1];
  }
  validateCredentials({ appId: options.appId, appSecret: 'validation-only' });
  return options;
}

export async function readSecret(input = process.stdin, output = process.stderr) {
  if (!input.isTTY || !output.isTTY) throw new Error('Open an interactive terminal to enter App Secret');
  // readline supplies platform terminal editing and restores raw mode on close.
  // Its output goes to a sink so neither typing nor pasted secrets are echoed.
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const terminal = createInterface({ input, output: sink, terminal: true, historySize: 0 });
  output.write('App Secret (hidden): ');
  try {
    return await new Promise((resolve, reject) => {
      terminal.once('SIGINT', () => reject(new Error('Credential setup cancelled')));
      terminal.once('close', () => reject(new Error('Credential input closed')));
      terminal.question('', resolve);
    });
  } finally {
    terminal.close();
    sink.end();
    output.write('\n');
  }
}

export async function main(args) {
  const options = parseSetupArgs(args);
  if (options.help) { process.stdout.write(HELP); return; }
  const appSecret = await readSecret();
  const target = await saveCredentials({ appId: options.appId, appSecret }, options.stateDir);
  process.stdout.write(`Credentials saved: ${target}\nFeishu connection has not been started.\n`);
}

try {
  if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    main(process.argv.slice(2)).catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  }
} catch { /* Imported without a CLI entrypoint. */ }
