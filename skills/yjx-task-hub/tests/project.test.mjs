import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProjectCoordinator, projectStatus } from '../scripts/project.mjs';

const projectId = '11111111-1111-4111-8111-111111111111';
const collectionId = 'collection://22222222-2222-4222-8222-222222222222';
const moduleId = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';
const newId = '55555555-5555-4555-8555-555555555555';
const authority = { confirmed: true, evidence: '已授权维护本项目；用户明确反馈验证已通过' };
const before = { 模块: '图鉴', 开发阶段: '等待自测', 人工核对结论: '保留人工判断', 备注: '独立补充' };
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yjx-task-hub-project-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, coordinator: new ProjectCoordinator(root) };
}
async function bind(coordinator, extra = {}) {
  return coordinator.handle({ action: 'bind', ...authority, projectId, parentId: collectionId, resources: [{ id: moduleId, parentId: projectId, kind: 'page', key: 'module:catalogue' }], ...extra });
}
function prepare(extra = {}) {
  return { action: 'prepare', ...authority, projectId, targetId: moduleId, kind: 'properties', before, patch: { 开发阶段: '等待联调' }, allowedProperties: ['开发阶段'], ...extra };
}
function location(state, targetId = moduleId) {
  const root = { id: projectId, parentId: collectionId };
  return { id: targetId, parentId: targetId === projectId ? collectionId : projectId, state, ancestors: targetId === projectId ? [] : [root] };
}

test('property update preserves other fields and cannot commit a partial or wrong-parent readback', async t => {
  const { coordinator, root } = fixture(t);
  await bind(coordinator);
  const op = await coordinator.handle(prepare());
  await assert.rejects(coordinator.handle({ action: 'commit', opId: op.opId, apiSucceeded: true }), /明确成功/);
  await assert.rejects(coordinator.handle({ action: 'dispatch', opId: op.opId, current: location({ ...before, 备注: '人已更新' }) }), /已变化/);
  const sent = await coordinator.handle({ action: 'dispatch', opId: op.opId, current: location(before) });
  assert.equal(sent.expected.人工核对结论, before.人工核对结论);
  await assert.rejects(coordinator.handle({ action: 'commit', opId: op.opId, apiSucceeded: true, readback: { id: moduleId, parentId: projectId, state: { 开发阶段: '等待联调' } } }), /不一致/);
  await assert.rejects(coordinator.handle({ action: 'commit', opId: op.opId, apiSucceeded: true, readback: { id: moduleId, parentId: otherId, state: sent.expected } }), /父链/);
  const result = await coordinator.handle({ action: 'commit', opId: op.opId, apiSucceeded: true, readback: location(sent.expected) });
  assert.deepEqual(result.receipt.changes, { 开发阶段: { before: '等待自测', after: '等待联调' } });
  assert.equal(projectStatus(root).pending.length, 0);
  assert.equal(fs.existsSync(path.join(root, 'state.json')), false);
});

test('protected human fields, project root properties and out-of-scope targets are refused', async t => {
  const { coordinator } = fixture(t);
  await bind(coordinator);
  await assert.rejects(coordinator.handle(prepare({ patch: { 人工核对结论: '替换' }, allowedProperties: ['人工核对结论'] })), /明确点名/);
  await assert.rejects(coordinator.handle(prepare({ allowedProperties: [] })), /字段未授权/);
  await assert.rejects(coordinator.handle(prepare({ targetId: projectId })), /个人总清单/);
  await assert.rejects(coordinator.handle(prepare({ targetId: otherId })), /范围内/);
  assert.equal(coordinator.pending().length, 0);
});

test('only unissued intent is discarded on restart; dispatched operations cannot be retried or cancelled', async t => {
  const { root, coordinator } = fixture(t);
  await bind(coordinator);
  await coordinator.handle(prepare());
  const restarted = new ProjectCoordinator(root);
  assert.equal(restarted.pending().length, 0);
  const op = await restarted.handle(prepare());
  await restarted.handle({ action: 'dispatch', opId: op.opId, current: location(before) });
  const resumed = new ProjectCoordinator(root);
  assert.equal(resumed.pending()[0].phase, 'dispatched');
  await assert.rejects(resumed.handle({ action: 'dispatch', opId: op.opId, current: location(before) }), /禁止重发/);
  await assert.rejects(resumed.handle({ action: 'cancel', opId: op.opId }), /只能对账/);
  await assert.rejects(resumed.handle({ action: 'resolve', opId: op.opId, ...authority, outcome: 'not-applied', noEffectVerified: true }), /原外部请求/);
  await resumed.handle({ action: 'resolve', opId: op.opId, ...authority, requestSettled: true, outcome: 'not-applied', noEffectVerified: true, readback: location(before) });
  assert.equal(projectStatus(root).pending.length, 0);
});

test('an unresolved project does not prevent another bound project from progressing', async t => {
  const { coordinator } = fixture(t);
  await bind(coordinator);
  const op = await coordinator.handle(prepare());
  await coordinator.handle({ action: 'dispatch', opId: op.opId, current: location(before) });
  await assert.rejects(coordinator.handle(prepare()), /未决/);
  await bind(coordinator, { projectId: otherId, resources: [{ id: newId, kind: 'page', key: 'module:shop', parentId: otherId }] });
  const independent = await coordinator.handle(prepare({ projectId: otherId, targetId: newId }));
  assert.equal(independent.phase, 'prepared');
});

test('content edits preserve manual prose and child databases, detect stale bodies and refuse edits outside the permitted section', async t => {
  const { coordinator } = fixture(t);
  await bind(coordinator);
  const body = '## 进展\n等待自测\n\n## 人工补充\n人工原文\n<database url="opaque-child-id" />';
  const content = { action: 'prepare', ...authority, projectId, targetId: projectId, kind: 'content', before: body, sections: ['## 进展\n等待自测'], edits: [{ old: '等待自测', new: '等待联调' }] };
  await assert.rejects(coordinator.handle({ ...content, edits: [{ old: '人工原文', new: '覆盖' }] }), /越过授权/);
  const op = await coordinator.handle(content);
  assert.equal(op.expected, body.replace('等待自测', '等待联调'));
  await assert.rejects(coordinator.handle({ action: 'dispatch', opId: op.opId, current: location(body + '\n新补充', projectId) }), /已变化/);
  await coordinator.handle({ action: 'dispatch', opId: op.opId, current: location(body, projectId) });
  await coordinator.handle({ action: 'commit', opId: op.opId, apiSucceeded: true, readback: location(op.expected, projectId) });
});

test('creation journals unknown results, verifies actual parent and prevents recreating an already bound semantic key', async t => {
  const { coordinator, root } = fixture(t);
  await bind(coordinator);
  const creation = prepare({ kind: 'create', targetId: projectId, resourceKind: 'database', resourceKey: 'todos-db', expected: { title: '开发待办', schema: { 事项: 'title' } } });
  const op = await coordinator.handle(creation);
  await assert.rejects(coordinator.handle({ action: 'dispatch', opId: op.opId, current: location(undefined, projectId), absenceVerified: true }), /读完/);
  await coordinator.handle({ action: 'dispatch', opId: op.opId, current: location(undefined, projectId), absenceVerified: true, inventoryComplete: true });
  const restarted = new ProjectCoordinator(root);
  await assert.rejects(restarted.handle(creation), /未决/);
  await assert.rejects(restarted.handle({ action: 'commit', opId: op.opId, apiSucceeded: true, readback: { id: newId, parentId: otherId, state: op.expected } }), /指定父节点/);
  await restarted.handle({ action: 'resolve', opId: op.opId, ...authority, requestSettled: true, outcome: 'applied', readback: location(op.expected, newId) });
  const reused = await restarted.handle(creation);
  assert.equal(reused.existing, true);
  assert.equal(reused.requiresRead, true);
  assert.equal(reused.resource.id, newId);
});

test('binding is immutable, normalizes IDs and rejects parent cycles and cross-project node reuse', async t => {
  const { coordinator } = fixture(t);
  await bind(coordinator, { projectId: projectId.replaceAll('-', '').toUpperCase() });
  await assert.rejects(bind(coordinator, { resources: [{ id: moduleId, parentId: projectId, kind: 'page', key: 'renamed-role' }] }), /改绑/);
  await assert.rejects(bind(coordinator, { projectId: otherId, resources: [{ id: moduleId, parentId: otherId, kind: 'page', key: 'module:catalogue' }] }), /其他项目/);
  await assert.rejects(bind(coordinator, { resources: [{ id: newId, parentId: newId, kind: 'page', key: 'loop' }] }), /环/);
  assert.equal(Object.keys(projectStatus(coordinator.root).projects).length, 1);
});

test('dispatch checks current target and ancestor ownership before allowing updates or creates', async t => {
  const { coordinator } = fixture(t);
  await bind(coordinator);
  const op = await coordinator.handle(prepare());
  await assert.rejects(coordinator.handle({ action: 'dispatch', opId: op.opId, current: { ...location(before), parentId: otherId } }), /父链/);
  await assert.rejects(coordinator.handle({ action: 'dispatch', opId: op.opId, current: { ...location(before), ancestors: [{ id: projectId, parentId: otherId }] } }), /父链/);
  assert.equal(coordinator.pending()[0].phase, 'prepared');
  await coordinator.handle({ action: 'cancel', opId: op.opId });
  const creation = await coordinator.handle(prepare({ kind: 'create', targetId: projectId, resourceKind: 'database', resourceKey: 'todos-db', expected: { title: '待办' } }));
  await assert.rejects(coordinator.handle({ action: 'dispatch', opId: creation.opId, current: { ...location(undefined, projectId), parentId: otherId }, absenceVerified: true, inventoryComplete: true }), /父链/);
  assert.equal(coordinator.pending()[0].phase, 'prepared');
});

test('explicit reconciliation preserves a later human edit without rewriting Notion or blocking the project forever', async t => {
  const { coordinator, root } = fixture(t);
  await bind(coordinator);
  const op = await coordinator.handle(prepare());
  await coordinator.handle({ action: 'dispatch', opId: op.opId, current: location(before) });
  const state = { ...op.expected, 备注: '用户刚补充的说明' };
  await assert.rejects(coordinator.handle({ action: 'commit', opId: op.opId, apiSucceeded: true, readback: location(state) }), /不一致/);
  await assert.rejects(coordinator.handle({ action: 'resolve', opId: op.opId, ...authority, requestSettled: true, outcome: 'accept-current', readback: location(state) }), /明确确认/);
  const receipt = await coordinator.handle({ action: 'resolve', opId: op.opId, ...authority, evidence: '用户明确确认保留当前备注与阶段', requestSettled: true, outcome: 'accept-current', acceptCurrent: true, readback: location(state) });
  assert.equal(receipt.receipt.acceptedCurrent, true);
  assert.deepEqual(receipt.receipt.differences, { 备注: { expected: before.备注, actual: state.备注 } });
  assert.equal(projectStatus(root).pending.length, 0);
  assert.equal((await coordinator.handle(prepare({ before: state, patch: { 开发阶段: '完成' } }))).phase, 'prepared');
});

test('project IPC works without TB initialization, uses the shared lock and leaves personal state untouched', t => {
  const { root } = fixture(t);
  const cli = fileURLToPath(new URL('../scripts/hub.mjs', import.meta.url));
  const env = { ...process.env, YJX_TASK_HUB_HOME: root };
  const run = (args, data) => {
    try { return JSON.parse(execFileSync(process.execPath, [cli, ...args], { env, input: data ? JSON.stringify(data) : undefined, encoding: 'utf8', windowsHide: true, timeout: 20000 })); }
    catch (error) { throw new Error(String(error.stdout || error.message)); }
  };
  const personal = '{"existing":"personal baseline"}\n';
  fs.writeFileSync(path.join(root, 'state.json'), personal);
  const { session } = run(['start', '--project']);
  try {
    assert.throws(() => run(['start', '--project']), /持锁/);
    assert.throws(() => run(['start']), /持锁/);
    assert.throws(() => run(['request', '--session', 'wrong-token'], { action: 'status' }), /令牌/);
    assert.equal(run(['request', '--session', session], { action: 'bind', ...authority, projectId, parentId: collectionId, resources: [] }).bound, true);
    assert.equal(run(['status', '--project']).mode, 'project');
    assert.throws(() => run(['start', '--project', '--sync']), /不能同时/);
  } finally {
    assert.equal(run(['stop', '--session', session]).stopped, true);
  }
  assert.equal(fs.readFileSync(path.join(root, 'state.json'), 'utf8'), personal);
  assert.equal(fs.existsSync(path.join(root, 'config.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'lock.json')), false);
});
