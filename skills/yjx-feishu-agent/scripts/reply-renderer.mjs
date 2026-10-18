const DIRECTIVE = /^\s*<!--[ \t]*feishu:(text|post|card)[ \t]*-->\s*/i;

export function normalizeReplyMarkdown(input) {
  let text = String(input ?? '').replaceAll('\r\n','\n').trim();
  // Feishu markdown supports the useful subset below. Turn raw HTML into text
  // while retaining links; never send unsupported HTML as if it were Markdown.
  text = text.replace(/<((?!https?:\/\/)[^>]+)>/gi, (_, tag) => tag.startsWith('br') ? '\n' : '');
  text = text.replace(/^\s*#{1,6}\s+(.+)$/gm, '**$1**');
  text = text.replace(/^(\|.+\|\s*\n)(?:\|?\s*:?-+:?\s*\|)+\s*\n((?:\|.+\|\s*\n?)+)/gm,
    (_, header, rows) => `${header.split('|').filter(Boolean).map(x=>x.trim()).map(x=>`- ${x}`).join('\n')}\n${rows}`);
  text = text.replace(/\n{3,}/g, '\n\n');
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
  const bounded = text.length > 12000 ? `${text.slice(0, 12000)}\n\n（回答过长，完整内容请在 Codex 查看。）` : text;
  if (mode === 'text') return { msgType: 'text', content: { text: (match ? original.slice(match[0].length) : original).trim().slice(0, 12000) }, mode };
  if (mode === 'card') {
    const card = cardContent(text);
    if (card && Buffer.byteLength(JSON.stringify(card), 'utf8') <= 30000) return { msgType: 'interactive', content: card, mode };
  }
  return { msgType: 'post', content: { zh_cn: { content_v2: [[{ tag: 'md', content: bounded }]] } }, mode: 'post' };
}
