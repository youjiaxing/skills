import { randomUUID } from 'node:crypto';
import { readJson, atomicJson, validateConfig } from './storage.mjs';
import { taskKey, normalizePageId, normalizeExternalPage, indexPages, candidateTasks, planTask, planPersonal, verifyPage } from './engine.mjs';

export class Coordinator {
  constructor(root) {
    this.root = root;
    this.config = validateConfig(readJson(root, 'config.json'));
    this.state = readJson(root, 'state.json');
    if (this.state.version !== 1 || this.state.binding !== this.config.notionDataSourceId || !this.state.entries) throw new Error('本地状态版本/数据源绑定不符，先核对配置');
    this.plans = new Map();
    this.inventory = null;
    this.index = null;
    this.plannedKeys = new Set();
    this.candidatesChecked = false;
    // prepared is persisted before dispatch. No API call is allowed until dispatch returns.
    const recovered = structuredClone(this.state);
    for (const [key, entry] of Object.entries(recovered.entries)) {
      if (entry.pendingOp?.phase !== 'prepared') continue;
      if (!Object.hasOwn(entry.pendingOp, 'priorEntry')) throw new Error('旧 prepared 缺少提交前基线，需人工对账');
      if (entry.pendingOp.priorEntry === null) delete recovered.entries[key];
      else recovered.entries[key] = entry.pendingOp.priorEntry;
    }
    this.save(recovered); // Verify persistence before allowing external writes, even for a new session.
  }

  save(state) {
    atomicJson(this.root, 'state.json', state);
    this.state = state;
  }

  storeEntry(key, entry) {
    const next = structuredClone(this.state);
    if (entry === null) delete next.entries[key];
    else next.entries[key] = entry;
    this.save(next);
  }

  pending() {
    return Object.entries(this.state.entries).filter(([, e]) => e.pendingOp).map(([key, e]) => ({ key, ...e.pendingOp }));
  }

  syncCoverage() {
    if (!this.inventory || !this.index) return null;
    const trackedKeys = new Set([...this.index.keys(), ...this.config.watchedTasks.map(id => taskKey(id))]);
    const unplannedTrackedKeys = [...trackedKeys].filter(k => !this.plannedKeys.has(k));
    return {
      trackedTotal: trackedKeys.size,
      plannedCount: trackedKeys.size - unplannedTrackedKeys.length,
      unplannedTrackedKeys,
      candidatesChecked: this.candidatesChecked,
    };
  }

  clearPlansForKey(key) {
    for (const [id, plan] of this.plans.entries()) {
      if (plan.key === key) this.plans.delete(id);
    }
  }

  assertPageIdAvailable(key, pageId, expectedPageId = null) {
    const target = normalizePageId(pageId);
    for (const [otherKey, entry] of Object.entries(this.state.entries)) {
      if (otherKey !== key && entry?.pageId && normalizePageId(entry.pageId) === target) {
        throw new Error('页面 ID 已被其他记录占用');
      }
    }
    if (this.inventory) {
      for (const page of this.inventory) {
        if (normalizePageId(page.pageId) === target &&
            (expectedPageId === null || normalizePageId(expectedPageId) !== target ||
             (page.properties?.['来源标识'] && page.properties['来源标识'] !== key))) {
          throw new Error('页面 ID 已被其他记录占用');
        }
      }
    }
  }

  async handle(input) {
    switch (input.action) {
      case 'status': return { config: this.config, pending: this.pending(), entries: this.state.entries, syncCoverage: this.syncCoverage() };
      case 'inventory': {
        if (input.complete !== true || !Array.isArray(input.pages)) throw new Error('需要完整分页后的全库页面清单（complete:true）');
        const normalizedPages = input.pages.map(normalizeExternalPage);
        this.index = indexPages(normalizedPages);
        this.inventory = normalizedPages;
        this.plans.clear();
        this.plannedKeys.clear();
        this.candidatesChecked = false;
        return { pages: this.inventory.length, conflicts: [...this.index].filter(([, pages]) => pages.length > 1).map(([key, pages]) => ({ key, pageIds: pages.map(x => x.pageId) })), pending: this.pending() };
      }
      case 'configure': {
        if (input.confirmed !== true) throw new Error('配置变更需用户明确指令');
        if (!input.patch || Object.keys(input.patch).some(x => !['watchedTasks', 'ignoredTaskIds', 'activeWindowDays'].includes(x))) throw new Error('此入口只修改跟进/忽略名单与活跃窗口；数据源/账号绑定需单独迁移');
        if (this.pending().length) throw new Error('先对账未决操作再更改跟进配置');
        const config = validateConfig({ ...this.config, ...input.patch });
        atomicJson(this.root, 'config.json', config);
        this.config = config;
        this.plans.clear();
        this.plannedKeys.clear();
        this.candidatesChecked = false;
        return { configured: true };
      }
      case 'candidates': {
        this.requireInventory();
        if (input.complete !== true) throw new Error('TB 列表必须翻到终止 token');
        const out = candidateTasks(input.tasks, this.config, this.index, this.state.entries);
        this.candidatesChecked = true;
        return out;
      }
      case 'plan': {
        this.requireInventory();
        const key = taskKey(input.task?.id);
        const pages = this.index.get(key) ?? [];
        if (pages.length > 1) throw new Error('重复来源页面冲突，停止该项写入');
        const page = pages[0];
        const existing = this.state.entries[key];
        const plan = planTask(input.task, page, existing, this.config);
        if (plan.unchanged) {
          this.assertPageIdAvailable(key, page.pageId, page.pageId);
          this.clearPlansForKey(key);
          const needStore = !existing ||
            !existing.pageId ||
            normalizePageId(existing.pageId) !== normalizePageId(page.pageId) ||
            existing.trackingMode !== plan.next.trackingMode ||
            existing.lastKnownExecutorId !== plan.next.lastKnownExecutorId ||
            existing.autoCompletedByReassign !== plan.next.autoCompletedByReassign;
          if (needStore) {
            this.storeEntry(key, { ...plan.next, pageId: page.pageId, pendingOp: null });
          }
          this.plannedKeys.add(key);
          return { ...plan, unchanged: true, committed: true };
        }
        this.clearPlansForKey(key);
        this.plans.set(plan.planId, plan);
        this.plannedKeys.add(key);
        return plan;
      }
      case 'plan-personal': {
        this.requireInventory();
        const targetId = input.pageId ? normalizePageId(input.pageId) : null;
        const page = targetId ? this.inventory.find(p => normalizePageId(p.pageId) === targetId) : undefined;
        if (input.pageId && !page) throw new Error('页面不属于本库完整清单');
        const key = page?.properties['来源标识'];
        if (key && (this.index.get(key)?.length !== 1)) throw new Error('重复来源页面冲突');
        const existingKey = key || (page ? Object.keys(this.state.entries).find(k => this.state.entries[k].pageId && normalizePageId(this.state.entries[k].pageId) === targetId) : undefined);
        const plan = planPersonal(page, input.properties, this.state.entries[existingKey], existingKey);
        this.clearPlansForKey(plan.key);
        this.plans.set(plan.planId, plan);
        return plan;
      }
      case 'prepare': {
        const plan = this.plans.get(input.planId);
        if (!plan) throw new Error('计划不存在或清单已刷新，请重新 plan');
        if (this.state.entries[plan.key]?.pendingOp) throw new Error('该项有未决操作');
        if ((plan.type === 'create' || plan.type === 'personal_edit') && input.confirmed !== true) throw new Error('新记录/个人安排需用户明确指令');
        const priorEntry = structuredClone(this.state.entries[plan.key] ?? null);
        const entry = structuredClone(priorEntry ?? plan.next);
        entry.pendingOp = { opId: randomUUID(), phase: 'prepared', startedAt: new Date().toISOString(), ...plan, priorEntry };
        this.storeEntry(plan.key, entry);
        this.clearPlansForKey(plan.key);
        return { key: plan.key, ...entry.pendingOp };
      }
      case 'dispatch': {
        const [key, entry] = this.findOp(input.opId);
        const op = entry.pendingOp;
        if (op.phase !== 'prepared') throw new Error('请求已经派发或结果未知，禁止重发');
        if (op.pageId) {
          const targetId = normalizePageId(op.pageId);
          const page = input.currentPage != null
            ? normalizeExternalPage(input.currentPage)
            : this.inventory?.find(p => normalizePageId(p.pageId) === targetId);
          if (!page || normalizePageId(page.pageId) !== targetId || JSON.stringify(page.properties) !== JSON.stringify(op.before)) {
            throw new Error('派发前页面有变化，请取消 prepared 后重读/重算');
          }
        } else {
          if (input.noMatchConfirmed === false) throw new Error('创建前须确认没有匹配记录');
          if (op.key.startsWith('TB:') && (this.index?.get(op.key)?.length ?? 0) > 0) {
            throw new Error('清单中已存在同来源记录，请取消 prepared 后重算');
          }
        }
        const next = structuredClone(entry);
        next.pendingOp.phase = 'dispatched';
        this.storeEntry(key, next);
        return { opId: op.opId, key, pageId: op.pageId, properties: op.properties, permitted: true };
      }
      case 'commit': {
        const [key, entry] = this.findOp(input.opId);
        const op = entry.pendingOp;
        if (op.phase !== 'dispatched' || input.apiSucceeded !== true) throw new Error('需要当前请求明确成功响应，未知结果走 resolve');
        if (input.page != null && input.pageId != null && normalizePageId(input.pageId) !== normalizePageId(input.page?.pageId)) {
          throw new Error('回读目标页面不一致');
        }
        let committedPage;
        if (input.page != null) {
          committedPage = normalizeExternalPage(input.page);
          verifyPage(op, committedPage);
          this.assertPageIdAvailable(key, committedPage.pageId, op.pageId);
        } else {
          const rawPageId = input.pageId ?? op.pageId;
          if (!rawPageId) throw new Error('回读目标页面不一致');
          const canonicalId = normalizePageId(rawPageId);
          if (op.pageId && canonicalId !== normalizePageId(op.pageId)) throw new Error('回读目标页面不一致');
          this.assertPageIdAvailable(key, rawPageId, op.pageId);
          committedPage = {
            pageId: op.pageId ?? rawPageId,
            properties: { ...(op.before ? structuredClone(op.before) : {}), ...structuredClone(op.properties) },
          };
          verifyPage(op, committedPage);
        }
        let nextInventory, nextIndex;
        if (this.inventory) {
          const committedCanonical = normalizePageId(committedPage.pageId);
          nextInventory = this.inventory.filter(p => normalizePageId(p.pageId) !== committedCanonical);
          nextInventory.push(structuredClone(committedPage));
          nextIndex = indexPages(nextInventory);
        }
        this.storeEntry(key, { ...op.next, pageId: committedPage.pageId, pendingOp: null });
        if (nextInventory) { this.inventory = nextInventory; this.index = nextIndex; }
        this.clearPlansForKey(key);
        return { committed: true, pageId: committedPage.pageId, notices: op.notices };
      }
      case 'cancel': {
        const [key, entry] = this.findOp(input.opId);
        if (entry.pendingOp.phase !== 'prepared') throw new Error('已派发操作需人工对账 resolve');
        if (!Object.hasOwn(entry.pendingOp, 'priorEntry')) throw new Error('未决操作缺少原基线');
        this.storeEntry(key, entry.pendingOp.priorEntry);
        this.clearPlansForKey(key);
        return { cancelled: true };
      }
      case 'resolve': {
        const [key, entry] = this.findOp(input.opId);
        const op = entry.pendingOp;
        if (input.confirmed !== true) throw new Error('人工对账结论需用户明确确认');
        let next;
        if (input.outcome === 'adopt') {
          const resolvedPage = normalizeExternalPage(input.page);
          verifyPage(op, resolvedPage);
          this.assertPageIdAvailable(key, resolvedPage.pageId, resolvedPage.pageId);
          next = { ...op.next, pageId: resolvedPage.pageId, pendingOp: null };
        } else if (input.outcome === 'user_state' || input.outcome === 'not_applied') {
          // A cancellation cannot prove that a request already dispatched will never arrive.
          if (input.requestSettled !== true) throw new Error('先核实旧请求已终止/不会再落地，不能仅凭当前字段重试');
          if (input.outcome === 'not_applied') {
            if (!Object.hasOwn(op, 'priorEntry')) throw new Error('未决操作缺少原基线');
            next = op.priorEntry;
          } else {
            const resolvedPage = input.page ? normalizeExternalPage(input.page) : null;
            if (!resolvedPage || (op.pageId && normalizePageId(resolvedPage.pageId) !== normalizePageId(op.pageId)) || (key.startsWith('TB:') && resolvedPage.properties['来源标识'] !== key)) throw new Error('人工对账页面身份不符');
            if (!op.pageId && input.uniquePageConfirmed !== true) throw new Error('创建对账需核实唯一来源页面');
            this.assertPageIdAvailable(key, resolvedPage.pageId, resolvedPage.pageId);
            if (!(input.currentExecutorId === null || /^[a-f0-9]{24}$/.test(input.currentExecutorId))) throw new Error('需核实当前负责人');
            const trackingMode = this.config.watchedTasks.includes(key.slice(3)) ? 'watched' : input.currentExecutorId === this.config.tbUserId ? 'executor' : 'inactive';
            next = { ...op.next, trackingMode, pageId: resolvedPage.pageId, autoCompletedByReassign: false, lastKnownExecutorId: input.currentExecutorId, pendingOp: null };
          }
        } else throw new Error('outcome 仅支持 adopt/user_state/not_applied，未确认则保持阻断');
        this.storeEntry(key, next);
        this.plans.clear();
        this.plannedKeys.clear();
        this.candidatesChecked = false;
        this.inventory = null;
        this.index = null; // Reconciliation may have adopted a previously unseen page.
        return { resolved: true, key };
      }
      default: throw new Error('未知 action');
    }
  }

  requireInventory() { if (!this.inventory) throw new Error('先提交完整 inventory'); }
  findOp(id) {
    const matches = Object.entries(this.state.entries).filter(([, e]) => e.pendingOp?.opId === id);
    if (matches.length !== 1) throw new Error('未决操作 ID 不存在或不唯一');
    return matches[0];
  }
}
