import { parseRetryAfterHeaders } from './feishu-rate-limit.mjs';

// Dedicated abortable transport: marker calls never change the SDK's timeout.
export function reactionTransport({ appId, appSecret }, { fetchImpl = fetch, timeoutMs = 3000, rateLimiter = null } = {}) {
  let token, expiresAt = 0;
  function rejected(response, body) {
    const error = new Error('Reaction API failed');
    if (Number.isSafeInteger(body?.code)) error.apiCode = body.code;
    if (Number.isSafeInteger(body?.code) && body.code !== 0) error.notSent = true;
    if (Number.isSafeInteger(response.status)) error.httpStatus = response.status;
    const retryAfterMs = parseRetryAfterHeaders(response.headers);
    if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
    return error;
  }
  const runWrite = fn => rateLimiter
    ? rateLimiter.execute(fn, { maxRetries: timeoutMs >= 3000 ? 2 : 0, maxOperationMs:10000, attemptHeadroomMs:timeoutMs })
    : fn();
  async function request(messageId, { method = 'GET', emoji, reactionId, pageToken, signal }) {
    if (!token || Date.now() >= expiresAt) {
      const response = await fetchImpl('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method:'POST', headers:{'Content-Type':'application/json'}, signal,
        body:JSON.stringify({app_id:appId, app_secret:appSecret}),
      });
      const body = await response.json();
      if (!response.ok || body.code !== 0 || !body.tenant_access_token) throw rejected(response, body);
      token = body.tenant_access_token;
      expiresAt = Date.now() + Math.max(0, (Number(body.expire) - 60) * 1000);
    }
    const url = new URL(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions${reactionId ? `/${encodeURIComponent(reactionId)}` : ''}`);
    if (method === 'GET') {
      url.searchParams.set('reaction_type', emoji);
      url.searchParams.set('page_size', '50');
      if (pageToken) url.searchParams.set('page_token', pageToken);
    }
    const response = await fetchImpl(url, { method, signal,
      headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json'},
      ...(method === 'POST' ? {body:JSON.stringify({reaction_type:{emoji_type:emoji}})} : {}),
    });
    const body = await response.json();
    if (!response.ok || body.code !== 0) throw rejected(response, body);
    return body.data;
  }
  return {
    create: (id, emoji) => runWrite(() => request(id, {method:'POST', emoji, signal:AbortSignal.timeout(timeoutMs)})),
    remove: (id, reactionId) => runWrite(() => request(id, {method:'DELETE', reactionId, signal:AbortSignal.timeout(timeoutMs)})),
    async list(id, emoji) {
      const signal = AbortSignal.timeout(timeoutMs), items = [], seen = new Set();
      let pageToken;
      for (let page = 0; page < 10; page++) {
        const data = await request(id, {emoji, pageToken, signal});
        if (!Array.isArray(data?.items)) throw new Error('Invalid reaction list');
        items.push(...data.items);
        if (!data.has_more) return items;
        pageToken = data.page_token;
        if (!pageToken || seen.has(pageToken)) break;
        seen.add(pageToken);
      }
      throw new Error('Incomplete reaction list');
    },
  };
}
