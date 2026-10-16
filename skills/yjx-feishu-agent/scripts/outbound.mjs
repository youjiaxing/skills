#!/usr/bin/env node
import * as Lark from '@larksuiteoapi/node-sdk';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCredentials } from './feishu-credentials.mjs';
import { defaultStateDir } from './codex.mjs';
import { deliver, outboundStatus } from './outbound-core.mjs';

export const HELP = `Usage:
  node outbound.mjs send --input request.json [--state-dir PATH]
  node outbound.mjs update --input request.json [--state-dir PATH]
  node outbound.mjs status --request-id ID [--state-dir PATH]
JSON: requestId, msgType (text/post/interactive), content object.
send: chatId; optional requiresUpdate (confirmed update request ID).
update: targetRequestId (original send ID), expectedRevision, msgType=interactive.
images: {name: local path}; use "local:name" in img_key/image_key.
Relative image paths resolve against input file. No automatic retries.
Exit: 0 confirmed/read, 2 blocked/error, 3 unconfirmed.
`;
export function parseArgs(argv) {
  const [operation, ...args] = argv;
  if (!operation || ['--help','-h'].includes(operation)) return { help: true };
  if (!['send','update','status'].includes(operation)) throw new Error('Unknown operation');
  const result = { operation };
  const keys = { '--input': 'input', '--state-dir': 'stateDir', '--request-id': 'requestId' };
  while (args.length) {
    const key = keys[args.shift()]; const value = args.shift();
    if (!key || !value || result[key]) throw new Error('Invalid or repeated option');
    result[key] = value;
  }
  if (operation === 'status' ? (!result.requestId || result.input) : (!result.input || result.requestId)) throw new Error('Missing or incompatible options');
  return result;
}
function check(result) {
  if (result?.code !== 0) { const error = new Error('API rejected'); error.apiCode = result?.code; throw error; }
  return result.data;
}
export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(HELP); return 0; }
  const stateDir = path.resolve(options.stateDir ?? defaultStateDir());
  const credentials = await loadCredentials(stateDir);
  let record;
  if (options.operation === 'status') record = await outboundStatus({ stateDir, appId: credentials.appId, requestId: options.requestId });
  else {
    const file = path.resolve(options.input);
    const input = JSON.parse(await readFile(file, 'utf8'));
    if (input.operation && input.operation !== options.operation) throw new Error('Input operation conflicts with command');
    Lark.defaultHttpInstance.defaults.timeout = 15000;
    const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
    const client = new Lark.Client({ ...credentials, logger });
    const transport = {
      async upload(bytes) {
        const result = await client.im.v1.image.create({ data: { image_type: 'message', image: bytes } });
        if (typeof result?.image_key !== 'string' || !result.image_key) throw new Error('Missing image key');
        return result.image_key;
      },
      async send(chatId, type, content, uuid) {
        const data = check(await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: type, content: JSON.stringify(content), uuid } }));
        if (!data?.message_id) throw new Error('Missing message receipt');
        return data.message_id;
      },
      async update(messageId, content) {
        check(await client.im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(content) } }));
        return messageId;
      },
    };
    record = await deliver({ ...input, operation: options.operation }, { stateDir, appId: credentials.appId, directory: path.dirname(file), transport });
  }
  // Status includes durable content; never serialize SDK objects.
  process.stdout.write(`${JSON.stringify(record)}\n`);
  return options.operation === 'status' || record.status === 'sent' ? 0 : record.status === 'unconfirmed' ? 3 : 2;
}
try {
  if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
      process.stdout.write('{"status":"error","message":"Check input, credentials, revision and outbound journals; no automatic retry"}\n');
      process.exitCode = 2;
    });
  }
} catch { /* Import only. */ }
