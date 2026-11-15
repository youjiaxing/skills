import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createFeishuRateLimiter,
  extractFeishuError,
  isRateLimitError,
  parseRetryAfterHeaders,
} from '../scripts/feishu-rate-limit.mjs';
import { reactionTransport } from '../scripts/reaction-transport.mjs';

test('rate-limit error detection distinguishes rate limits from quota exhaustion and invalid cards', () => {
  assert.equal(isRateLimitError(Object.assign(new Error('rl'), { apiCode: 230429 })), true);
  assert.equal(isRateLimitError(Object.assign(new Error('rl'), { apiCode: 230020 })), true);
  assert.equal(isRateLimitError(Object.assign(new Error('rl'), { apiCode: 99991400 })), true);
  assert.equal(isRateLimitError({ response: { status: 429, data: {} } }), true);
  assert.equal(isRateLimitError({ httpStatus: 429, apiCode: 99991403 }), false);
  assert.equal(isRateLimitError({ apiCode: 230099 }), false);
  assert.equal(isRateLimitError(new Error('network timeout')), false);

  assert.equal(parseRetryAfterHeaders({ 'X-Ogw-Ratelimit-Reset': '2' }), 2000);
  assert.equal(parseRetryAfterHeaders(new Headers({ 'retry-after': '1.2' })), 1200);
  assert.equal(extractFeishuError({ response: { status: 429, headers: { 'x-ogw-ratelimit-reset': '3' }, data: { code: 99991400 } } }).retryAfterMs, 3000);
});

test('cross-instance rate limiter serializes slots per appId and shares cooldowns', async t => {
  const gateDir = await mkdtemp(path.join(tmpdir(), 'feishu-rl-'));
  t.after(() => rm(gateDir, { recursive: true, force: true }));

  let fakeNow = 10000;
  const sleepsA = [];
  const sleepsB = [];
  const sleepA = async ms => { sleepsA.push(ms); fakeNow += ms; };
  const sleepB = async ms => { sleepsB.push(ms); fakeNow += ms; };
  const now = () => fakeNow;

  const limiterA = createFeishuRateLimiter({
    gateDir, appId: 'cli_shared', minIntervalMs: 350, baseBackoffMs: 1500, random: () => 0, sleep: sleepA, now,
  });
  const limiterB = createFeishuRateLimiter({
    gateDir, appId: 'cli_shared', minIntervalMs: 350, baseBackoffMs: 1500, random: () => 0, sleep: sleepB, now,
  });
  const otherApp = createFeishuRateLimiter({
    gateDir, appId: 'cli_other', minIntervalMs: 350, baseBackoffMs: 1500, random: () => 0, sleep: sleepB, now,
  });

  await limiterA.reserveSlot();
  assert.deepEqual(sleepsA, []);
  await limiterB.reserveSlot();
  assert.deepEqual(sleepsB, [350]);

  // Independent appId does not share the slot or cooldown of cli_shared.
  const beforeOther = sleepsB.length;
  await otherApp.reserveSlot();
  assert.equal(sleepsB.length, beforeOther);

  // When limiterA hits a 230429 with reset header, it retries and pushes shared cooldown for limiterB.
  let attempts = 0;
  const result = await limiterA.execute(async () => {
    attempts++;
    if (attempts === 1) {
      const err = new Error('rate limited');
      err.apiCode = 230429;
      err.retryAfterMs = 2000;
      throw err;
    }
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  assert.ok(sleepsA.some(ms => ms >= 2000), `expected >= 2000ms cooldown wait, got ${JSON.stringify(sleepsA)}`);

  // Immediately recording another cooldown forces limiterB to wait.
  await limiterA.recordCooldown(3000);
  const prevLen = sleepsB.length;
  await limiterB.reserveSlot();
  assert.ok(sleepsB[prevLen] >= 3000, `expected limiterB to observe shared cooldown, got ${sleepsB[prevLen]}`);
});

test('non-rate-limit errors are not retried and dead mutex locks are reclaimed', async t => {
  const gateDir = await mkdtemp(path.join(tmpdir(), 'feishu-rl-stale-'));
  t.after(() => rm(gateDir, { recursive: true, force: true }));

  const appId = 'cli_stale';
  const appHash = createHash('sha256').update(appId).digest('hex');
  const lockDir = path.join(gateDir, 'feishu-rate-limit-v1', appHash, 'gate.lock');
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({
    pid: 99999999,
    token: 'dead-token',
    createdAt: Date.now() - 10000,
  }));

  const limiter = createFeishuRateLimiter({
    gateDir, appId, minIntervalMs: 10, baseBackoffMs: 20, maxRetries: 3, sleep: async () => {},
  });

  await limiter.reserveSlot();
  let calls = 0;
  await assert.rejects(
    limiter.execute(async () => {
      calls++;
      const err = new Error('invalid card');
      err.apiCode = 230099;
      throw err;
    }),
    /invalid card/
  );
  assert.equal(calls, 1);
});

test('reactionTransport retries 429 via shared rateLimiter', async t => {
  const gateDir = await mkdtemp(path.join(tmpdir(), 'feishu-rl-reaction-'));
  t.after(() => rm(gateDir, { recursive: true, force: true }));

  const rateLimiter = createFeishuRateLimiter({
    gateDir, appId: 'cli_react', minIntervalMs: 0, baseBackoffMs: 10, random: () => 0,
  });
  let postAttempts = 0;
  const transport = reactionTransport({ appId: 'cli_react', appSecret: 'sec' }, {
    rateLimiter,
    timeoutMs: 3000,
    fetchImpl: async url => {
      if (String(url).includes('tenant_access_token')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tok', expire: 7200 }), { status: 200 });
      }
      postAttempts++;
      if (postAttempts === 1) {
        return new Response(JSON.stringify({ code: 230020 }), { status: 400, headers: { 'x-ogw-ratelimit-reset': '0.2' } });
      }
      return new Response(JSON.stringify({
        code: 0,
        data: { reaction_id: 'r1', operator: { operator_type: 'app', operator_id: 'cli_react' }, reaction_type: { emoji_type: 'OnIt' } },
      }), { status: 200 });
    },
  });

  const created = await transport.create('om_1', 'OnIt');
  assert.equal(created.reaction_id, 'r1');
  assert.equal(postAttempts, 2);
});

test('concurrent stale-lock reclamation serializes contenders without clobbering new owner', async t => {
  const gateDir = await mkdtemp(path.join(tmpdir(), 'feishu-rl-race-'));
  t.after(() => rm(gateDir, { recursive: true, force: true }));

  const appId = 'cli_race';
  const appHash = createHash('sha256').update(appId).digest('hex');
  const lockDir = path.join(gateDir, 'feishu-rate-limit-v1', appHash, 'gate.lock');
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({
    pid: 99999999,
    token: 'dead-race',
    createdAt: Date.now() - 10000,
  }));

  const limiterA = createFeishuRateLimiter({ gateDir, appId, minIntervalMs: 50, sleep: async () => {} });
  const limiterB = createFeishuRateLimiter({ gateDir, appId, minIntervalMs: 50, sleep: async () => {} });
  const limiterC = createFeishuRateLimiter({ gateDir, appId, minIntervalMs: 50, sleep: async () => {} });

  await Promise.all([
    limiterA.recordCooldown(100),
    limiterB.recordCooldown(200),
    limiterC.recordCooldown(300),
  ]);
  const gateState = JSON.parse(await (await import('node:fs/promises')).readFile(limiterA.gateFile, 'utf8'));
  assert.ok(gateState.cooldownUntil >= Date.now() + 200);
});

test('deadlineMs stops rate-limit retries before caller timeout and records cooldown', async t => {
  const gateDir = await mkdtemp(path.join(tmpdir(), 'feishu-rl-deadline-'));
  t.after(() => rm(gateDir, { recursive: true, force: true }));

  let fakeNow = 100000;
  const sleeps = [];
  const limiter = createFeishuRateLimiter({
    gateDir,
    appId: 'cli_budget',
    minIntervalMs: 350,
    baseBackoffMs: 10000,
    maxBackoffMs: 15000,
    maxRetries: 3,
    attemptHeadroomMs: 15000,
    random: () => 0,
    now: () => fakeNow,
    sleep: async ms => { sleeps.push(ms); fakeNow += ms; },
  });

  let attempts = 0;
  await assert.rejects(
    limiter.execute(async () => {
      attempts++;
      fakeNow += 5000;
      const err = new Error('rate limited');
      err.apiCode = 230429;
      throw err;
    }, { deadlineMs: 125000 }),
    /rate limited/
  );
  // Attempt 0 runs at t=100000->105000. Next backoff=10000 + headroom=15000 => 130000 > 125000, so stops after 1 attempt!
  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);

  // Subsequent call within the recorded cooldown + headroom fast-fails at local gate without invoking fn.
  let secondAttempts = 0;
  await assert.rejects(
    limiter.execute(async () => { secondAttempts++; }, { deadlineMs: 125000 }),
    err => err.apiCode === 230429 && err.rateLimitedLocalGate === true
  );
  assert.equal(secondAttempts, 0);
});
