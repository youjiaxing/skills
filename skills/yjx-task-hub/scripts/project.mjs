import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readJson, atomicJson } from './storage.mjs';

const kinds = new Set(['page', 'database', 'data-source', 'view']);
const own = (object, key) => Object.hasOwn(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const parentId = value => value === null ? null : id(value);
function id(value) {
  if (typeof value !== 'string' || !/^(?:(?:collection|view):\/\/)?(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value)) throw new Error('需要已核实的页面/数据源/view ID');
  const prefix = value.match(/^(?:collection|view):\/\//i)?.[0].toLowerCase() ?? '';
  const uuid = value.slice(prefix.length).toLowerCase().replaceAll('-', '');
  return prefix + [uuid.slice(0, 8), uuid.slice(8, 12), uuid.slice(12, 16), uuid.slice(16, 20), uuid.slice(20)].join('-');
}
function load(root) {
  const state = readJson(root, 'project-state.json', { version: 1, projects: {}, operations: {}, receipts: [] });
  if (state.version !== 1 || !record(state.projects) || !record(state.operations) || !Array.isArray(state.receipts)) throw new Error('项目日志格式不符，保持文件并核对');
  return state;
}
export function projectStatus(root) {
  const state = load(root);
  return { mode: 'project', projects: state.projects, pending: Object.values(state.operations), receipts: state.receipts };
}

function replaceContent(before, sections, edits) {
  if (typeof before !== 'string' || !Array.isArray(sections) || !Array.isArray(edits) || !edits.length) throw new Error('正文更新需完整正文、授权区段和精确替换');
  const ranges = sections.map(section => {
    if (typeof section !== 'string' || (section === '' && before !== '')) throw new Error('授权区段无效');
    const start = before.indexOf(section);
    if (start < 0 || (section && before.indexOf(section, start + 1) >= 0)) throw new Error('授权区段未唯一匹配');
    return [start, start + section.length];
  });
  const changes = edits.map(edit => {
    if (typeof edit.old !== 'string' || typeof edit.new !== 'string') throw new Error('正文替换需 old/new 字符串');
    if (!edit.old && (before !== '' || edits.length !== 1)) throw new Error('仅空白正文允许空锚点');
    const start = before.indexOf(edit.old), end = start + edit.old.length;
    if (start < 0 || (edit.old && before.indexOf(edit.old, start + 1) >= 0)) throw new Error('替换锚点未唯一匹配');
    if (!ranges.some(([a, b]) => start >= a && end <= b)) throw new Error('替换越过授权区段');
    return { start, end, value: edit.new };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < changes.length; i++) if (changes[i].start < changes[i - 1].end) throw new Error('替换区间重叠');
  let result = before;
  for (const change of changes.toReversed()) result = result.slice(0, change.start) + change.value + result.slice(change.end);
  return result;
}

// Journals local intent and receipts only. The caller reads/writes Notion through MCP.
export class ProjectCoordinator {
  constructor(root) {
    this.root = root;
    this.state = load(root);
    // No outbound request can precede dispatch. Dispatched entries survive restart.
    for (const [key, op] of Object.entries(this.state.operations)) if (op.phase === 'prepared') delete this.state.operations[key];
    this.save(this.state);
  }
  save(state) { atomicJson(this.root, 'project-state.json', state); this.state = state; }
  pending() { return Object.values(this.state.operations); }
  syncCoverage() { return null; }
  project(projectId) {
    const project = this.state.projects[id(projectId)];
    if (!project) throw new Error('项目尚未绑定，先核实目标页面');
    return project;
  }
  operation(opId) {
    const op = this.state.operations[opId];
    if (!op) throw new Error('项目操作不存在或已结束');
    return op;
  }
  requireAuthority(input) {
    if (input.confirmed !== true || !text(input.evidence)) throw new Error('需要已有授权及明确依据；confirmed 不能代替用户授权');
  }
  verifyLocation(projectId, targetId, current) {
    const project = this.project(projectId);
    const actualChain = [current, ...(current?.ancestors ?? [])];
    let expected = project.resources[targetId];
    let index = 0;
    while (expected) {
      const actual = actualChain[index++];
      const expectedParent = expected.parentId ?? project.parentId;
      if (!actual || id(actual.id) !== expected.id || parentId(actual.parentId) !== expectedParent) throw new Error('目标身份或父链已变化，停止项目写入并核对');
      expected = expected.parentId === null ? null : project.resources[expected.parentId];
    }
    if (index !== actualChain.length) throw new Error('读取的父链与项目范围不一致');
  }
  finish(op, input, acceptCurrent = false) {
    const actual = input.readback;
    if (!actual || (op.kind === 'content' ? typeof actual.state !== 'string' : !record(actual.state))) throw new Error('回读状态类型不符，保持未决');
    if (!acceptCurrent && !isDeepStrictEqual(actual.state, op.expected)) throw new Error('回读内容与拟写结果不一致，保持未决');
    const resourceId = id(actual.id);
    if (op.kind === 'create') {
      if (id(actual.parentId) !== op.targetId) throw new Error('创建结果不属于指定父节点');
      const [parent, ...ancestors] = actual.ancestors ?? [];
      this.verifyLocation(op.projectId, op.targetId, parent && { ...parent, ancestors });
      for (const p of Object.values(this.state.projects)) if (own(p.resources, resourceId)) throw new Error('创建 ID 已绑定到既有记录，需对账');
    } else this.verifyLocation(op.projectId, op.targetId, actual);
    const next = structuredClone(this.state);
    if (op.kind === 'create') next.projects[op.projectId].resources[resourceId] = {
      id: resourceId, kind: op.resourceKind, parentId: op.targetId, key: op.resourceKey,
    };
    const receipt = { opId: op.opId, projectId: op.projectId, resourceId, kind: op.kind, evidence: op.evidence, verifiedAt: new Date().toISOString() };
    if (op.kind === 'properties') receipt.changes = Object.fromEntries(Object.keys(op.patch).map(field => [field, { before: op.before[field] ?? null, after: actual.state[field] ?? null }]));
    if (acceptCurrent) {
      receipt.acceptedCurrent = true;
      receipt.reconciliationEvidence = input.evidence;
      if (op.kind === 'content') {
        const hash = value => createHash('sha256').update(value).digest('hex');
        receipt.differences = { expectedHash: hash(op.expected), actualHash: hash(actual.state) };
      } else receipt.differences = Object.fromEntries([...new Set([...Object.keys(op.expected), ...Object.keys(actual.state)])].filter(field => !isDeepStrictEqual(op.expected[field], actual.state[field])).map(field => [field, { expected: op.expected[field] ?? null, actual: actual.state[field] ?? null }]));
    }
    delete next.operations[op.opId];
    next.receipts = [...next.receipts, receipt].slice(-30);
    this.save(next);
    return { committed: true, receipt };
  }
  async handle(input) {
    if (input.action === 'status') return projectStatus(this.root);
    if (input.action === 'bind') {
      this.requireAuthority(input);
      const projectId = id(input.projectId);
      if (projectId.includes('://')) throw new Error('项目根必须是页面 ID');
      if (this.pending().some(op => op.projectId === projectId)) throw new Error('本项目有未决操作，先对账再补绑定');
      const next = structuredClone(this.state);
      if (!own(input, 'parentId')) throw new Error('需核实项目根的实际父节点；工作区根用 null');
      const rootParentId = parentId(input.parentId);
      const project = next.projects[projectId] ?? { parentId: rootParentId, resources: { [projectId]: { id: projectId, kind: 'page', parentId: null, key: 'root' } } };
      if (project.parentId !== rootParentId) throw new Error('项目根父节点已变化，先核对而非自动迁移');
      if (!Array.isArray(input.resources ?? [])) throw new Error('resources 需为已核实的节点列表');
      for (const resource of input.resources ?? []) {
        if (!kinds.has(resource.kind) || !text(resource.key)) throw new Error('节点需 kind 和稳定 key');
        const node = { id: id(resource.id), kind: resource.kind, parentId: id(resource.parentId), key: resource.key };
        if (own(project.resources, node.id) && !isDeepStrictEqual(project.resources[node.id], node)) throw new Error('禁止改绑既有节点');
        project.resources[node.id] = node;
      }
      const keys = new Set();
      for (const node of Object.values(project.resources)) {
        if (keys.has(node.key)) throw new Error('节点 key 重复，先核对已有记录');
        keys.add(node.key);
        const seen = new Set([node.id]);
        let ancestor = node;
        while (ancestor.parentId !== null) {
          if (seen.has(ancestor.parentId) || !own(project.resources, ancestor.parentId)) throw new Error('节点父链不完整或存在环');
          seen.add(ancestor.parentId); ancestor = project.resources[ancestor.parentId];
        }
        for (const [otherId, other] of Object.entries(next.projects)) if (otherId !== projectId && own(other.resources, node.id)) throw new Error('节点已属于其他项目');
      }
      next.projects[projectId] = project;
      this.save(next);
      return { bound: true, projectId, resources: project.resources };
    }
    if (input.action === 'prepare') {
      this.requireAuthority(input);
      const projectId = id(input.projectId), project = this.project(projectId), targetId = id(input.targetId);
      if (!own(project.resources, targetId)) throw new Error('目标不在本项目已核实的范围内');
      if (this.pending().some(op => op.projectId === projectId)) throw new Error('本项目有未决操作，其他项目不受影响');
      const op = { opId: randomUUID(), projectId, targetId, kind: input.kind, phase: 'prepared', evidence: input.evidence };
      if (input.kind === 'properties') {
        if (targetId === projectId) throw new Error('项目根属性走个人总清单路径，本路径只编辑根正文及项目内部记录');
        if (project.resources[targetId].kind !== 'page' || !record(input.before) || !record(input.patch) || !Object.keys(input.patch).length || !Array.isArray(input.allowedProperties)) throw new Error('属性更新需完整可写属性快照、补丁和字段白名单');
        for (const field of Object.keys(input.patch)) {
          if (!input.allowedProperties.includes(field)) throw new Error(`字段未授权: ${field}`);
          if (field.includes('人工') && !input.explicitHumanProperties?.includes(field)) throw new Error(`人工字段需用户明确点名: ${field}`);
        }
        op.before = input.before; op.patch = input.patch; op.expected = { ...input.before, ...input.patch };
      } else if (input.kind === 'content') {
        if (project.resources[targetId].kind !== 'page') throw new Error('正文更新目标必须为页面');
        op.before = input.before;
        op.edits = input.edits;
        op.expected = replaceContent(input.before, input.sections, input.edits);
      } else if (input.kind === 'create') {
        if (!kinds.has(input.resourceKind) || !text(input.resourceKey) || !record(input.expected) || !Object.keys(input.expected).length) throw new Error('创建需资源类型、稳定 key 和待核对的结构');
        const existing = Object.values(project.resources).find(node => node.key === input.resourceKey);
        if (existing) return { existing: true, resource: existing, requiresRead: true };
        op.resourceKind = input.resourceKind; op.resourceKey = input.resourceKey; op.expected = input.expected;
      } else throw new Error('项目操作只支持 properties、content、create');
      if (own(op, 'before') && isDeepStrictEqual(op.before, op.expected)) return { unchanged: true };
      const next = structuredClone(this.state); next.operations[op.opId] = op; this.save(next);
      return structuredClone(op);
    }
    const op = this.operation(input.opId);
    if (input.action === 'dispatch') {
      if (op.phase !== 'prepared') throw new Error('已经派发或结果未知，禁止重发');
      this.verifyLocation(op.projectId, op.targetId, input.current);
      if (op.kind === 'create') {
        if (input.absenceVerified !== true || input.inventoryComplete !== true) throw new Error('创建前需读完目标范围并确认无既有记录');
      } else if (!isDeepStrictEqual(input.current.state, op.before)) throw new Error('派发前目标已变化，取消 prepared 后重算');
      const next = structuredClone(this.state); next.operations[op.opId].phase = 'dispatched'; this.save(next);
      return { ...structuredClone(op), phase: 'dispatched', permitted: true };
    }
    if (input.action === 'commit') {
      if (op.phase !== 'dispatched' || input.apiSucceeded !== true) throw new Error('需要当前外部接口明确成功响应');
      return this.finish(op, input);
    }
    if (input.action === 'cancel') {
      if (op.phase !== 'prepared') throw new Error('已派发操作只能对账，不能取消');
      const next = structuredClone(this.state); delete next.operations[op.opId]; this.save(next); return { cancelled: true };
    }
    if (input.action === 'resolve') {
      this.requireAuthority(input);
      if (op.phase !== 'dispatched' || input.requestSettled !== true) throw new Error('需先确认原外部请求已经终结，单次未查到不构成未执行证据');
      if (input.outcome === 'applied') return this.finish(op, input);
      if (input.outcome === 'accept-current') {
        if (input.acceptCurrent !== true) throw new Error('采纳当前差异需用户明确确认，不能复用一般维护授权');
        return this.finish(op, input, true);
      }
      if (input.outcome !== 'not-applied' || input.noEffectVerified !== true) throw new Error('未执行需明确无副作用证据');
      if (op.kind !== 'create') {
        this.verifyLocation(op.projectId, op.targetId, input.readback);
        if (!isDeepStrictEqual(input.readback.state, op.before)) throw new Error('未执行的回读不等于原快照，需人工核对');
      }
      const next = structuredClone(this.state); delete next.operations[op.opId]; this.save(next); return { resolved: true, outcome: 'not-applied' };
    }
    throw new Error('未知项目操作');
  }
}
