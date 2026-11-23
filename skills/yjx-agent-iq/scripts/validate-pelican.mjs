import { readFile } from 'node:fs/promises';
import { isMain } from './safe-output.mjs';

export function extractHtml(text) {
  const source = String(text ?? '').trim();
  const blocks = [...source.matchAll(/```(?:html?)?\s*\n([\s\S]*?)```/gi)]
    .map((match) => match[1].trim()).filter((value) => /<html\b/i.test(value));
  if (blocks.length === 1) return blocks[0];
  if (blocks.length > 1) return ''; // the examiner must resolve multiple competing artifacts
  const start = source.search(/<!doctype\s+html|<html\b/i);
  return start >= 0 ? source.slice(start).trim() : '';
}

export function validatePelican(text) {
  const html = extractHtml(text);
  const references = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi),
    ...html.matchAll(/url\(\s*["']?([^)'"\s]+)["']?\s*\)/gi)].map((match) => match[1]);
  const externalCandidates = references.filter((value) => value && !/^(?:#|data:|blob:)/i.test(value));
  const completeDocument = /<html\b/i.test(html) && /<\/html>\s*$/i.test(html)
    && /<svg\b/i.test(html) && /<\/svg>/i.test(html);
  return {
    question: 'pelican', html, completeDocument,
    clues: {
      circleElements: (html.match(/<circle\b/gi) ?? []).length,
      animationSyntax: /<animate(?:Transform)?\b|@keyframes\b|requestAnimationFrame\s*\(|setInterval\s*\(/i.test(html),
      externalReferenceCandidates: externalCandidates.length,
    },
    browserEvidenceRequired: true,
    status: completeDocument ? 'review' : 'incomplete',
  };
}

if (isMain(import.meta.url)) {
  try {
    const { html, ...summary } = validatePelican(await readFile(process.argv[2], 'utf8'));
    console.log(JSON.stringify({ ...summary, htmlLength: html.length }, null, 2));
  } catch { console.error('无法读取作答文件'); process.exitCode = 1; }
}
