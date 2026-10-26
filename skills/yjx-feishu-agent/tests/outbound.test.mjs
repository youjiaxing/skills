import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { deliver, outboundStatus, prepareContent, outboundPaths, validateCard,
  recheckOutbound, reconcileOutbound, submissionOutcome } from '../scripts/outbound-core.mjs';
import { parseArgs, main, preflight } from '../scripts/outbound.mjs';

const card = text => ({ header: { title: { tag: 'plain_text', content: text } }, elements: [] });
async function setup(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'feishu-outbound-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const calls = [];
  const transport = {
    async upload(bytes) { calls.push(['upload', bytes.length]); return 'img_test'; },
    async send(chat, type, content, uuid) { calls.push(['send', chat, type, content, uuid]); return 'om_test'; },
    async update(id, content) { calls.push(['update', id, content]); return id; },
  };
  const options = { stateDir, appId: 'cli_test', directory: stateDir, transport };
  const initial = { operation: 'send', requestId: 'daily', chatId: 'oc_test', msgType: 'interactive', content: card('initial') };
  const update = { operation: 'update', requestId: 'change', targetRequestId: 'daily', expectedRevision: 1,
    msgType: 'interactive', content: card('updated') };
  return { stateDir, options, initial, update, calls, transport };
}

test('send/update/repeat and independent reminder retain one original message', async t => {
  const c = await setup(t);
  const first = await deliver(c.initial, c.options);
  assert.equal(first.revision, 1);
  assert.equal(first.content.config.update_multi, true);
  const changed = await deliver(c.update, c.options);
  assert.equal(changed.revision, 2);
  assert.equal(changed.messageId, first.messageId);
  assert.equal((await deliver(c.update, c.options)).deduplicated, true);
  await assert.rejects(deliver({ ...c.update, content: card('conflict') }, c.options), /different input/);
  await assert.rejects(deliver({ ...c.update, requestId: 'stale' }, c.options), /revision conflict/);
  const reminder = { ...c.initial, requestId: 'notice', requiresUpdate: 'change', msgType: 'text', content: { text: 'New item' } };
  assert.equal((await deliver(reminder, c.options)).status, 'sent');
  await deliver(reminder, c.options);
  assert.deepEqual(c.calls.map(c => c[0]), ['send', 'update', 'send']);
});

test('unknown update blocks later revisions and its dependent reminder without retry', async t => {
  const c = await setup(t);
  await deliver(c.initial, c.options);
  c.transport.update = async () => { c.calls.push(['unknown']); throw new Error('request with secret should not leak'); };
  const result = await deliver(c.update, c.options);
  assert.equal(result.status, 'unconfirmed');
  assert.ok(!JSON.stringify(result).includes('secret'));
  await deliver(c.update, c.options);
  await assert.rejects(deliver({ ...c.update, requestId: 'bypass' }, c.options), /unresolved/);
  await assert.rejects(deliver({ ...c.initial, requestId: 'notice', requiresUpdate: 'change' }, c.options), /not confirmed/);
  assert.equal(c.calls.length, 2);
  assert.equal((await outboundStatus({ ...c.options, requestId: 'change' })).status, 'unconfirmed');
});

test('concurrent sends deduplicate and competing updates cannot overwrite same revision', async t => {
  const c = await setup(t);
  const sends = await Promise.all([deliver(c.initial, c.options), deliver(c.initial, c.options)]);
  assert.equal(sends.filter(r => r.deduplicated).length, 1);
  const results = await Promise.allSettled([deliver(c.update, c.options), deliver({ ...c.update, requestId: 'other-change' }, c.options)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.deepEqual(c.calls.map(c => c[0]), ['send','update']);
});

test('case-distinct request IDs keep independent journals on Windows filesystems', async t => {
  const c = await setup(t);
  const upper = { ...c.initial, requestId: 'DAILY', content: card('upper') };
  await Promise.all([deliver(c.initial, c.options), deliver(upper, c.options)]);
  assert.equal((await outboundStatus({ ...c.options, requestId: 'daily' })).content.header.title.content, 'initial');
  assert.equal((await outboundStatus({ ...c.options, requestId: 'DAILY' })).content.header.title.content, 'upper');
  assert.equal((await deliver(c.initial, c.options)).deduplicated, true);
  assert.equal((await deliver(upper, c.options)).deduplicated, true);
});

test('crash-left pending gate blocks subsequent update even with successful operation receipt', async t => {
  const c = await setup(t);
  await deliver(c.initial, c.options);
  await deliver(c.update, c.options);
  const targetPath = outboundPaths(c.stateDir, c.options.appId).target('daily');
  const head = JSON.parse(await readFile(targetPath, 'utf8'));
  head.pending = 'change'; // Durable state between operation receipt and clearing head gate.
  await writeFile(targetPath, JSON.stringify(head));
  await assert.rejects(deliver({ ...c.update, requestId: 'next', expectedRevision: 2 }, c.options), /unresolved/);
  assert.equal(c.calls.filter(c => c[0] === 'update').length, 1);
});

test('blocked preparation journal retains exact input evidence without bytes', async t => {
  const c = await setup(t);
  await writeFile(path.join(c.stateDir, 'image.png'), 'image bytes');
  const input = { ...c.initial, images: { photo: 'image.png' },
    content: { elements: [{ tag: 'img', img_key: 'local:photo' }] } };
  const result = await deliver(input, c.options);
  assert.equal(result.status, 'sent');
  const success = await outboundStatus({ ...c.options, requestId: 'daily' });
  const digest = createHash('sha256').update('image bytes').digest('hex');
  assert.deepEqual(success.imageDigests, { photo: digest });
  assert.deepEqual(success.images, { photo: 'image.png' });

  const blockedInput = { ...input, requestId: 'blocked-image', chatId: 'oc_blocked' };
  c.transport.upload = async () => { throw new Error('upload synthetic failure'); };
  const blocked = await deliver(blockedInput, c.options);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.submitted, false);
  assert.equal(blocked.error.stage, 'prepare');
  assert.deepEqual(blocked.imageDigests, success.imageDigests);
  assert.deepEqual(blocked.images, { photo: 'image.png' });
});

test('lost send receipt never retries and oversized card submits no message', async t => {
  const c = await setup(t);
  c.transport.send = async () => { c.calls.push(['lost']); throw new Error('lost receipt'); };
  assert.equal((await deliver(c.initial, c.options)).status, 'unconfirmed');
  assert.equal((await deliver(c.initial, c.options)).deduplicated, true);
  const result = await deliver({ ...c.initial, requestId: 'large', content: card('a'.repeat(31000)) }, c.options);
  assert.equal(result.status, 'blocked');
  assert.equal(c.calls.length, 1);
});

test('local images upload and changed image bytes conflict even when path is unchanged', async t => {
  const c = await setup(t);
  await writeFile(path.join(c.stateDir, 'image.png'), 'bytes');
  const input = { ...c.initial, images: { photo: 'image.png' }, content: { elements: [{ tag: 'img', img_key: 'local:photo' }] } };
  const result = await deliver(input, c.options);
  assert.equal(result.content.elements[0].img_key, 'img_test');
  await writeFile(path.join(c.stateDir, 'image.png'), 'changed');
  await assert.rejects(deliver(input, c.options), /different input/);
  assert.deepEqual(c.calls.map(c=>c[0]), ['upload','send']);
});

test('status reports a missing receipt distinctly instead of a read failure', async t => {
  const c = await setup(t);
  await mkdir(path.join(c.stateDir, 'secrets'), { recursive: true });
  await writeFile(path.join(c.stateDir, 'secrets', 'feishu.json'),
    JSON.stringify({ version: 1, protection: 'file-permissions', appId: 'cli_test', appSecret: 'secret' }));
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = chunk => { chunks.push(chunk); return true; };
  let code;
  try { code = await main(['status', '--request-id', 'never-delivered', '--state-dir', c.stateDir]); }
  finally { process.stdout.write = original; }
  assert.equal(code, 3);
  const verdict = JSON.parse(chunks.join('').trim());
  assert.equal(verdict.code, 'receipt-missing');
  assert.equal(verdict.submitted, null);
  assert.equal(verdict.outcome, 'unknown');
});

test('preflight proves a preparation failure without credentials or side effects', async t => {
  const c = await setup(t);
  const file = path.join(c.stateDir, 'request.json');
  await writeFile(file, JSON.stringify({ ...c.initial, images: {}, content: { elements: [{ tag: 'img', img_key: 'local:missing' }] } }));
  const verdict = await preflight(file);
  assert.equal(verdict.status, 'blocked');
  assert.equal(verdict.submitted, false);
  assert.equal(verdict.stage, 'prepare');
  assert.equal(verdict.scope, 'current-preflight');
  assert.equal(verdict.historicalOutcome, 'unknown');
  assert.deepEqual(c.calls, []);
});

test('card schema 2.0 with root elements fails locally instead of being rejected by Feishu', async t => {
  const c = await setup(t);
  const broken = { ...c.initial, requestId: 'broken-card',
    content: { schema: '2.0', config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: 'x' } }, elements: [{ tag: 'hr' }] } };
  await assert.rejects(deliver(broken, c.options), /nest elements under body/);
  assert.deepEqual(c.calls, []);
  const fixed = { ...broken, content: { schema: '2.0', config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: 'x' } }, body: { elements: [{ tag: 'hr' }] } } };
  assert.equal((await deliver(fixed, c.options)).status, 'sent');
  assert.deepEqual(c.calls.map(x => x[0]), ['send']);
  assert.throws(() => validateCard({ body: { elements: [] } }), /requires schema 2.0/);
  assert.throws(() => validateCard({ schema: '2.0', body: {} }), /elements must be an array/);
});

test('explicit provider rejection is blocked and safely retryable, not unknown', async t => {
  const c = await setup(t);
  c.transport.send = async () => {
    const error = new Error('provider rejected');
    error.apiCode = 230099;
    throw error;
  };
  const first = await deliver(c.initial, c.options);
  assert.equal(first.status, 'blocked');
  assert.equal(first.submitted, false);
  assert.equal(first.error.rejected, true);
  assert.equal(first.error.stage, 'submit');
  assert.equal(submissionOutcome(first),'not_submitted');
  // A definitive rejection produced nothing, so a corrected request under a new id is allowed.
  c.transport.send = async (chat, type, content, uuid) => { c.calls.push(['send', uuid]); return 'om_retry'; };
  const second = await deliver({ ...c.initial, requestId: 'daily-fixed', content: card('fixed') }, c.options);
  assert.equal(second.status, 'sent');
  assert.equal(second.messageId, 'om_retry');
});

test('recheck never resends, validates files or overwrites unknown evidence, even after the dedup window',async t=>{
  const c=await setup(t);
  c.transport.send=async()=>{c.calls.push(['lost']);throw Error('lost');};
  const original=await deliver(c.initial,c.options);
  original.createdAt='2020-01-01T00:00:00Z';
  const file=outboundPaths(c.stateDir,c.options.appId).request('daily');
  await writeFile(file,JSON.stringify(original));
  const before=await readFile(file,'utf8');
  c.transport.get=async()=>{assert.fail('No acknowledged message ID to query');};
  for(let i=0;i<2;i++) {
    const result=await recheckOutbound({...c.options,requestId:'daily'});
    assert.equal(result.outcome,'unknown');assert.equal(result.readOnly,true);assert.equal(result.retried,false);
  }
  const legacy=await deliver({...c.initial,images:{missing:'gone.png'}},{...c.options,recheckUnknown:true});
  assert.equal(legacy.outcome,'unknown');
  assert.equal(await readFile(file,'utf8'),before);assert.equal(c.calls.length,1);
  await assert.rejects(reconcileOutbound({...c.options,requestId:'daily'}),/No durable/);
});

test('missing recheck does not create a request or submit with a fresh ID',async t=>{
  const c=await setup(t);
  const result=await recheckOutbound({...c.options,requestId:'missing'});
  assert.equal(result.status,'missing');assert.equal(result.submitted,null);assert.equal(result.outcome,'unknown');
  await assert.rejects(outboundStatus({...c.options,requestId:'missing'}),{code:'ENOENT'});
  assert.deepEqual(c.calls,[]);
});

test('only new original-attempt evidence proves no submission; old blocked records remain unknown',async t=>{
  const c=await setup(t);
  await writeFile(path.join(c.stateDir,'image.png'),'bytes');
  c.transport.upload=async()=>{throw Error('upload unavailable');};
  const blocked=await deliver({...c.initial,images:{a:'image.png'},content:{elements:[{tag:'img',img_key:'local:a'}]}},c.options);
  assert.equal(submissionOutcome(blocked),'not_submitted');
  assert.equal(submissionOutcome({...blocked,version:1}),'unknown');
  assert.equal(submissionOutcome({...blocked,firstSubmittedAt:new Date().toISOString()}),'unknown');
  assert.equal(submissionOutcome({...blocked,failureProof:undefined}),'unknown');
  assert.deepEqual(c.calls,[]);
});

test('unclassified provider errors cannot be used to prove a message was rejected',async t=>{
  const c=await setup(t);
  c.transport.send=async()=>{const e=new Error('ambiguous');e.apiCode=999;throw e;};
  const result=await deliver(c.initial,c.options);
  assert.equal(result.status,'unconfirmed');assert.equal(result.error.stage,'submit');
  assert.equal(submissionOutcome(result),'unknown');
});

test('read-only remote absence never clears an unknown update or its dependent reminder',async t=>{
  const c=await setup(t);await deliver(c.initial,c.options);
  c.transport.update=async()=>{throw Error('timeout');};
  await deliver(c.update,c.options);
  c.transport.get=async()=>{throw Error('404');};
  const result=await recheckOutbound({...c.options,requestId:'change'});
  assert.equal(result.outcome,'unknown');
  assert.equal(result.remote.visible,false);
  assert.equal(result.attentionKey,(await recheckOutbound({...c.options,requestId:'change'})).attentionKey);
  await assert.rejects(deliver({...c.initial,requestId:'notice',requiresUpdate:'change'},c.options),/not confirmed/);
});

test('successful receipt with pending gate repairs locally and is idempotent without remote writes',async t=>{
  const c=await setup(t);await deliver(c.initial,c.options);await deliver(c.update,c.options);
  const file=outboundPaths(c.stateDir,c.options.appId).target('daily');
  const target=JSON.parse(await readFile(file,'utf8'));target.pending='change';await writeFile(file,JSON.stringify(target));
  const before=c.calls.length;
  const result=await reconcileOutbound({...c.options,requestId:'change'});
  assert.equal(result.reconciled,true);assert.equal(result.retried,false);
  assert.equal(JSON.parse(await readFile(file,'utf8')).pending,null);
  assert.equal((await reconcileOutbound({...c.options,requestId:'change'})).reconciled,false);
  assert.equal(c.calls.length,before);
  await deliver({...c.update,requestId:'later',expectedRevision:2},c.options);
  const newer=await readFile(file,'utf8');
  await assert.rejects(reconcileOutbound({...c.options,requestId:'change'}),/Target changed/);
  assert.equal(await readFile(file,'utf8'),newer);
});

test('a durable acknowledgement repairs a crash before target commit, but never guesses from similar content',async t=>{
  const c=await setup(t);const sent=await deliver(c.initial,c.options);
  const paths=outboundPaths(c.stateDir,c.options.appId);
  const record={...sent,status:'unconfirmed'};delete record.messageId;delete record.revision;
  await writeFile(paths.request('daily'),JSON.stringify(record));
  await rm(paths.target('daily'));
  assert.equal((await recheckOutbound({...c.options,requestId:'daily'})).outcome,'sent');
  assert.equal((await reconcileOutbound({...c.options,requestId:'daily'})).revision,1);
  assert.equal(c.calls.length,1);
  const unknown={...record,requestId:'other',targetRequestId:'other'};delete unknown.acknowledgement;
  await writeFile(paths.request('other'),JSON.stringify(unknown));
  assert.equal((await recheckOutbound({...c.options,requestId:'other'})).outcome,'unknown');
});

test('CLI legacy recheck input reads only the ID, even if original media has disappeared',async t=>{
  const c=await setup(t);
  await mkdir(path.join(c.stateDir,'secrets'),{recursive:true});
  await writeFile(path.join(c.stateDir,'secrets','feishu.json'),
    JSON.stringify({version:1,protection:'file-permissions',appId:'cli_test',appSecret:'secret'}));
  c.transport.send=async()=>{c.calls.push(['lost']);throw Error('lost receipt');};
  await deliver(c.initial,c.options);
  const input=path.join(c.stateDir,'request.json');
  await writeFile(input,JSON.stringify({...c.initial,images:{gone:'missing.png'}}));
  const chunks=[],original=process.stdout.write;
  process.stdout.write=chunk=>{chunks.push(chunk);return true;};
  let code;
  try {code=await main(['recheck','--input',input,'--state-dir',c.stateDir]);}
  finally {process.stdout.write=original;}
  assert.equal(code,3);assert.equal(JSON.parse(chunks.join('')).outcome,'unknown');
  assert.equal(c.calls.length,1);
  assert.equal(parseArgs(['recheck','--request-id','daily']).requestId,'daily');
  assert.equal(parseArgs(['reconcile','--request-id','daily']).operation,'reconcile');
  const isolated = path.join(c.stateDir, 'isolated-ledger');
  const shared = path.join(c.stateDir, 'shared-credentials');
  await mkdir(path.join(shared, 'secrets'), { recursive: true });
  await writeFile(path.join(shared, 'secrets', 'feishu.json'),
    JSON.stringify({ version: 1, protection: 'file-permissions', appId: 'cli_test', appSecret: 'secret' }));
  const chunks2 = [], original2 = process.stdout.write;
  process.stdout.write = chunk => { chunks2.push(chunk); return true; };
  let code2;
  try { code2 = await main(['status', '--request-id', 'missing', '--state-dir', isolated,
    '--credentials-dir', shared]); }
  finally { process.stdout.write = original2; }
  assert.equal(code2, 3);
  assert.equal(JSON.parse(chunks2.join('')).code, 'receipt-missing');
  assert.throws(()=>parseArgs(['recheck','--request-id','daily','--input',input]),/incompatible/);
});

test('legacy successful journals still deduplicate, but local repair never migrates their target type',async t=>{
  const c=await setup(t);const sent=await deliver(c.initial,c.options);
  const paths=outboundPaths(c.stateDir,c.options.appId);
  const legacy={...sent,version:1};delete legacy.msgType;delete legacy.acknowledgement;
  await writeFile(paths.request('daily'),JSON.stringify(legacy));
  const target=JSON.parse(await readFile(paths.target('daily'),'utf8'));target.pending='daily';
  await writeFile(paths.target('daily'),JSON.stringify(target));
  const before=await readFile(paths.target('daily'),'utf8');
  assert.equal((await deliver(c.initial,c.options)).deduplicated,true);
  assert.equal((await recheckOutbound({...c.options,requestId:'daily'})).outcome,'sent');
  await assert.rejects(reconcileOutbound({...c.options,requestId:'daily'}),/not migrated/);
  assert.equal(await readFile(paths.target('daily'),'utf8'),before);assert.equal(c.calls.length,1);
});

test('preparation failure submits no message and CLI rejects ambiguous input', async t => {
  const c = await setup(t);
  await writeFile(path.join(c.stateDir, 'a.png'), 'bytes');
  c.transport.upload = async () => { throw new Error('upload failure'); };
  const input = { ...c.initial, images: { a: 'a.png' }, content: { elements: [{ tag:'img', img_key:'local:a' }] } };
  const r = await deliver(input, c.options);
  assert.equal(r.status, 'blocked'); assert.equal(r.submitted, false);
  assert.equal(c.calls.length, 0);
  await assert.rejects(prepareContent({ ...c.initial, content: { config: { update_multi: false } } }), /Shared card/);
  assert.throws(() => parseArgs(['send','--input','a','--input','b']), /repeated/);
  assert.throws(() => parseArgs(['status','--input','a']), /incompatible/);
});
