import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReplyMarkdown, renderReply } from '../scripts/reply-renderer.mjs';

test('normalization preserves code spans and comparison operators', () => {
  const normalized = normalizeReplyMarkdown('请使用 `List<T>`，条件 `x < y && y > z`。');
  assert.match(normalized, /List<T>/);
  assert.match(normalized, /x < y && y > z/);
});

test('simple tables retain every cell when converted to bullets', () => {
  const normalized = normalizeReplyMarkdown('| 项 | 值 |\n| --- | --- |\n| A | B |');
  assert.match(normalized, /项：A/);
  assert.match(normalized, /值：B/);
});

test('long post replies are UTF-8 bounded and explain truncation', () => {
  const rendered = renderReply('中'.repeat(10000));
  const text = rendered.content.zh_cn.content[0][0].text;
  assert.ok(Buffer.byteLength(text, 'utf8') <= 12000);
  assert.match(text, /完整内容请在 Codex 查看/);
});

test('ordinary answers use the outbound post protocol shape', () => {
  const rendered = renderReply('普通回复');
  assert.equal(rendered.msgType, 'post');
  assert.equal(rendered.content.zh_cn.content[0][0].tag, 'md');
  assert.equal(typeof rendered.content.zh_cn.content[0][0].text, 'string');
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


test('oversized or empty card safely falls back to post', () => {
  const rendered = renderReply(`<!-- feishu:card -->\n${'段落 '.repeat(12000)}`);
  assert.equal(rendered.msgType, 'post');
});
