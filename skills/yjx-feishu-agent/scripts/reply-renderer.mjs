const DIRECTIVE = /^\s*<!--[ \t]*feishu:(text|post|card)[ \t]*-->\s*/i;

function truncateUtf8(text, maxBytes, suffix = '\n\n（回答过长，完整内容请在 Codex 查看。）') {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const limit = Math.max(0, maxBytes - suffixBytes);
  let end = Math.min(text.length, limit);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > limit) end -= 1;
  return `${text.slice(0, end)}${suffix}`;
}

export function normalizeReplyMarkdown(input) {
  let text = String(input ?? '').replaceAll('\r\n','\n').trim();
  // Keep code and inline comparisons literal while normalizing the supported subset.
  const protectedParts = [];
  text = text.replace(/```[\s\S]*?```|`[^`\n]+`/g, value => {
    const key = `\u0000FEISHU_CODE_${protectedParts.length}\u0000`;
    protectedParts.push(value);
    return key;
  });
  // Strip only recognizable HTML tags. A bare < or > remains ordinary text.
  text = text.replace(/<\/?(?:br|p|div|span|strong|em|b|i|u)(?:\s[^>]*)?>/gi, match =>
    /^<br\b/i.test(match) ? '\n' : '');
  text = text.replace(/^\s*#{1,6}\s+(.+)$/gm, '**$1**');
  // Convert simple tables into labeled bullets without dropping cell values.
  text = text.replace(/((?:^\|[^\n]+\|[ \t]*\n?)+)/gm, block => {
    const rows = block.trim().split('\n').map(row => row.split('|').slice(1, -1).map(cell => cell.trim()));
    if (rows.length < 2 || !rows[1].every(cell => /^:?-{1,}:?$/.test(cell))) return block;
    const headers = rows[0];
    return rows.slice(2).map(row => `- ${row.map((cell, i) => headers[i] ? `${headers[i]}：${cell}` : cell).join('；')}`).join('\n') + '\n';
  });
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/\u0000FEISHU_CODE_(\d+)\u0000/g, (_, index) => protectedParts[Number(index)]);
  return text;
}

function cardTitle(text) {
  const first = text.split('\n').find(line => line.trim())?.trim() ?? 'Codex 回复';
  return first.replace(/^\*+|\*+$/g, '').slice(0, 80) || 'Codex 回复';
}

function cardContent(text) {
  const blocks = text.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
  if (!blocks.length) return null;
  const elements = blocks.slice(0, 20).map((content, index) => ({
    tag: 'markdown', content, element_id: `section${index + 1}`,
  }));
  if (blocks.length > 20) elements.push({ tag: 'markdown', content: '（后续内容请在 Codex 会话查看。）', element_id: 'tail' });
  return { schema: '2.0', config: { update_multi: true, width_mode: 'default' },
    header: { title: { tag: 'plain_text', content: cardTitle(text) }, template: 'blue' },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px', elements } };
}

function classify(text) {
  const lines=text.split('\n');
  if (/```[\s\S]*```/.test(text) || lines.some(line => /^(?:Traceback|Error:| at |npm ERR!|\[[A-Z]+\]|日志[:：])/.test(line.trim()))) return 'text';
  const headings=lines.filter(line => /^\s*\*\*[^*]{2,50}\*\*[:：]?\s*$/.test(line) || /^\s*#{1,6}\s+/.test(line)).length;
  const bullets=lines.filter(line => /^\s*(?:[-*]|\d+[.)])\s+/.test(line)).length;
  const labels=/(结论|关键发现|证据|风险|建议|下一步|来源|评测结果|处理结果)/.test(text);
  if (headings >= 2 && (labels || bullets >= 2)) return 'card';
  return 'post';
}

export function renderReply(answer) {
  const original = String(answer ?? '');
  const match = original.match(DIRECTIVE);
  const requested = match?.[1]?.toLowerCase() ?? null;
  const text = normalizeReplyMarkdown(match ? original.slice(match[0].length) : original);
  const mode = requested ?? classify(text);
  const bounded = truncateUtf8(text, 12000);
  if (mode === 'text') return { msgType: 'text', content: { text: truncateUtf8((match ? original.slice(match[0].length) : original).trim(), 12000) }, mode };
  if (mode === 'card') {
    const card = cardContent(text);
    if (card && Buffer.byteLength(JSON.stringify(card), 'utf8') <= 30000) return { msgType: 'interactive', content: card, mode };
  }
  return { msgType: 'post', content: { zh_cn: { content: [[{ tag: 'md', text: bounded }]] } }, mode: 'post' };
}
