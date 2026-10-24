import { parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Link formatting only. Place identity, redirects and iPhone launch need separate checks.
export function buildPlaceLinks({ name, amapPoi, dianpingUrl } = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('需要地点全名');
  let amap = null;
  if (amapPoi !== undefined) {
    if (typeof amapPoi !== 'string' || !/^B[A-Z0-9]{9}$/.test(amapPoi)) {
      throw new Error('高德 POI ID 格式无效；请从实际查询结果取得');
    }
    const url = new URL('https://uri.amap.com/marker');
    url.searchParams.set('poiid', amapPoi);
    url.searchParams.set('callnative', '1');
    amap = url.href;
  }
  let dianping = null;
  if (dianpingUrl !== undefined) {
    if (typeof dianpingUrl !== 'string' || /[\s\x00-\x1f\x7f]/.test(dianpingUrl)) {
      throw new Error('点评链接含空白或控制字符');
    }
    const url = new URL(dianpingUrl);
    const shop = ['www.dianping.com', 'm.dianping.com', 'dianping.com'].includes(url.hostname)
      && /^\/(?:shop|shopshare|shopinfo)\/[A-Za-z0-9]+\/?$/.test(url.pathname);
    const shared = url.hostname === 'dpurl.cn' && /^\/[A-Za-z0-9]+\/?$/.test(url.pathname);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !(shop || shared)) {
      throw new Error('需要实际取得的点评 HTTPS 店铺链接或 dpurl.cn 分享短链');
    }
    // Preserve the actual supplied sharing URL, including its query and fragment.
    dianping = dianpingUrl;
  }
  return { name: name.trim(), amap, dianping };
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    const { values } = parseArgs({ options: {
      name: { type: 'string' }, 'amap-poi': { type: 'string' }, 'dianping-url': { type: 'string' },
    } });
    console.log(JSON.stringify(buildPlaceLinks({
      name: values.name, amapPoi: values['amap-poi'], dianpingUrl: values['dianping-url'],
    }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
