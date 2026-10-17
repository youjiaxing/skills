import { createHash } from 'node:crypto';

// Incoming event bodies and queried card bodies use different shapes.
export function decodeBody(message) {
  try { return JSON.parse(message.body?.content ?? message.content); } catch { return null; }
}

export function bodyText(message, botId) {
  if (message.deleted) return '[消息已撤回或删除]';
  const body = decodeBody(message);
  if (!body) return '[消息正文不可解析]';
  const type = message.msg_type ?? message.message_type;
  if (type === 'text') return typeof body.text === 'string' ? body.text : '';
  if (type === 'image') return '[图片]';
  if (!['post', 'interactive'].includes(type)) return `[${type ?? '未知'}消息]`;
  function walk(node) {
    if (typeof node === 'string') return '';
    if (Array.isArray(node)) return node.map(walk).filter(Boolean).join('\n');
    if (!node || typeof node !== 'object') return '';
    if (node.tag === 'at') {
      const mentioned=(message.mentions ?? []).find(m=>m.key===node.user_id);
      const id=mentioned ? (typeof mentioned.id==='string' ? mentioned.id : mentioned.id?.open_id) : node.user_id;
      if (botId && id===botId) return '';
      const name=node.user_name || mentioned?.name || id || '成员';
      return name.startsWith('@') ? name : `@${name}`;
    }
    if (node.tag === 'img') return '[图片]';
    if (['text','a','md','markdown','lark_md','plain_text','code_block'].includes(node.tag)) {
      return [typeof node.text === 'string' ? node.text : '', typeof node.content === 'string' ? node.content : '', node.href ?? ''].filter(Boolean).join(' ');
    }
    return Object.entries(node).filter(([k]) => ['title','text','content','content_v2','elements','body','header','zh_cn','en_us'].includes(k))
      .map(([,v]) => typeof v === 'string' ? v : walk(v)).filter(Boolean).join('\n');
  }
  // post content_v2 preserves md nodes; never duplicate its older representation.
  if (type === 'post') {
    const doc = body.zh_cn ?? body.en_us ?? body;
    return [doc.title ?? '', walk(doc.content_v2 ?? doc.content)].filter(Boolean).join('\n');
  }
  return walk(body);
}

export function imageKeys(message) {
  if (message.deleted) return [];
  const keys = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [k,v] of Object.entries(value)) {
      if (['image_key','img_key'].includes(k) && typeof v === 'string' && /^img_[\w-]+$/.test(v)) keys.add(v);
      else if (typeof v === 'object') visit(v);
    }
  }
  visit(decodeBody(message));
  return [...keys];
}

export function messageView(message) {
  return { messageId: message.message_id, chatId: message.chat_id, type: message.msg_type ?? message.message_type,
    parentId: message.parent_id, rootId: message.root_id, threadId: message.thread_id,
    createTime: message.create_time, sender: message.sender, deleted: Boolean(message.deleted),
    text: bodyText(message).slice(0,12000), imageKeys: imageKeys(message) };
}

// Compare content before display truncation. Event and query mention shapes differ.
export function messageVersion(message) {
  const mentions=(message.mentions ?? []).map(m=>({ ...m,
    id:typeof m.id==='string' ? m.id : m.id?.open_id }));
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value!=='object') return value;
    if (value.tag==='at') {
      const id=mentions.find(m=>m.key===value.user_id)?.id ?? value.user_id;
      return {tag:'at',user_id:id,user_name:id};
    }
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,canonical(v)]));
  }
  const normalized={...message,body:{content:JSON.stringify(canonical(decodeBody(message)))},
    mentions:mentions.map(m=>({...m,name:m.id}))};
  let text=bodyText(normalized);
  if ((message.msg_type ?? message.message_type)==='text') {
    for (const m of mentions) if (m.key && m.id) text=text.split(m.key).join(`@${m.id}`);
  }
  return createHash('sha256').update(JSON.stringify({type:message.msg_type ?? message.message_type,
    text,images:imageKeys(message).sort(),deleted:Boolean(message.deleted)})).digest('hex');
}

export function versionReceipt(message) {
  return {messageId:message.message_id,version:messageVersion(message),observedAt:Date.now()};
}
