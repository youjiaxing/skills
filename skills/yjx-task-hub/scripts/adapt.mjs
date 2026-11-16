// Convert verified TB responses into coordinator inputs without guessing missing facts.
export function adaptTasks({ tasks, statuses, sprints, members, projects, tbUserId, tbUserName }) {
  for (const [name, value] of Object.entries({ tasks, statuses, sprints, members, projects })) {
    if (!Array.isArray(value)) throw new Error(`${name} 必须是数组`);
  }
  const unique = (items, predicate, field) => {
    const matches = items.filter(predicate);
    if (matches.length !== 1 || typeof matches[0][field] !== 'string' || !matches[0][field].trim()) throw new Error(`${field} 未唯一匹配`);
    return matches[0][field];
  };
  const counts = new Map();
  for (const t of tasks) if (typeof t?.taskId === 'string') counts.set(t.taskId, (counts.get(t.taskId) ?? 0) + 1);
  const key = value => typeof value === 'string' && value.trim().length > 0;
  return tasks.map(t => {
    try {
      if (!/^[a-f0-9]{24}$/.test(t.taskId) || counts.get(t.taskId) !== 1) throw new Error('任务 ID 缺失或重复');
      if (typeof t.content !== 'string' || !t.content.trim() || !Object.hasOwn(t, 'executorId') || !(t.executorId === null || /^[a-f0-9]{24}$/.test(t.executorId)) || typeof t.isDone !== 'boolean' || typeof t.isArchived !== 'boolean') throw new Error('任务必需字段缺失');
      if (!key(t.projectId) || !key(t.tfsId)) throw new Error('项目或状态 ID 缺失');
      const statusName = unique(statuses, s => key(s.projectId) && key(s.id) && s.projectId === t.projectId && s.id === t.tfsId, 'name');
      const task = { id: t.taskId, title: t.content, executorId: t.executorId, isDone: t.isDone, isArchived: t.isArchived, statusName };
      const warnings = [];
      if (t.executorId !== null) {
        try {
          task.executorName = t.executorId === tbUserId ? tbUserName : unique(members, m => key(m.userId) && m.userId === t.executorId, 'name');
          if (!key(task.executorName)) throw new Error('本人姓名未核实');
        } catch (error) { delete task.executorName; warnings.push(`负责人姓名：${error.message}`); }
      }
      if (Object.hasOwn(t, 'sprintId')) {
        try {
          if (t.sprintId !== null && !key(t.sprintId)) throw new Error('迭代 ID 缺失');
          task.iteration = t.sprintId === null ? null : unique(sprints, s => key(s.projectId) && key(s.id) && s.projectId === t.projectId && s.id === t.sprintId, 'name');
        } catch (error) { warnings.push(`迭代：${error.message}`); }
      } else warnings.push('迭代：字段缺失');
      if (Number.isInteger(t.uniqueId)) {
        try { task.shortId = `${unique(projects, p => key(p.id) && p.id === t.projectId, 'uniqueIdPrefix')}-${t.uniqueId}`; }
        catch (error) { warnings.push(`项目编号：${error.message}`); }
      }
      for (const [source, target] of [['created', 'createdAt'], ['updated', 'updatedAt'], ['parentTaskId', 'parentId'], ['dueDate', 'dueDate']]) if (Object.hasOwn(t, source)) task[target] = t[source];
      return { id: t.taskId, task, warnings };
    } catch (error) { return { id: t?.taskId ?? null, error: error.message }; }
  });
}
