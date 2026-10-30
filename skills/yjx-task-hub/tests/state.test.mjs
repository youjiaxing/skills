import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Coordinator } from '../scripts/coordinator.mjs';
import { planTask, candidateTasks } from '../scripts/engine.mjs';
import { atomicJson, privateRoot, readJson } from '../scripts/storage.mjs';

const me = 'aaaaaaaaaaaaaaaaaaaaaaaa', other = 'cccccccccccccccccccccccc', id = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const config = { version: 1, notionDatabaseId: '11111111-1111-4111-8111-111111111111', notionDataSourceId: 'collection://22222222-2222-4222-8222-222222222222', tbUserId: me, activeWindowDays: 90, watchedTasks: [], ignoredTaskIds: [] };
const task = overrides => ({ id, title: '示例任务', executorId: me, executorName: '示例甲', isDone: false, isArchived: false, statusName: '进行中', ...overrides });
const page = (status, extra = {}) => ({ pageId: '33333333-3333-4333-8333-333333333333', properties: { '任务': '自定标题', '个人状态': status, '个人顺序': 2, '下一步动作': '保留人工进度', '来源标识': `TB:${id}`, '来源状态': '进行中 · 示例甲', '来源链接': `https://www.teambition.com/task/${id}`, ...extra } });
const entry = overrides => ({ trackingMode: 'executor', lastKnownExecutorId: me, autoCompletedByReassign: false, pageId: '33333333-3333-4333-8333-333333333333', ...overrides });
function fixture(t) {
  const root = privateRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'yjx-task-hub-test-')), true);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  atomicJson(root, 'config.json', config);
  atomicJson(root, 'state.json', { version: 1, binding: config.notionDataSourceId, entries: {} });
  return { root, hub: new Coordinator(root) };
}

test('reassignment completes once; return reopens only an agent-completed active item', () => {
  const out = planTask(task({ executorId: other, executorName: '示例乙' }), page('进行中'), entry(), config);
  assert.equal(out.type, 'auto_complete');
  assert.equal(out.unchanged, false);
  assert.equal(out.properties['个人状态'], '已完成');
  assert.equal(out.properties['来源状态'], '已转派 · 示例乙 (进行中)');
  assert.equal(out.next.autoCompletedByReassign, true);
  for (const field of ['个人顺序', '下一步动作', '任务', 'date:截止时间:start']) assert.equal(field in out.properties, false);
  const returned = planTask(task(), page('已完成'), out.next, config);
  assert.equal(returned.type, 'auto_reopen');
  assert.equal(returned.next.autoCompletedByReassign, false);
  assert.equal(planTask(task({ isArchived: true }), page('已完成'), out.next, config).type, 'snapshot');
  assert.equal(planTask(task(), page('已完成'), entry(), config).type, 'snapshot');
});

test('iteration updates only when source is explicitly known', () => {
  assert.equal(planTask(task({ iteration: 'v1.2' }), page('进行中'), entry(), config).properties['迭代'], 'v1.2');
  assert.equal(planTask(task({ iteration: null }), page('进行中'), entry(), config).properties['迭代'], null);
  assert.equal(Object.hasOwn(planTask(task(), page('进行中'), entry(), config).properties, '迭代'), false);
  assert.throws(() => planTask(task({ iteration: '' }), page('进行中'), entry(), config), /迭代/);
});

test('watched, absent owner, source completion and observed user intervention preserve personal control', () => {
  assert.equal(planTask(task({ executorId: other }), page('进行中'), entry(), { ...config, watchedTasks: [id] }).type, 'snapshot');
  assert.equal(planTask(task({ executorId: null }), page('进行中'), entry(), config).type, 'snapshot');
  const complete = planTask(task({ isDone: true }), page('进行中'), entry(), config);
  assert.equal(complete.type, 'snapshot'); assert.equal(complete.notices.length, 1); assert.equal(complete.unchanged, false);
  const intervention = planTask(task({ executorId: other }), page('进行中'), entry({ lastKnownExecutorId: other, autoCompletedByReassign: true }), config);
  assert.equal(intervention.next.autoCompletedByReassign, false);
  assert.equal(planTask(task(), page('已完成'), intervention.next, config).type, 'snapshot');
  assert.throws(() => planTask(task({ executorId: undefined }), page('进行中'), entry(), config), /executorId/);
});

test('new baseline and watched exit never invent a past reassignment', () => {
  assert.equal(planTask(task({ executorId: other }), page('进行中'), undefined, config).next.trackingMode, 'inactive');
  const modeExit = planTask(task({ executorId: other }), page('进行中'), entry({ trackingMode: 'watched', autoCompletedByReassign: true }), config);
  assert.equal(modeExit.type, 'snapshot'); assert.equal(modeExit.next.trackingMode, 'inactive');
  const assigned = planTask(task(), page('已完成'), modeExit.next, config);
  assert.equal(assigned.next.trackingMode, 'executor'); assert.equal(assigned.type, 'snapshot');
});

test('single-entry unescape normalizes sync fields while preserving manual backslash text, and unchanged items commit locally without external write', async t => {
  const { hub, root } = fixture(t);
  const rawPage = page('进行中', {
    '迭代': '3.5.1\\_hotfix\\_2026.10.29',
    '来源状态': '进行中 · 示例甲 (Demo-123)',
    '下一步动作': '检查路径 D:\\_temp\\file_name',
  });
  await hub.handle({ action: 'inventory', complete: true, pages: [rawPage] });
  assert.equal(hub.inventory[0].properties['迭代'], '3.5.1_hotfix_2026.10.29');
  assert.equal(hub.inventory[0].properties['下一步动作'], '检查路径 D:\\_temp\\file_name');
  const changedPlan = await hub.handle({ action: 'plan', task: task({ shortId: 'Demo-123', statusName: '待处理', iteration: '3.5.1_hotfix_2026.10.29' }) });
  assert.equal(changedPlan.unchanged, false);
  const noopPlan = await hub.handle({ action: 'plan', task: task({ shortId: 'Demo-123', statusName: '进行中', iteration: '3.5.1_hotfix_2026.10.29' }) });
  assert.equal(noopPlan.unchanged, true);
  assert.equal(noopPlan.committed, true);
  await assert.rejects(hub.handle({ action: 'prepare', planId: changedPlan.planId }), /计划不存在/);
  const saved = readJson(root, 'state.json').entries[`TB:${id}`];
  assert.equal(saved.pageId, rawPage.pageId);
  assert.equal(saved.pendingOp, null);
  assert.equal(saved.trackingMode, 'executor');
});

test('simplified dispatch and commit synthesize inventory without extra page fetch while enforcing pageId identity and uniqueness', async t => {
  const { hub, root } = fixture(t);
  hub.storeEntry(`TB:${id}`, entry());
  await hub.handle({ action: 'inventory', complete: true, pages: [page('进行中')] });
  const updatePlan = await hub.handle({ action: 'plan', task: task({ executorId: other, executorName: '示例乙', statusName: '已修复', iteration: '3.5.1_hotfix_2026.10.29' }) });
  const updateOp = await hub.handle({ action: 'prepare', planId: updatePlan.planId });
  const dispatched = await hub.handle({ action: 'dispatch', opId: updateOp.opId });
  assert.equal(dispatched.permitted, true);
  await assert.rejects(hub.handle({ action: 'commit', opId: updateOp.opId, apiSucceeded: true, pageId: '44444444-4444-4444-8444-444444444444' }), /目标页面不一致/);
  await assert.rejects(hub.handle({ action: 'commit', opId: updateOp.opId, apiSucceeded: true, pageId: 'invalid-uuid' }), /页面 ID/);
  await hub.handle({ action: 'commit', opId: updateOp.opId, apiSucceeded: true, pageId: '33333333333343338333333333333333' });
  assert.equal(hub.inventory[0].properties['个人状态'], '已完成');
  assert.equal(hub.inventory[0].properties['来源状态'], '已转派 · 示例乙 (已修复)');
  assert.equal(hub.inventory[0].properties['迭代'], '3.5.1_hotfix_2026.10.29');
  assert.equal(readJson(root, 'state.json').entries[`TB:${id}`].autoCompletedByReassign, true);

  const newId = 'dddddddddddddddddddddddd';
  const createPlan = await hub.handle({ action: 'plan', task: task({ id: newId, title: '新入库任务' }) });
  const createOp = await hub.handle({ action: 'prepare', planId: createPlan.planId, confirmed: true });
  await hub.handle({ action: 'dispatch', opId: createOp.opId });
  await assert.rejects(hub.handle({ action: 'commit', opId: createOp.opId, apiSucceeded: true }), /目标页面不一致/);
  await assert.rejects(hub.handle({ action: 'commit', opId: createOp.opId, apiSucceeded: true, pageId: '33333333-3333-4333-8333-333333333333' }), /占用/);
  await hub.handle({ action: 'commit', opId: createOp.opId, apiSucceeded: true, pageId: '55555555-5555-4555-8555-555555555555' });
  assert.equal(hub.state.entries[`TB:${newId}`].pageId, '55555555-5555-4555-8555-555555555555');
});

test('syncCoverage tracks planned tracked items and candidate checks accurately', async t => {
  const watchedId = 'eeeeeeeeeeeeeeeeeeeeeeee';
  const { hub } = fixture(t);
  await hub.handle({ action: 'inventory', complete: true, pages: [page('进行中')] });
  await hub.handle({ action: 'configure', confirmed: true, patch: { watchedTasks: [watchedId] } });
  await hub.handle({ action: 'inventory', complete: true, pages: [page('进行中')] });
  let status = await hub.handle({ action: 'status' });
  assert.deepEqual(status.syncCoverage, {
    trackedTotal: 2,
    plannedCount: 0,
    unplannedTrackedKeys: [`TB:${id}`, `TB:${watchedId}`],
    candidatesChecked: false,
  });
  await hub.handle({ action: 'plan', task: task() });
  await hub.handle({ action: 'candidates', complete: true, tasks: [] });
  status = await hub.handle({ action: 'status' });
  assert.deepEqual(status.syncCoverage, {
    trackedTotal: 2,
    plannedCount: 1,
    unplannedTrackedKeys: [`TB:${watchedId}`],
    candidatesChecked: true,
  });
});

test('duplicate source pages block both sync and personal edits before any intent is persisted', async t => {
  const { hub, root } = fixture(t);
  const p = page('进行中');
  const duplicate = { ...p, pageId: '44444444-4444-4444-8444-444444444444' };
  const inventory = await hub.handle({ action: 'inventory', complete: true, pages: [p, duplicate] });
  assert.equal(inventory.conflicts.length, 1);
  await assert.rejects(hub.handle({ action: 'plan', task: task() }), /重复/);
  await assert.rejects(hub.handle({ action: 'plan-personal', pageId: p.pageId, properties: { '个人状态': '暂停' } }), /重复/);
  assert.deepEqual(readJson(root, 'state.json').entries, {});
});

test('dispatched survives restarts and needs explicit success or human reconciliation to commit', async t => {
  const { hub, root } = fixture(t);
  hub.storeEntry(`TB:${id}`, entry());
  await hub.handle({ action: 'inventory', complete: true, pages: [page('进行中')] });
  const plan = await hub.handle({ action: 'plan', task: task({ executorId: other }) });
  const op = await hub.handle({ action: 'prepare', planId: plan.planId });
  await hub.handle({ action: 'dispatch', opId: op.opId, currentPage: page('进行中') });
  const restarted = new Coordinator(root);
  assert.equal(restarted.pending().length, 1);
  await restarted.handle({ action: 'inventory', complete: true, pages: [page('已完成')] });
  await assert.rejects(restarted.handle({ action: 'plan', task: task() }), /未决/);
  await assert.rejects(restarted.handle({ action: 'commit', opId: op.opId, apiSucceeded: false, page: page('已完成') }), /明确成功/);
  await assert.rejects(restarted.handle({ action: 'resolve', opId: op.opId, confirmed: true, outcome: 'not_applied' }), /旧请求/);
  const resultPage = { ...page('已完成'), properties: { ...page('已完成').properties, ...op.properties } };
  await restarted.handle({ action: 'resolve', opId: op.opId, confirmed: true, outcome: 'adopt', page: resultPage });
  assert.equal(restarted.state.entries[`TB:${id}`].autoCompletedByReassign, true);
  assert.equal(restarted.pending().length, 0);
  await assert.rejects(restarted.handle({ action: 'plan', task: task() }), /inventory/);
});

test('a confirmed non-applied transition retains prior baseline for safe recomputation', async t => {
  const { hub } = fixture(t);
  hub.storeEntry(`TB:${id}`, entry());
  await hub.handle({ action: 'inventory', complete: true, pages: [page('进行中')] });
  const p = await hub.handle({ action: 'plan', task: task({ executorId: other }) });
  const op = await hub.handle({ action: 'prepare', planId: p.planId });
  await hub.handle({ action: 'dispatch', opId: op.opId, currentPage: page('进行中') });
  await hub.handle({ action: 'resolve', opId: op.opId, confirmed: true, outcome: 'not_applied', requestSettled: true });
  assert.equal(hub.state.entries[`TB:${id}`].lastKnownExecutorId, me);
  await hub.handle({ action: 'inventory', complete: true, pages: [page('进行中')] });
  assert.equal((await hub.handle({ action: 'plan', task: task({ executorId: other }) })).type, 'auto_complete');
});

test('global recovery sees creates outside all inventories and accepts user-modified created pages', async t => {
  const { hub, root } = fixture(t);
  await hub.handle({ action: 'inventory', complete: true, pages: [] });
  const p = await hub.handle({ action: 'plan', task: task() });
  await assert.rejects(hub.handle({ action: 'prepare', planId: p.planId }), /用户/);
  const op = await hub.handle({ action: 'prepare', planId: p.planId, confirmed: true });
  await hub.handle({ action: 'dispatch', opId: op.opId, noMatchConfirmed: true });
  const restarted = new Coordinator(root);
  assert.equal(restarted.pending()[0].key, `TB:${id}`);
  const userPage = page('暂停');
  await restarted.handle({ action: 'resolve', opId: op.opId, outcome: 'user_state', confirmed: true, requestSettled: true, uniquePageConfirmed: true, page: userPage, currentExecutorId: me });
  assert.equal(restarted.state.entries[`TB:${id}`].pageId, userPage.pageId);
  assert.equal(restarted.state.entries[`TB:${id}`].autoCompletedByReassign, false);
});

test('failed external readback never advances journal; prepared-only restart is safe', async t => {
  const { hub, root } = fixture(t);
  await hub.handle({ action: 'inventory', complete: true, pages: [] });
  let p = await hub.handle({ action: 'plan', task: task() });
  await hub.handle({ action: 'prepare', planId: p.planId, confirmed: true });
  const restarted = new Coordinator(root);
  assert.equal(restarted.pending().length, 0);
  await restarted.handle({ action: 'inventory', complete: true, pages: [] });
  p = await restarted.handle({ action: 'plan', task: task() });
  const op = await restarted.handle({ action: 'prepare', planId: p.planId, confirmed: true });
  await restarted.handle({ action: 'dispatch', opId: op.opId, noMatchConfirmed: true });
  await assert.rejects(restarted.handle({ action: 'commit', opId: op.opId, apiSucceeded: true, page: page('待安排', { '来源状态': '不一致状态' }) }), /回读字段/);
  assert.equal(readJson(root, 'state.json').entries[`TB:${id}`].pendingOp.phase, 'dispatched');
});

test('new manual intake cannot borrow a pending TB identity', async t => {
  const { hub } = fixture(t);
  await hub.handle({ action: 'inventory', complete: true, pages: [] });
  const tb = await hub.handle({ action: 'plan', task: task() });
  await hub.handle({ action: 'prepare', planId: tb.planId, confirmed: true });
  const manual = await hub.handle({ action: 'plan-personal', properties: { '任务': '另一个人工事项' } });
  assert.match(manual.key, /^MANUAL:/);
});

test('candidate window classifies standalone active items for auto-intake and keeps multi-sibling or tracked-parent groups for decision', () => {
  const fresh = task({ parentId: other, createdAt: new Date().toISOString(), updatedAt: '2020-01-01T00:00:00Z' });
  const single = candidateTasks([fresh], config, new Map(), {});
  assert.equal(single.candidates.length, 1);
  assert.deepEqual(single.autoIntakeIds, [id]);
  assert.equal(single.decisionGroups.length, 0);
  const trackedParent = candidateTasks([fresh], config, new Map([[`TB:${other}`, [page('进行中')]]]), {});
  assert.deepEqual(trackedParent.autoIntakeIds, []);
  assert.equal(trackedParent.decisionGroups.length, 1);
  const sibling = task({ id: 'dddddddddddddddddddddddd', parentId: other, createdAt: new Date().toISOString() });
  const multi = candidateTasks([fresh, sibling], config, new Map(), {});
  assert.deepEqual(multi.autoIntakeIds, []);
  assert.deepEqual(multi.decisionGroups[0].taskIds, [id, 'dddddddddddddddddddddddd']);
  assert.equal(candidateTasks([fresh], config, new Map([[`TB:${id}`, [page('已完成')]]]), {}).candidates.length, 0);
});

test('ignored and historical records need no status mapping, while candidates do', () => {
  const old = task({ statusName: '', createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' });
  assert.deepEqual(candidateTasks([old], config, new Map(), {}).excludedOld, [id]);
  const ignored = task({ statusName: '', createdAt: new Date().toISOString() });
  assert.equal(candidateTasks([ignored], { ...config, ignoredTaskIds: [id] }, new Map(), {}).candidates.length, 0);
  assert.throws(() => candidateTasks([ignored], config, new Map(), {}), /状态名称/);
  assert.throws(() => candidateTasks([task({ statusName: '', createdAt: null, updatedAt: null })], config, new Map(), {}), /状态名称/);
  assert.throws(() => candidateTasks([task({ executorId: undefined })], { ...config, ignoredTaskIds: [id] }, new Map(), {}), /executorId/);
});

test('cancel and prepared-only restart roll back first uncommitted lifecycle baselines', async t => {
  const { hub, root } = fixture(t);
  await hub.handle({ action: 'inventory', complete: true, pages: [page('进行中')] });
  let p = await hub.handle({ action: 'plan', task: task({ statusName: '新状态' }) });
  let op = await hub.handle({ action: 'prepare', planId: p.planId });
  await hub.handle({ action: 'cancel', opId: op.opId });
  assert.equal(hub.state.entries[`TB:${id}`], undefined);
  p = await hub.handle({ action: 'plan', task: task({ statusName: '新状态' }) });
  op = await hub.handle({ action: 'prepare', planId: p.planId });
  assert.equal(op.phase, 'prepared');
  const restarted = new Coordinator(root);
  assert.equal(restarted.state.entries[`TB:${id}`], undefined);
  await restarted.handle({ action: 'inventory', complete: true, pages: [page('进行中')] });
  const reassigned = await restarted.handle({ action: 'plan', task: task({ executorId: other, statusName: '新状态' }) });
  assert.equal(reassigned.type, 'snapshot');
  assert.equal(reassigned.next.trackingMode, 'inactive');
});

test('accepting user state derives a fresh tracking mode from the current owner', async t => {
  const { hub } = fixture(t);
  hub.storeEntry(`TB:${id}`, entry({ trackingMode: 'inactive', lastKnownExecutorId: other }));
  await hub.handle({ action: 'inventory', complete: true, pages: [page('进行中')] });
  const p = await hub.handle({ action: 'plan', task: task({ executorId: other, statusName: '待处理' }) });
  const op = await hub.handle({ action: 'prepare', planId: p.planId });
  await hub.handle({ action: 'dispatch', opId: op.opId, currentPage: page('进行中') });
  await hub.handle({ action: 'resolve', opId: op.opId, confirmed: true, outcome: 'user_state', requestSettled: true, page: page('进行中'), currentExecutorId: me });
  assert.equal(hub.state.entries[`TB:${id}`].trackingMode, 'executor');
  await hub.handle({ action: 'inventory', complete: true, pages: [page('进行中')] });
  assert.equal((await hub.handle({ action: 'plan', task: task({ executorId: other }) })).type, 'auto_complete');
});

test('create cannot claim an existing manual page, and ID conflicts leave dispatched recovery intact', async t => {
  const { hub } = fixture(t);
  const manual = page('待安排', { '来源标识': '' });
  await hub.handle({ action: 'inventory', complete: true, pages: [manual] });
  const plan = await hub.handle({ action: 'plan', task: task() });
  const op = await hub.handle({ action: 'prepare', planId: plan.planId, confirmed: true });
  await hub.handle({ action: 'dispatch', opId: op.opId });
  for (const pageId of ['--------------------------------', '33333333333343338333333333333333']) {
    await assert.rejects(hub.handle({ action: 'commit', opId: op.opId, apiSucceeded: true, pageId }), /页面 ID|占用/);
  }
  const actual = { ...page('待安排'), pageId: '55555555-5555-4555-8555-555555555555', properties: op.properties };
  await assert.rejects(hub.handle({ action: 'commit', opId: op.opId, apiSucceeded: true, pageId: manual.pageId, page: actual }), /目标页面不一致/);
  assert.equal(hub.pending()[0].phase, 'dispatched');
  assert.equal(hub.inventory[0].properties['来源标识'], '');
  await hub.handle({ action: 'commit', opId: op.opId, apiSucceeded: true, pageId: actual.pageId });
  assert.equal(hub.inventory.length, 2);
});

test('noop cannot clear a dispatched intent and preserves exact manual fields through simplified update', async t => {
  const { hub } = fixture(t);
  const p = page('进行中', { '下一步动作': 'literal \\_text', '迭代': 'v1\\_test' });
  await hub.handle({ action: 'inventory', complete: true, pages: [p] });
  const plan = await hub.handle({ action: 'plan', task: task({ statusName: '新状态', iteration: 'v1_test' }) });
  const op = await hub.handle({ action: 'prepare', planId: plan.planId });
  await hub.handle({ action: 'dispatch', opId: op.opId });
  await assert.rejects(hub.handle({ action: 'plan', task: task({ iteration: 'v1_test' }) }), /未决/);
  await hub.handle({ action: 'commit', opId: op.opId, apiSucceeded: true });
  assert.equal(hub.inventory[0].properties['下一步动作'], 'literal \\_text');
  assert.equal(hub.inventory[0].properties['迭代'], 'v1_test');
  const noop = await hub.handle({ action: 'plan', task: task({ statusName: '新状态', iteration: 'v1_test' }) });
  assert.equal(noop.unchanged, true);
  assert.equal(hub.pending().length, 0);
});

test('failed noop persistence is not counted as successful coverage', async t => {
  const { hub, root } = fixture(t);
  await hub.handle({ action: 'inventory', complete: true, pages: [page('进行中')] });
  const savedPath = path.join(root, 'saved-state.json');
  fs.linkSync(path.join(root, 'state.json'), savedPath);
  try {
    await assert.rejects(hub.handle({ action: 'plan', task: task() }), /链接/);
    assert.equal(hub.syncCoverage().plannedCount, 0);
    assert.equal(hub.state.entries[`TB:${id}`], undefined);
  } finally { fs.unlinkSync(savedPath); }
  assert.equal((await hub.handle({ action: 'plan', task: task() })).unchanged, true);
  assert.equal(hub.syncCoverage().plannedCount, 1);
});

test('refreshing inventory or configuration invalidates coverage, and failed candidates never complete it', async t => {
  const { hub } = fixture(t);
  const p = page('进行中');
  await hub.handle({ action: 'inventory', complete: true, pages: [p] });
  await assert.rejects(hub.handle({ action: 'candidates', complete: true, tasks: [task({ executorId: other })] }), /范围外/);
  assert.equal(hub.syncCoverage().candidatesChecked, false);
  await hub.handle({ action: 'plan', task: task() });
  await hub.handle({ action: 'candidates', complete: true, tasks: [] });
  assert.equal(hub.syncCoverage().plannedCount, 1);
  await hub.handle({ action: 'inventory', complete: true, pages: [p] });
  assert.equal(hub.syncCoverage().plannedCount, 0);
  assert.equal(hub.syncCoverage().candidatesChecked, false);
  await hub.handle({ action: 'plan', task: task() });
  await hub.handle({ action: 'candidates', complete: true, tasks: [] });
  await hub.handle({ action: 'configure', confirmed: true, patch: { activeWindowDays: 60 } });
  assert.equal(hub.syncCoverage().plannedCount, 0);
  assert.equal(hub.syncCoverage().candidatesChecked, false);
});

test('latest task and personal plans invalidate old instructions even after prepare cancellation', async t => {
  const { hub } = fixture(t);
  hub.storeEntry(`TB:${id}`, entry());
  await hub.handle({ action: 'inventory', complete: true, pages: [page('进行中')] });
  const old = await hub.handle({ action: 'plan', task: task({ executorId: other, statusName: '转派' }) });
  const latest = await hub.handle({ action: 'plan', task: task({ statusName: '已转回' }) });
  const prepared = await hub.handle({ action: 'prepare', planId: latest.planId });
  await hub.handle({ action: 'cancel', opId: prepared.opId });
  await assert.rejects(hub.handle({ action: 'prepare', planId: old.planId }), /计划不存在/);
  const p1 = await hub.handle({ action: 'plan-personal', pageId: page('进行中').pageId, properties: { '下一步动作': '旧进度' } });
  const p2 = await hub.handle({ action: 'plan-personal', pageId: page('进行中').pageId, properties: { '下一步动作': '新进度' } });
  await assert.rejects(hub.handle({ action: 'prepare', planId: p1.planId, confirmed: true }), /计划不存在/);
  const op = await hub.handle({ action: 'prepare', planId: p2.planId, confirmed: true });
  assert.equal(op.properties['下一步动作'], '新进度');
});
