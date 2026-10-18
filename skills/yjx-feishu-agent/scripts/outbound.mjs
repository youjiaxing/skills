#!/usr/bin/env node
import * as Lark from '@larksuiteoapi/node-sdk';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCredentials } from './feishu-credentials.mjs';
import { defaultStateDir } from './codex.mjs';
import { deliver, outboundStatus, prepareContent, recheckOutbound, reconcileOutbound } from './outbound-core.mjs';
import { readTransport } from './feishu-context.mjs';

export const HELP = `Usage:
  node outbound.mjs send --input request.json [--state-dir PATH]
  node outbound.mjs update --input request.json [--state-dir PATH]
  node outbound.mjs status --request-id ID [--state-dir PATH]
  node outbound.mjs preflight --input request.json
  node outbound.mjs recheck --request-id ID [--state-dir PATH]
  node outbound.mjs reconcile --request-id ID [--state-dir PATH]
JSON: requestId, msgType (text/post/interactive), content object.
sourceThreadId: explicit local Codex chat UUID for quote routing; never inferred.
send: chatId; optional requiresUpdate (confirmed update request ID).
update: targetRequestId (original send ID), expectedRevision, msgType=interactive.
images: {name: local path}; use "local:name" in img_key/image_key.
Relative image paths resolve against input file. No automatic retries.
recheck: read-only; legacy --input reads only requestId. Never resends.
reconcile: repairs local journals from durable success only; no remote writes.
Exit: 0 confirmed/read, 2 blocked/error, 3 unconfirmed.
`;
export function parseArgs(argv) {
  const [operation, ...args] = argv;
  if (!operation || ['--help','-h'].includes(operation)) return { help: true };
  if (!['send','update','status','preflight','recheck','reconcile'].includes(operation)) throw new Error('Unknown operation');
  const result = { operation };
  const keys = { '--input': 'input', '--state-dir': 'stateDir', '--request-id': 'requestId' };
  while (args.length) {
    const key = keys[args.shift()]; const value = args.shift();
    if (!key || !value || result[key]) throw new Error('Invalid or repeated option');
    result[key] = value;
  }
  const valid = ['status','reconcile'].includes(operation) ? result.requestId && !result.input
    : operation==='recheck' ? Boolean(result.requestId)!==Boolean(result.input) : result.input && !result.requestId;
  if (!valid) throw new Error('Missing or incompatible options');
  return result;
}
function check(result) {
  if (result?.code !== 0) { const error = new Error('API rejected'); error.apiCode = result?.code; throw error; }
  return result.data;
}
export async function preflight(file) {
  const source = path.resolve(file);
  const input = JSON.parse(await readFile(source, 'utf8'));
  try {
    const prepared = await prepareContent(input, path.dirname(source));
    return { version: 1, scope:'current-preflight', historicalOutcome:'unknown', status: 'ready', submitted: false,
      fingerprint: prepared.fingerprint, input };
  } catch {
    return { version: 1, scope:'current-preflight', historicalOutcome:'unknown', status: 'blocked', submitted: false, stage: 'prepare',
      error: { message: 'Preparation failed; no message submitted' }, input };
  }
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(HELP); return 0; }
  if (options.operation === 'preflight') {
    const verdict = await preflight(options.input);
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
    return verdict.status === 'ready' ? 0 : 3;
  }
  const stateDir = path.resolve(options.stateDir ?? defaultStateDir());
  const credentials = await loadCredentials(stateDir);
  let record;
  if (options.operation === 'status') {
    try { record = await outboundStatus({ stateDir, appId: credentials.appId, requestId: options.requestId }); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      process.stdout.write('{"status":"missing","code":"receipt-missing","submitted":null,"outcome":"unknown"}\n');
      return 3;
    }
  }
  else if (options.operation==='recheck') {
    const requestId = options.requestId ?? JSON.parse(await readFile(path.resolve(options.input),'utf8')).requestId;
    record = await recheckOutbound({stateDir,appId:credentials.appId,requestId,transport:readTransport(credentials)});
  } else if (options.operation==='reconcile') {
    record = await reconcileOutbound({stateDir,appId:credentials.appId,requestId:options.requestId});
  } else {
    const file = path.resolve(options.input);
    const input = JSON.parse(await readFile(file, 'utf8'));
    if (input.operation && input.operation !== options.operation) throw new Error('Input operation conflicts with command');
    Lark.defaultHttpInstance.defaults.timeout = 15000;
    const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
    const client = new Lark.Client({ ...credentials, logger });
    const transport = {
      async upload(bytes) {
        const result = await client.im.v1.image.create({ data: { image_type: 'message', image: bytes } });
        if (Number.isSafeInteger(result?.code) && result.code !== 0) {
          const error = new Error('API rejected'); error.apiCode = result.code; throw error;
        }
        if (typeof result?.image_key !== 'string' || !result.image_key) throw new Error('Missing image key');
        return result.image_key;
      },
      async send(chatId, type, content, uuid) {
        let response;
        try {
          response = await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, msg_type: type, content: JSON.stringify(content), uuid } });
        } catch (error) {
          if (!Number.isSafeInteger(error?.apiCode) && Number.isSafeInteger(error?.response?.data?.code)) {
            error.apiCode = error.response.data.code;
          }
          throw error;
        }
        const data = check(response);
        if (!data?.message_id) throw new Error('Missing message receipt');
        return data.message_id;
      },
      async update(messageId, content) {
        try {
          check(await client.im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(content) } }));
        } catch (error) {
          if (!Number.isSafeInteger(error?.apiCode) && Number.isSafeInteger(error?.response?.data?.code)) {
            error.apiCode = error.response.data.code;
          }
          throw error;
        }
        return messageId;
      },
    };
    record = await deliver({ ...input, operation: options.operation },
      { stateDir, appId: credentials.appId, directory: path.dirname(file), transport });
  }
  // Status includes durable content; never serialize SDK objects.
  process.stdout.write(`${JSON.stringify(record)}\n`);
  if (options.operation==='recheck') return record.outcome==='sent' ? 0 : record.outcome==='not_submitted' ? 2 : 3;
  if (options.operation === 'status' || record.status === 'sent') return 0;
  return record.status === 'unconfirmed' ? 3 : 2;
}
try {
  if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
      process.stdout.write('{"status":"error","message":"Check input, credentials, revision and outbound journals; no automatic retry"}\n');
      process.exitCode = 2;
    });
  }
} catch { /* Import only. */ }
