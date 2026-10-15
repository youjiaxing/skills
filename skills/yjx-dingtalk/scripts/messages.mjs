/**
 * Message content is a JSON document whose shape varies by contentType. The
 * parser reports what it could read and marks anything else unresolved rather
 * than presenting an empty string as a complete parse.
 */
const TYPE_LABELS = new Map([
  [1, 'text'],
  [2, 'image'],
  [102, 'file'],
  [202, 'voice'],
  [300, 'link'],
  [500, 'oa'],
  [501, 'file'],
  [503, 'file'],
  [901, 'redenvelope'],
  [906, 'redenvelope'],
  [1101, 'call'],
  [1200, 'markdown'],
  [1201, 'actioncard'],
  [1202, 'markdown'],
  [1400, 'doc'],
  [1500, 'mergedforward'],
  [1600, 'dingcard'],
  [2900, 'groupnotice'],
  [2950, 'interactive'],
  [3100, 'miniapp'],
]);

export function labelForContentType(contentType) {
  return TYPE_LABELS.get(contentType) ?? 'unresolved';
}

function safeParse(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Extract text a person would read, plus any OCR text that already exists locally. */
export function parseContent(row) {
  const raw = row.content;
  const parsed = safeParse(raw);
  const result = {
    contentType: row.contentType ?? null,
    kind: labelForContentType(row.contentType),
    text: null,
    ocrText: null,
    ocrSource: null,
    unresolved: false,
    notes: [],
  };
  if (parsed === null) {
    if (typeof raw === 'string' && raw.trim() !== '') {
      result.text = raw;
      result.notes.push('content is not JSON; returned verbatim');
    } else {
      result.unresolved = true;
      result.notes.push('content is empty or not parseable');
    }
    collectOcr(row.attachments, result);
    return result;
  }
  if (typeof parsed.text === 'string') result.text = parsed.text;
  else if (typeof parsed.markdown === 'string') result.text = parsed.markdown;
  else if (typeof parsed.summary === 'string') result.text = parsed.summary;
  else if (typeof parsed.desc === 'string') result.text = parsed.desc;
  if (result.text === null) {
    const fromAttachments = extractAttachmentText(parsed.attachments, result);
    if (fromAttachments !== null) result.text = fromAttachments;
    else if (Array.isArray(parsed.attachments) && parsed.attachments.length > 0) {
      result.notes.push('attachment carries no directly readable text field');
    }
  }
  collectOcr(row.attachments ?? raw, result);
  if (result.text === null && result.ocrText === null && result.kind === 'unresolved') {
    result.unresolved = true;
  }
  return result;
}

/**
 * Card, markdown, link and file messages keep their human-readable text inside
 * each attachment's own JSON extension, so reaching it takes a second parse.
 */
function extractAttachmentText(attachmentsField, result) {
  const outer = typeof attachmentsField === 'string' ? safeParse(attachmentsField) : attachmentsField;
  const list = Array.isArray(outer) ? outer : (outer && Array.isArray(outer.attachments) ? outer.attachments : []);
  const parts = [];
  for (const attachment of list) {
    if (!attachment) continue;
    const extension = typeof attachment.extension === 'string' ? safeParse(attachment.extension) : null;
    if (!extension) continue;
    for (const key of ['markdown', 'text', 'content', 'desc', 'title', 'b_tl', 'summary', 'dingContent']) {
      const value = extension[key];
      if (typeof value === 'string' && value.trim() !== '') parts.push(value);
    }
    if (typeof extension.btn_json === 'string') {
      const buttons = safeParse(extension.btn_json);
      if (Array.isArray(buttons)) {
        for (const button of buttons) {
          if (button && typeof button.title === 'string') parts.push(button.title);
        }
      }
    }
  }
  if (parts.length === 0) return null;
  result.notes.push('text read from attachment extension');
  return parts.join('\n');
}
/**
 * Already-recognized image text is stored inside an attachment's own JSON
 * extension field, so it takes two parses to reach. Its absence only means no
 * text was found locally; it is not evidence that the image has no text.
 */
function collectOcr(attachmentsField, result) {
  const outer = typeof attachmentsField === 'string' ? safeParse(attachmentsField) : attachmentsField;
  const list = Array.isArray(outer) ? outer : (outer && Array.isArray(outer.attachments) ? outer.attachments : []);
  for (const attachment of list) {
    if (!attachment || typeof attachment.extension !== 'string') continue;
    const extension = safeParse(attachment.extension);
    if (!extension) continue;
    const value = extension.photo_content_ocr;
    if (typeof value === 'string' && value.trim() !== '') {
      result.ocrText = value;
      result.ocrSource = 'attachments[].extension.photo_content_ocr';
      return;
    }
  }
}

/** Attachment summary with no full payload, so output stays bounded by design. */
export function summariseAttachments(attachmentsField) {
  const outer = typeof attachmentsField === 'string' ? safeParse(attachmentsField) : attachmentsField;
  const list = Array.isArray(outer) ? outer : [];
  return list.map((attachment) => {
    const extension = typeof attachment.extension === 'string' ? safeParse(attachment.extension) : null;
    const meta = { hasExtension: Boolean(extension) };
    if (extension) {
      for (const key of ['f_name', 'file_name', 'desc', 'title', 'b_tl', 'source_url']) {
        if (typeof extension[key] === 'string' && extension[key] !== '') meta[key] = extension[key];
      }
      if (typeof extension.markdown === 'string') meta.markdownPreview = extension.markdown.slice(0, 200);
    }
    if (typeof attachment.filepath === 'string' && attachment.filepath !== '') meta.filepath = attachment.filepath;
    return meta;
  });
}

/**
 * A recalled message exposes metadata only. Body, raw structure, OCR, quoted and
 * card text, search excerpts and context all obey the same limit, so no channel
 * can leak the withdrawn body.
 */
export function isRecalled(row) {
  return Number(row.recallStatus ?? 0) !== 0;
}

export function renderMessage(row, { timeZone = 'Asia/Shanghai', full = true } = {}) {
  const recalled = isRecalled(row);
  const message = {
    accountId: row.accountId ?? null,
    conversationId: row.cid,
    messageId: String(row.mid),
    shard: row.shard ?? null,
    senderId: row.senderId === null || row.senderId === undefined ? null : String(row.senderId),
    senderName: row.senderName ?? null,
    type: row.type ?? null,
    contentType: row.contentType ?? null,
    kind: labelForContentType(row.contentType),
    createdAt: row.createdAt ?? null,
    createdAtLocal: formatTime(row.createdAt, timeZone),
    recalled,
  };
  if (recalled) {
    message.parseState = 'metadata-only (recalled)';
    message.contentSource = null;
    return message;
  }
  const parsed = parseContent(row);
  message.parseState = parsed.unresolved ? 'unresolved' : 'parsed';
  message.contentSource = parsed.ocrText ? 'message content + local OCR reuse' : 'message content';
  message.text = parsed.text;
  if (parsed.ocrText) message.ocr = { source: parsed.ocrSource, text: parsed.ocrText };
  message.attachments = summariseAttachments(row.attachments);
  if (parsed.notes.length > 0) message.notes = parsed.notes;
  if (!full && typeof message.text === 'string' && message.text.length > 400) {
    message.text = message.text.slice(0, 400);
    message.textTruncated = true;
  }
  return message;
}

/** Wall-clock formatting in an explicit zone, never the host default. */
export function formatTime(value, timeZone = 'Asia/Shanghai') {
  if (value === null || value === undefined) return null;
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(date);
  return parts + ' ' + timeZone;
}

export function renderLines(messages, options) {
  const lines = [];
  for (const row of messages) {
    const message = renderMessage(row, options);
    const head = '[' + (message.createdAtLocal ?? 'unknown time') + '] ' +
      (message.senderName ?? ('uid:' + (message.senderId ?? 'unknown'))) +
      ' (' + message.kind + ')' + (message.recalled ? ' [recalled]' : '');
    lines.push(head);
    if (message.text) lines.push('  ' + String(message.text).replace(/\n/g, '\n  '));
    if (message.ocr) lines.push('  [ocr: ' + message.ocr.source + '] ' + String(message.ocr.text).slice(0, 500));
    if (message.parseState === 'unresolved') lines.push('  (unresolved content; no readable text derived)');
    if (message.attachments && message.attachments.length > 0) {
      lines.push('  attachments: ' + message.attachments.map((a) => a.f_name ?? a.title ?? a.desc ?? 'item').join(', '));
    }
  }
  return lines.join('\n');
}
