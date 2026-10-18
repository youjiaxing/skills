import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReplyMarkdown, renderReply } from '../scripts/reply-renderer.mjs';

test('ordinary answers become post content and supported formatting survives', () => {
  const rendered = renderReply('# 结论\n\n**重点**：已完成\n\n- 一项\n- 二项');
  assert.equal(rendered.msgType, 'post');
  assert.match(rendered.content.zh_cn.content_v2[0][0].content, /\*\*结论\*\*/);
  assert.match(rendered.content.zh_cn.content_v2[0][0].content, /\*\*重点\*\*/);
});

test('code and logs can explicitly remain literal text', () => {
  const rendered = renderReply('<!-- feishu:text -->\n```json\n{"ok":true}\n```');
  assert.equal(rendered.msgType, 'text');
  assert.match(rendered.content.text, /```json/);
  assert.doesNotMatch(rendered.content.text, /feishu:text/);
});

test('structured card directive is invisible and produces a bounded card', () => {
  const rendered = renderReply('<!-- feishu:card -->\n评测结论\n\n**结果**\n第二名');
  assert.equal(rendered.msgType, 'interactive');
  assert.equal(rendered.content.schema, '2.0');
  assert.equal(rendered.content.config.update_multi, true);
  assert.equal(rendered.content.body.elements.length, 2);
  assert.doesNotMatch(JSON.stringify(rendered.content), /feishu:card/);
});

test('structured content is promoted by content shape without a length threshold', () => {
  const rendered = renderReply('**结论**\n\n- 关键发现\n- 风险\n\n**建议**\n\n继续核验');
  assert.equal(rendered.msgType,'interactive');
});

test('unsupported headings and excess spacing are normalized for post fallback', () => {
  const text = normalizeReplyMarkdown('### 标题\n\n\n正文\n\n|项|值|\n|-|-|\n|A|B|');
  assert.match(text, /\*\*标题\*\*/);
  assert.doesNotMatch(text, /###/);
  assert.doesNotMatch(text, /\n{3,}/);
});

test('oversized or empty card safely falls back to post', () => {
  const rendered = renderReply(`<!-- feishu:card -->\n${'段落 '.repeat(12000)}`);
  assert.equal(rendered.msgType, 'post');
});
