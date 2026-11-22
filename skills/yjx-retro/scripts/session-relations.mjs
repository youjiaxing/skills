// Read-only structural discovery. No task relevance or review-completion verdicts.
const prefix = "orchestration_v2_projection_";
const parse = (value) => { try { return JSON.parse(value || "{}"); } catch { return {}; } };
const time = (value) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export function discoverT3Relations(db, threadId, opts = {}) {
  const snapshotAt = new Date().toISOString();
  const requestedCutoff = time(opts.untilTime);
  if (opts.untilTime && requestedCutoff === null) throw new Error("Invalid relation cutoff timestamp");
  let cutoff = Math.min(requestedCutoff ?? time(snapshotAt), time(snapshotAt));
  const scope = opts.relationScope || "direct";
  if (!["direct", "closure"].includes(scope)) throw new Error("Relation scope must be direct or closure");
  const gaps = [];
  if (requestedCutoff > cutoff) gaps.push({ reason: "requested-cutoff-after-snapshot; limited-to-snapshot" });
  const prepare = (name, sql) => {
    try { return db.prepare(sql); }
    catch (err) { gaps.push({ reason: "relation-source-unavailable", source: name, detail: err.message }); return null; }
  };
  const threadQuery = prepare("threads", `SELECT thread_id,title,created_at,deleted_at,
    json_extract(payload_json,'$.lineage') lineage,
    json_extract(payload_json,'$.forkedFrom') forked_from
    FROM ${prefix}threads WHERE thread_id=?`) || prepare("threads-legacy", `SELECT thread_id,title,payload_json
    FROM ${prefix}threads WHERE thread_id=?`);
  const childQuery = prepare("thread-lineage", `SELECT thread_id FROM ${prefix}threads
    WHERE json_extract(payload_json,'$.lineage.parentThreadId')=?
       OR json_extract(payload_json,'$.forkedFrom.threadId')=?`);
  const runQuery = prepare("runs", `SELECT ordinal FROM ${prefix}runs WHERE thread_id=? AND run_id=?`);
  const rootRunQuery = prepare("turn-item-run-boundary", `SELECT r.ordinal FROM ${prefix}turn_items i
    JOIN ${prefix}runs r ON r.run_id=i.run_id AND r.thread_id=i.thread_id
    WHERE i.thread_id=? AND i.ordinal<=? ORDER BY i.ordinal DESC LIMIT 1`);
  const rootTimeQuery = prepare("turn-item-time-boundary", `SELECT ordinal,
    json_extract(payload_json,'$.startedAt') started_at FROM ${prefix}turn_items
    WHERE thread_id=? AND ordinal>? ORDER BY ordinal LIMIT 1`);
  const lastRootTimeQuery = prepare("turn-item-last-time", `SELECT ordinal,
    json_extract(payload_json,'$.startedAt') started_at FROM ${prefix}turn_items
    WHERE thread_id=? AND ordinal<=? ORDER BY ordinal DESC LIMIT 1`);
  const pointItemsQuery = prepare("relation-turn-items", `SELECT turn_item_id,run_id,ordinal,
    json_extract(payload_json,'$.subagentId') subagent_id,
    json_extract(payload_json,'$.messageId') message_id
    FROM ${prefix}turn_items WHERE thread_id=? ORDER BY ordinal`);
  const subagentQuery = prepare("subagents", `SELECT subagent_id,thread_id,run_id,child_thread_id,origin,started_at
    FROM ${prefix}subagents WHERE thread_id=? OR child_thread_id=?`);
  const subagentPointQuery = subagentQuery && prepare("subagent-parent-point", `SELECT subagent_id,run_id FROM ${prefix}subagents
    WHERE thread_id=? AND child_thread_id=? ORDER BY started_at LIMIT 1`);
  const transferQuery = prepare("context_transfers", `SELECT context_transfer_id,source_thread_id,target_thread_id,
    target_run_id,type,status,updated_at,payload_json FROM ${prefix}context_transfers
    WHERE source_thread_id=? OR target_thread_id=?`);
  const messageQuery = prepare("messages.senderThreadId", `SELECT message_id,thread_id,run_id,created_at,updated_at,
    json_extract(payload_json,'$.senderThreadId') sender_thread_id,
    json_extract(payload_json,'$.creationSource') creation_source
    FROM ${prefix}messages WHERE (thread_id=? AND json_extract(payload_json,'$.senderThreadId') IS NOT NULL)
       OR json_extract(payload_json,'$.senderThreadId')=?`);
  const nodes = new Map();
  const edges = new Map();
  const threads = new Map();
  const getThread = (id) => {
    if (!threads.has(id)) {
      const row = threadQuery?.get(id);
      const p = parse(row?.payload_json);
      threads.set(id, row ? { ...row, created_at: row.created_at || p.createdAt || null,
        deleted_at: row.deleted_at || p.deletedAt || null,
        lineage: row.lineage === undefined ? p.lineage || {} : parse(row.lineage),
        fork: row.forked_from === undefined ? p.forkedFrom || {} : parse(row.forked_from) } : null);
    }
    return threads.get(id);
  };
  const runOrdinal = (id, runId) => runId ? runQuery?.get(id, runId)?.ordinal ?? null : null;
  const pointItems = new Map();
  const itemsFor = (id) => {
    if (!pointItems.has(id)) {
      const index = { items: new Map(), subagents: new Map(), messages: new Map(), runEnds: new Map() };
      for (const row of pointItemsQuery?.all(id) || []) {
        index.items.set(row.turn_item_id, row);
        if (row.subagent_id) index.subagents.set(row.subagent_id, row);
        if (row.message_id) index.messages.set(row.message_id, row);
        if (row.run_id) index.runEnds.set(row.run_id, row.ordinal);
      }
      pointItems.set(id, index);
    }
    return pointItems.get(id);
  };
  const point = (id, runId, { itemId = null, subagentId = null, messageId = null, throughRun = false } = {}) => {
    const index = itemId || subagentId || messageId || throughRun ? itemsFor(id) : null;
    const item = index?.items.get(itemId) || index?.subagents.get(subagentId) || index?.messages.get(messageId);
    return { threadId: id, runOrdinal: runOrdinal(id, runId), itemId: item?.turn_item_id || itemId,
      itemOrdinal: item?.ordinal ?? (throughRun && runId ? index.runEnds.get(runId) ?? null : null) };
  };
  if (opts.untilOrdinal != null && requestedCutoff === null) {
    const after = time(rootTimeQuery?.get(threadId, opts.untilOrdinal)?.started_at);
    if (after !== null) cutoff = Math.min(cutoff, after);
    else {
      const last = time(lastRootTimeQuery?.get(threadId, opts.untilOrdinal)?.started_at);
      if (last !== null) cutoff = Math.min(cutoff, last + 1);
      gaps.push({ reason: last === null ? "root-cutoff-time-unavailable; supply --until-time" :
        "cutoff-derived-from-last-root-event; supply --until-time to cover concurrent work", threadId });
    }
  }
  const rootRunLimit = opts.untilOrdinal == null ? null : rootRunQuery?.get(threadId, opts.untilOrdinal)?.ordinal ?? null;
  if (opts.untilOrdinal != null && rootRunLimit === null) gaps.push({ reason: "root-run-cutoff-unresolved", threadId });
  const addNode = (id) => {
    if (!id) return false;
    if (nodes.has(id)) return true;
    const row = getThread(id);
    if (row && time(row.created_at) !== null && time(row.created_at) >= cutoff) return false;
    const node = { threadId: id, title: row?.title || null, createdAt: row?.created_at || null,
      deletedAt: row?.deleted_at || null, discovery: row ? "metadata-found" : "missing-thread",
      taskRelevance: "pending model confirmation", reviewStatus: "not-reviewed" };
    nodes.set(id, node);
    if (!row) gaps.push({ reason: "related-thread-unavailable", threadId: id });
    else if (time(row.created_at) === null) gaps.push({ reason: "thread-creation-time-unavailable", threadId: id });
    if (row?.deleted_at) gaps.push({ reason: time(row.deleted_at) < cutoff ? "thread-deleted-before-cutoff" :
      "thread-deleted-after-cutoff; current-projection-may-be-incomplete", threadId: id });
    return true;
  };
  const addEdge = (key, edge) => {
    if (!edge.from || !edge.to || edge.from === edge.to) return;
    const created = time(edge.createdAt);
    if (created !== null && created >= cutoff) return;
    // A parent's item ordinal is never applied to another thread. Run limits
    // only gate the root's own structural association points.
    const points = edge.associationPoints || [];
    if (opts.untilOrdinal != null && points.some((p) => p.threadId === threadId && p.itemOrdinal > opts.untilOrdinal)) return;
    if (rootRunLimit !== null && points.some((p) => p.threadId === threadId && p.runOrdinal > rootRunLimit)) return;
    if (!addNode(edge.from) || !addNode(edge.to)) return;
    if (edges.has(key)) return;
    edges.set(key, { ...edge, timeStatus: created === null ? "unknown" : "before-cutoff" });
    if (created === null) gaps.push({ reason: "relation-time-unavailable", source: edge.location });
    if (opts.untilOrdinal != null && points.some((p) => p.threadId === threadId && p.runOrdinal === null)) {
      gaps.push({ reason: "root-association-run-unresolved", source: edge.location });
    }
    if (opts.untilOrdinal != null && points.some((p) => p.threadId === threadId && p.itemOrdinal === null &&
      (rootRunLimit === null || p.runOrdinal === null || p.runOrdinal === rootRunLimit))) {
      gaps.push({ reason: "root-association-item-unresolved", source: edge.location });
    }
  };
  const addParent = (id) => {
    const row = getThread(id);
    if (!row) return null;
    const fork = row.fork;
    const parent = row.lineage.parentThreadId || fork.threadId;
    if (!parent) return null;
    const isFork = fork.threadId === parent;
    const dispatch = !isFork ? subagentPointQuery?.get(parent, id) : null;
    const through = isFork && fork.type === "run" ? runOrdinal(parent, fork.runId) : runOrdinal(parent, dispatch?.run_id);
    const sideChat = row.lineage.sideChat === true;
    const inherits = isFork && fork.type === "run" && !sideChat;
    const edge = { from: parent, to: id, kind: sideChat ? "side-chat" : isFork ? "fork" : row.lineage.relationshipToParent || "lineage",
      createdAt: row.created_at, location: `threads:${id}:lineage/forkedFrom`,
      inheritsVisibleHistory: inherits,
      sourcePoint: isFork ? { threadId: parent, runId: fork.runId || null, type: fork.type || null, throughRunOrdinal: through } : null,
      associationPoints: [point(parent, isFork ? fork.runId : dispatch?.run_id,
        { itemId: fork.turnItemId, subagentId: dispatch?.subagent_id, throughRun: isFork && fork.type === "run" })] };
    addEdge(`lineage:${id}`, edge);
    if (isFork && through === null) gaps.push({ reason: "fork-boundary-unresolved", threadId: id, source: edge.location });
    if (row.lineage.parentThreadId && fork.threadId && row.lineage.parentThreadId !== fork.threadId) {
      gaps.push({ reason: "lineage-fork-parent-mismatch", threadId: id });
    }
    return edge;
  };

  if (!addNode(threadId) || !getThread(threadId)) throw new Error(`T3 thread unavailable at cutoff: ${threadId}`);
  // Structural ancestors are not automatically inherited: side chats stop
  // visible-history inheritance, but their parents remain discovery candidates.
  const ancestors = [];
  const ancestorIds = new Set([threadId]);
  let cursor = threadId;
  let inherited = true;
  while (true) {
    const edge = addParent(cursor);
    if (!edge) break;
    if (ancestorIds.has(edge.from)) { gaps.push({ reason: "ancestor-cycle", threadId: edge.from }); break; }
    if (!addNode(edge.from)) break;
    inherited &&= edge.inheritsVisibleHistory;
    ancestors.push({ threadId: edge.from, childThreadId: cursor,
      throughRunOrdinal: edge.sourcePoint?.throughRunOrdinal ?? null,
      forkRunId: edge.sourcePoint?.runId || null, visibleHistoryInherited: inherited });
    ancestorIds.add(edge.from);
    cursor = edge.from;
  }
  const ancestorLimits = new Map(ancestors.filter((a) => a.visibleHistoryInherited).map((a) => [a.threadId, a.throughRunOrdinal]));
  const initial = [...ancestorIds];
  const queue = [...initial];
  const visited = new Set();
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (visited.has(id)) continue;
    visited.add(id);
    addParent(id);
    for (const row of childQuery?.all(id, id) || []) addParent(row.thread_id);
    for (const row of subagentQuery?.all(id, id) || []) {
      if (!row.child_thread_id) { gaps.push({ reason: "subagent-child-unavailable", source: `subagents:${row.subagent_id}` }); continue; }
      addEdge(`subagent:${row.subagent_id}`, { from: row.thread_id, to: row.child_thread_id, kind: "subagent",
        origin: row.origin, createdAt: row.started_at, location: `subagents:${row.subagent_id}`,
        associationPoints: [point(row.thread_id, row.run_id, { subagentId: row.subagent_id })] });
    }
    for (const row of transferQuery?.all(id, id) || []) {
      if (row.source_thread_id === row.target_thread_id) continue;
      const p = parse(row.payload_json);
      const source = p.sourcePoint || {};
      const consumedAt = time(p.consumedAt);
      addEdge(`transfer:${row.context_transfer_id}`, { from: row.source_thread_id, to: row.target_thread_id,
        kind: "context-transfer", transferType: row.type, createdAt: p.createdAt || null,
        consumedBeforeCutoff: consumedAt !== null && consumedAt < cutoff,
        statusAtCutoff: consumedAt !== null && consumedAt < cutoff ? "consumed" : "unverified",
        payloadUpdatedAfterCutoff: time(row.updated_at) !== null && time(row.updated_at) >= cutoff,
        sourcePoint: { ...source, throughRunOrdinal: runOrdinal(source.threadId || row.source_thread_id, source.runId) },
        basePoint: p.basePoint || null, targetRunId: row.target_run_id || null,
        location: `context_transfers:${row.context_transfer_id}`,
        associationPoints: [point(row.source_thread_id, source.runId, { itemId: source.turnItemId, throughRun: !source.turnItemId }),
          point(row.target_thread_id, row.target_run_id)] });
    }
    for (const row of messageQuery?.all(id, id) || []) {
      addEdge(`message:${row.message_id}`, { from: row.sender_thread_id, to: row.thread_id, kind: "thread-message",
        createdAt: row.created_at, creationSource: row.creation_source || null,
        messageId: row.message_id, runId: row.run_id,
        location: `messages:${row.thread_id}:${row.message_id}`,
        payloadUpdatedAfterCutoff: time(row.updated_at) !== null && time(row.updated_at) >= cutoff,
        // Message projections persist the receiving run, not the sending call.
        // Preserve that missing source position so an explicit wider time window
        // cannot silently certify the root's ordinal boundary on the sender side.
        associationPoints: [{ ...point(row.sender_thread_id, null), role: "sender" },
          { ...point(row.thread_id, row.run_id, { messageId: row.message_id }), role: "receiver" }] });
    }
    if (scope === "closure") {
      for (const nodeId of nodes.keys()) if (!visited.has(nodeId) && !queue.includes(nodeId)) queue.push(nodeId);
    }
  }
  for (const edge of edges.values()) {
    edge.withinInheritedRange = (edge.associationPoints || []).filter((p) => ancestorLimits.has(p.threadId)).map((p) => ({
      threadId: p.threadId, runOrdinal: p.runOrdinal,
      throughRunOrdinal: ancestorLimits.get(p.threadId),
      within: p.runOrdinal === null || ancestorLimits.get(p.threadId) === null ? null : p.runOrdinal <= ancestorLimits.get(p.threadId),
    }));
  }
  return { source: "t3_sqlite", threadId, scope, snapshotAt, untilTime: new Date(cutoff).toISOString(),
    cutoffOrdinal: opts.untilOrdinal ?? null, rootRunLimit, ancestors,
    discoveryStatus: gaps.length ? "candidates-found-with-gaps" : "candidates-found",
    reviewStatus: "not-reviewed", nodes: [...nodes.values()], edges: [...edges.values()], gaps,
    rule: "Structural candidates only; titles are current metadata. Direct scope expands the root and its ancestor chain once; closure follows all discovered relations. Ancestor limits describe inherited history, not task relevance. Side chats do not inherit visible parent history. Unknown timestamps/boundaries remain gaps; current projections cannot reconstruct every historical state. Neither discovery nor indexing establishes model review." };
}

export function formatSessionRelations(graph) {
  if (!graph.nodes) {
    return [`## Related Sessions (${graph.candidateCount} candidates; ${graph.scope}; preview only)`,
      `- ${graph.rule}`, `- Full list: ${graph.enumerateWith}`,
      ...graph.ancestors.map((a) => `- Ancestor ${a.threadId}: through run ${a.throughRunOrdinal ?? "unknown"}; visible history inherited=${a.visibleHistoryInherited}`),
      ...graph.candidatePreview.map((n) => `- Candidate ${n.threadId}: ${n.kinds.join(", ")}; not-reviewed`),
      ...graph.gaps.map((g) => `- GAP: ${g.reason} ${g.threadId || g.source || ""}`)].join("\n");
  }
  const lines = [`## Related Sessions (${graph.nodes.length} candidates; ${graph.scope})`,
    `- Cutoff: ${graph.untilTime}; review: ${graph.reviewStatus}`, `- ${graph.rule}`];
  for (const a of graph.ancestors) lines.push(`- Ancestor ${a.threadId}: through run ${a.throughRunOrdinal ?? "unknown"}; visible history inherited=${a.visibleHistoryInherited}`);
  for (const n of graph.nodes) lines.push(`- Candidate ${n.threadId} ${n.title || ""}: ${n.discovery}; ${n.reviewStatus}; relevance=${n.taskRelevance}`);
  for (const e of graph.edges) lines.push(`- ${e.kind}${e.transferType ? `/${e.transferType}` : ""} ${e.from} -> ${e.to} (${e.createdAt || "time unknown"}) ${e.location}${e.sourcePoint ? `; source through run ${e.sourcePoint.throughRunOrdinal ?? "unknown"}` : ""}${e.statusAtCutoff ? `; status at cutoff=${e.statusAtCutoff}, consumed before cutoff=${e.consumedBeforeCutoff}` : ""}${e.payloadUpdatedAfterCutoff ? "; payload updated after cutoff (historical content unverified)" : ""}${e.kind === "thread-message" && e.from === graph.threadId && graph.cutoffOrdinal != null ? "; sender ordinal unavailable (root cutoff unverified)" : ""}`);
  for (const g of graph.gaps) lines.push(`- GAP: ${g.reason} ${g.threadId || g.source || ""}`);
  return lines.join("\n");
}

export function summarizeSessionRelations(graph) {
  const kinds = new Map();
  for (const e of graph.edges) for (const id of [e.from, e.to]) {
    if (!kinds.has(id)) kinds.set(id, new Set());
    kinds.get(id).add(e.kind);
  }
  const candidates = graph.nodes.map((n) => ({ threadId: n.threadId, kinds: [...(kinds.get(n.threadId) || [])] }));
  // Preview the distinct relation types before filling remaining slots. The
  // complete list is deliberately opt-in, rather than hidden by truncation.
  const preview = new Map();
  for (const kind of ["side-chat", "fork", "thread-message", "context-transfer", "subagent"]) {
    const n = candidates.find((c) => c.threadId !== graph.threadId && c.kinds.includes(kind));
    if (n) preview.set(n.threadId, n);
  }
  for (const n of candidates) { if (preview.size >= 8) break; preview.set(n.threadId, n); }
  return { source: graph.source, threadId: graph.threadId, scope: graph.scope, snapshotAt: graph.snapshotAt,
    untilTime: graph.untilTime, cutoffOrdinal: graph.cutoffOrdinal, rootRunLimit: graph.rootRunLimit,
    ancestors: graph.ancestors, discoveryStatus: graph.discoveryStatus, reviewStatus: graph.reviewStatus,
    candidateCount: graph.nodes.length, relationEvidenceCount: graph.edges.length,
    candidatePreview: [...preview.values()], candidateListTruncated: preview.size < graph.nodes.length,
    enumerateWith: `--session-id ${graph.threadId} --relations-only --relation-scope ${graph.scope} --until-time ${graph.untilTime}${graph.cutoffOrdinal == null ? "" : ` --until-ordinal ${graph.cutoffOrdinal}`}`,
    gaps: graph.gaps, rule: graph.rule };
}
