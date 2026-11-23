import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isMain } from './safe-output.mjs';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

export function buildGallery(items) {
  const panels = items.map((item) => {
    const src = pathToFileURL(item.htmlPath).href;
    return `<article><h2>${escapeHtml(item.label ?? item.id)}</h2><iframe title="${escapeHtml(item.label ?? item.id)}" src="${escapeHtml(src)}" sandbox="allow-scripts"></iframe></article>`;
  }).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>yjx-agent-iq gallery</title><style>body{font-family:system-ui;margin:20px;background:#f4f4f4;color:#222}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:16px}article{background:#fff;border:1px solid #ccc;padding:12px}h2{font-size:16px;margin:0 0 8px}iframe{display:block;width:100%;aspect-ratio:16/10;border:1px solid #888;background:#fff}</style><main>${panels}</main>`;
}

if (isMain(import.meta.url)) {
  try {
    const [manifestPath, outputPath] = process.argv.slice(2);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const records = Array.isArray(manifest) ? manifest : manifest.items ?? manifest.records ?? [];
    const items = records.filter((item) => item.htmlPath);
    await writeFile(outputPath, buildGallery(items), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    console.log(outputPath);
  } catch { console.error('无法读取清单或写入新的对比页'); process.exitCode = 1; }
}
