import { randomUUID } from 'node:crypto';

export const statuses = ['待安排', '进行中', '等待他人', '暂停', '已完成'];
const objectId = /^[a-f0-9]{24}$/;
const pageUuid = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const unescapeSyncFields = new Set(['迭代', '来源状态']);

export function taskKey(id) {
  if (typeof id !== 'string' || !objectId.test(id)) throw new Error('taskId 必须是 canonical 24 位小写 ObjectId');
  return `TB:${id}`;
}

export function normalizePageId(id) {
  if (typeof id !== 'string' || !pageUuid.test(id)) throw new Error('页面 ID 缺失或格式无效');
  return id.replace(/-/g, '').toLowerCase();
}

export function normalizeExternalPage(page) {
  if (!page || typeof page !== 'object') throw new Error('页面数据缺失');
  normalizePageId(page.pageId);
  const raw = page.properties && typeof page.properties === 'object' ? page.properties : null;
  if (!raw) throw new Error('缺少有效个人状态');
  const properties = structuredClone(raw);
  for (const field of unescapeSyncFields) {
    if (typeof properties[field] === 'string') properties[field] = properties[field].replaceAll('\\_', '_');
  }
  return { ...structuredClone(page), pageId: page.pageId, properties };
}

function validateEligibility(task) {
  taskKey(task?.id);
  // Omitted executor is not evidence of an unassigned task.
  if (!Object.hasOwn(task, 'executorId') || !(task.executorId === null || (typeof task.executorId === 'string' && objectId.test(task.executorId)))) throw new Error('缺少核实的 executorId（明确无人负责时传 null）');
  if (typeof task.isDone !== 'boolean' || typeof task.isArchived !== 'boolean') throw new Error('缺少核实的完成/归档布尔值');
}

export function validateTask(task) {
  validateEligibility(task);
  if (typeof task.title !== 'string' || !task.title.trim()) throw new Error('缺少任务标题');
  if (typeof task.statusName !== 'string' || !task.statusName.trim()) throw new Error('缺少已核实的 TB 状态名称');
  if (task.parentId != null) taskKey(task.parentId);
}

export function indexPages(pages) {
  const index = new Map();
  const pageIds = new Set();
  for (const page of pages) {
    const canonicalId = typeof page?.pageId === 'string' && pageUuid.test(page.pageId) ? normalizePageId(page.pageId) : null;
    if (!canonicalId || pageIds.has(canonicalId)) throw new Error('页面 ID 缺失/重复');
    pageIds.add(canonicalId);
    if (!page.properties || !statuses.includes(page.properties['个人状态'])) throw new Error('缺少有效个人状态');
    const key = page.properties['来源标识'];
    if (key == null || key === '') continue;
    if (!/^TB:[a-f0-9]{24}$/.test(key)) throw new Error(`来源标识格式异常，先人工核对页面 ${page.pageId}`);
    index.set(key, [...(index.get(key) ?? []), page]);
  }
  return index;
}

export function candidateTasks(tasks, config, index, entries, now = Date.now()) {
  const cutoff = now - config.activeWindowDays * 86400000;
  const result = { candidates: [], excludedOld: [], unknownDates: [] };
  const seen = new Set();
  for (const task of tasks) {
    validateEligibility(task);
    const key = taskKey(task.id);
    if (seen.has(key)) continue;
    seen.add(key);
    if (task.executorId !== config.tbUserId || task.isDone || task.isArchived) throw new Error('发现阶段输入包含范围外任务，请核对查询和身份');
    if (index.has(key) || entries[key]?.pendingOp || config.ignoredTaskIds.includes(task.id) || config.watchedTasks.includes(task.id)) continue;
    const dates = [task.createdAt, task.updatedAt].map(x => typeof x === 'string' ? Date.parse(x) : NaN).filter(Number.isFinite);
    if (!dates.length) { validateTask(task); result.unknownDates.push(task); }
    else if (Math.max(...dates) < cutoff) result.excludedOld.push(task.id);
    else { validateTask(task); result.candidates.push(task); }
  }
  const groups = new Map();
  for (const task of result.candidates) {
    const group = task.parentId ?? task.id;
    groups.set(group, [...(groups.get(group) ?? []), task.id]);
  }
  result.groups = [...groups].map(([parentId, ids]) => {
    const parentTracked = index.has(taskKey(parentId));
    return { parentId, taskIds: ids, parentTracked, autoIntake: !parentTracked && ids.length === 1 };
  });
  result.autoIntakeIds = result.groups.filter(g => g.autoIntake).map(g => g.taskIds[0]);
  result.decisionGroups = result.groups.filter(g => !g.autoIntake);
  return result;
}

export function planTask(task, page, previous, config) {
  validateTask(task);
  const key = taskKey(task.id);
  if (previous?.pendingOp) throw new Error(`${key} 有未决操作，先对账`);
  const me = config.tbUserId;
  const watched = config.watchedTasks.includes(task.id);
  const next = structuredClone(previous ?? {
    trackingMode: watched ? 'watched' : task.executorId === me ? 'executor' : 'inactive',
    lastKnownExecutorId: task.executorId, autoCompletedByReassign: false,
  });
  const personal = page?.properties['个人状态'] ?? '待安排';
  if (!statuses.includes(personal)) throw new Error('个人状态不受支持');
  if (page && page.properties['来源标识'] !== key) throw new Error('页面来源与任务不一致');
  if (next.autoCompletedByReassign && personal !== '已完成') next.autoCompletedByReassign = false;
  let prevExecutor = next.lastKnownExecutorId;
  if (watched) {
    if (next.trackingMode !== 'watched') next.autoCompletedByReassign = false;
    next.trackingMode = 'watched';
  } else if (next.trackingMode === 'watched' || next.trackingMode === 'inactive') {
    next.trackingMode = task.executorId === me ? 'executor' : 'inactive';
    next.autoCompletedByReassign = false;
    prevExecutor = task.executorId;
  }
  const owner = task.executorId === null ? '未指派' : task.executorName || task.executorId;
  let snapshot = `${task.statusName} · ${owner}${task.shortId ? ` (${task.shortId})` : ''}`;
  let type = page ? 'snapshot' : 'create';
  let to = personal;
  const notices = [];
  if (page && next.trackingMode === 'executor') {
    if (prevExecutor === me && task.executorId !== null && task.executorId !== me) {
      snapshot = `已转派 · ${owner} (${task.statusName})`;
      if (personal !== '已完成') {
        type = 'auto_complete'; to = '已完成'; next.autoCompletedByReassign = true;
      }
    } else if (next.autoCompletedByReassign && personal === '已完成' && task.executorId === me && !task.isDone && !task.isArchived) {
      type = 'auto_reopen'; to = '待安排'; next.autoCompletedByReassign = false;
      notices.push('转回自己，自动重开为待安排');
    }
  }
  if ((watched || task.executorId === me) && (task.isDone || task.isArchived) && personal !== '已完成') notices.push('TB 已完结/归档，个人后续动作请确认收尾');
  if (previous?.trackingMode === 'inactive' && next.trackingMode === 'executor' && personal === '已完成' && !task.isDone && !task.isArchived) notices.push('任务现指派给自己，是否重开由用户决定');
  next.lastKnownExecutorId = task.executorId;
  const properties = { '来源状态': snapshot, '来源链接': `https://www.teambition.com/task/${task.id}` };
  if (Object.hasOwn(task, 'iteration')) {
    if (!(task.iteration === null || (typeof task.iteration === 'string' && task.iteration.trim()))) throw new Error('迭代必须是已核实的名称或明确无迭代的 null');
    properties['迭代'] = task.iteration;
  }
  if (!page) {
    Object.assign(properties, { '任务': task.title, '来源标识': key, '个人状态': to });
    if (task.dueDate) properties['date:截止时间:start'] = task.dueDate;
  } else if (type !== 'snapshot') properties['个人状态'] = to;
  const normalizeEmpty = v => (v === '' || v === undefined ? null : v);
  const unchanged = Boolean(
    page &&
    type === 'snapshot' &&
    notices.length === 0 &&
    Object.entries(properties).every(([field, value]) => JSON.stringify(normalizeEmpty(page.properties?.[field])) === JSON.stringify(normalizeEmpty(value)))
  );
  return { planId: randomUUID(), key, pageId: page?.pageId ?? null, type, unchanged, properties, before: page ? structuredClone(page.properties) : null, next, notices };
}

export function planPersonal(page, properties, previous, existingKey) {
  const allowed = ['任务', '来源链接', '个人状态', '个人顺序', '下一步动作', 'date:截止时间:start', 'date:截止时间:end', 'date:截止时间:is_datetime'];
  if (!properties || !Object.keys(properties).length || Object.keys(properties).some(x => !allowed.includes(x))) throw new Error('个人编辑包含范围外字段或为空');
  if ('个人状态' in properties && !statuses.includes(properties['个人状态'])) throw new Error('个人状态无效');
  if ('个人顺序' in properties && properties['个人顺序'] !== null && !Number.isFinite(properties['个人顺序'])) throw new Error('个人顺序必须为数字或 null');
  if (!page && (typeof properties['任务'] !== 'string' || !properties['任务'].trim())) throw new Error('新事项需要标题');
  const key = existingKey || page?.properties['来源标识'] || `MANUAL:${page?.pageId ?? randomUUID()}`;
  if (previous?.pendingOp) throw new Error('先处理未决操作');
  const next = structuredClone(previous ?? { trackingMode: 'inactive', lastKnownExecutorId: null, autoCompletedByReassign: false });
  if ('个人状态' in properties) next.autoCompletedByReassign = false;
  return { planId: randomUUID(), key, pageId: page?.pageId ?? null, type: page ? 'personal_edit' : 'create', unchanged: false, properties: { ...properties, ...(!page ? { '个人状态': properties['个人状态'] ?? '待安排' } : {}) }, before: page?.properties ?? null, next, notices: [] };
}

export function verifyPage(plan, page) {
  if (!page || !page.pageId) throw new Error('回读目标页面不一致');
  const actualId = normalizePageId(page.pageId);
  if (plan.pageId && actualId !== normalizePageId(plan.pageId)) throw new Error('回读目标页面不一致');
  if (plan.key.startsWith('TB:') && page.properties?.['来源标识'] !== plan.key) throw new Error('回读来源标识不一致');
  for (const [field, value] of Object.entries(plan.properties)) {
    if (JSON.stringify(page.properties?.[field] ?? null) !== JSON.stringify(value ?? null)) throw new Error(`回读字段不一致: ${field}`);
  }
}
