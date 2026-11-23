import { readFile } from 'node:fs/promises';
import { isMain } from './safe-output.mjs';

const CALLS = new Set(['tool_use', 'tool_result', 'tool_call', 'function_call',
  'function_call_output', 'command_execution', 'mcp_tool_call', 'mcp_call',
  'web_search', 'web_search_call', 'web_fetch', 'browser_call', 'computer_call', 'file_read', 'file_write',
  'server_tool_use', 'web_fetch_tool_result', 'web_search_tool_result', 'collab_agent_tool_call']);

export function parseStructuredTranscript(raw) {
  if (raw && typeof raw === 'object') return { records: [raw], parseErrors: 0 };
  const source = String(raw ?? '').trim();
  if (!source) return { records: [], parseErrors: 0 };
  try { return { records: [JSON.parse(source)], parseErrors: 0 }; } catch { /* JSONL */ }
  const records = [];
  let parseErrors = 0;
  for (const line of source.split(/\r?\n/).filter((value) => value.trim())) {
    try { records.push(JSON.parse(line)); } catch { parseErrors += 1; }
  }
  return { records, parseErrors };
}

function networkCount(value) {
  if (!value || typeof value !== 'object') return 0;
  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    if (['webSearchRequests', 'web_search_requests', 'webFetchRequests', 'web_fetch_requests', 'network_requests'].includes(key)
      && typeof child === 'number' && child > 0) count += child;
    else if (child && typeof child === 'object') count += networkCount(child);
  }
  return count;
}

export function analyzeTranscript(raw, { provider, complete = true } = {}) {
  const parsed = parseStructuredTranscript(raw);
  const envelope = parsed.records.length === 1 ? parsed.records[0] : null;
  const t3 = envelope?.provider === 't3';
  const records = t3 && Array.isArray(envelope.items) ? envelope.items : parsed.records;
  provider ??= t3 ? 't3'
    : records.some((r) => r?.type === 'thread.started') ? 'codex'
    : records.some((r) => r?.type === 'system' && r.subtype === 'init') ? 'claude'
    : records.some((r) => r?.type === 'init') ? 'gemini' : 'unknown';
  let started = false;
  let terminalStatus = null;
  let answer = '';
  let unknownEvents = 0;
  let malformed = parsed.parseErrors > 0;
  let turns = 0;
  let protocolError = false;
  let rateLimited = false;
  const findings = [];
  const add = (kind, index, type) => findings.push({ kind, index, type });
  const inspectCall = (node, index) => {
    if (!node || typeof node !== 'object') return;
    if (CALLS.has(node.type)) add('tool-or-external-call', index, node.type);
    if (Array.isArray(node.tool_calls) && node.tool_calls.length) add('tool-or-external-call', index, 'tool_calls');
    if (node.function_call) add('tool-or-external-call', index, 'function_call');
  };
  const begin = () => {
    if (started || terminalStatus !== null) protocolError = true;
    started = true;
  };
  const finish = (status) => {
    if (!started || terminalStatus !== null) protocolError = true;
    // A failure cannot be erased by a later success record.
    if (terminalStatus === null || status !== 'completed') terminalStatus = status;
  };

  if (provider === 't3') {
    const coverage = envelope?.coverage;
    complete = complete && t3 && coverage?.complete === true && coverage.hasMore === false
      && coverage.totalItems === records.length && records.length > 0;
    started = Boolean(envelope?.run?.id);
    terminalStatus = ['completed', 'failed', 'cancelled', 'interrupted'].includes(envelope?.run?.status)
      ? envelope.run.status : null;
    for (let index = 0; index < records.length; index += 1) {
      const item = records[index];
      if (!item || item.position !== index || item.textTruncated
        || item.runId !== envelope.run?.id) malformed = true;
      inspectCall(item, index);
      if (item?.type === 'error' && /\b429\b/.test(item.text ?? '')) rateLimited = true;
      if (item?.type === 'assistant_message' && typeof item.text === 'string') answer = item.text;
      if (!['user_message', 'assistant_message', 'reasoning', 'checkpoint', 'system_message']
        .includes(item?.type) && !CALLS.has(item?.type)) unknownEvents += 1;
    }
  } else {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record || typeof record !== 'object' || Array.isArray(record)) { malformed = true; continue; }
      inspectCall(record, index);
      const error = record.type === 'error' ? record : record.error;
      if (error && (error.httpStatus === 429 || /\b429\b/.test(error.message ?? ''))) rateLimited = true;
      inspectCall(record.item, index);
      const blocks = record.message?.content ?? record.content;
      if (Array.isArray(blocks)) blocks.forEach((block) => {
        inspectCall(block, index);
        if (!['text', 'thinking', 'redacted_thinking'].includes(block?.type) && !CALLS.has(block?.type)) unknownEvents++;
      });
      if (networkCount(record) > 0) add('network-call', index, 'usage');
      if (provider === 'codex') {
        if (record.type === 'thread.started') begin();
        else if (record.type === 'turn.started') {
          turns += 1; if (turns > 1 || !started || terminalStatus !== null) protocolError = true;
        }
        else if (record.type === 'turn.completed') { if (turns !== 1) protocolError = true; finish('completed'); }
        else if (record.type === 'turn.failed') finish('failed');
        else if (['item.started', 'item.updated', 'item.completed'].includes(record.type)) {
          const type = record.item?.type;
          if (type === 'agent_message' && record.type === 'item.completed') {
            if (!started || terminalStatus !== null) protocolError = true;
            if (typeof record.item.text === 'string') answer = record.item.text;
            else malformed = true;
          } else if (!['reasoning', 'error', 'todo_list'].includes(type) && !CALLS.has(type)) unknownEvents += 1;
        } else if (record.type !== 'error') unknownEvents += 1;
      } else if (provider === 'claude') {
        if (record.type === 'system' && record.subtype === 'init') begin();
        else if (record.type === 'assistant') { if (!started || terminalStatus !== null) protocolError = true; }
        else if (record.type === 'result') {
          finish(record.subtype === 'success' && record.is_error !== true ? 'completed' : 'failed');
          if (typeof record.result === 'string') answer = record.result;
        } else if (!['system', 'rate_limit_event', 'user'].includes(record.type)) unknownEvents += 1;
      } else if (provider === 'gemini') {
        if (record.type === 'init') begin();
        else if (record.type === 'message') {
          if (!started || terminalStatus !== null) protocolError = true;
          if (record.role === 'assistant' && typeof record.content === 'string') {
            answer = record.delta ? answer + record.content : record.content;
          }
        } else if (record.type === 'result') {
          finish(record.status === 'success' ? 'completed' : 'failed');
        } else if (record.type !== 'error' && !CALLS.has(record.type)) unknownEvents += 1;
      } else unknownEvents += 1;
    }
  }
  const auditable = complete && started && terminalStatus !== null && !malformed && !protocolError
    && records.length > 0 && unknownEvents === 0 && provider !== 'unknown';
  return {
    provider, terminalStatus: protocolError ? 'invalid' : terminalStatus, answer, protocolError,
    failureCode: rateLimited ? 'rate_limited' : terminalStatus && terminalStatus !== 'completed' ? 'execution_failed' : null,
    auditStatus: findings.length ? 'violation' : auditable ? 'clean' : 'unverified',
    auditable, records: records.length, parseErrors: parsed.parseErrors, unknownEvents, findings,
  };
}

export function auditTranscript(raw, options) {
  const { answer, ...audit } = analyzeTranscript(raw, options);
  return audit;
}

if (isMain(import.meta.url)) {
  const input = process.argv[2];
  if (!input) { console.error('缺少记录文件'); process.exitCode = 1; }
  else {
    try { console.log(JSON.stringify(auditTranscript(await readFile(input, 'utf8')), null, 2)); }
    catch { console.error('无法读取或解析记录文件'); process.exitCode = 1; }
  }
}
