import { readFile } from 'node:fs/promises';
import { isMain } from './safe-output.mjs';

export const CANDY_CRITERIA = ['shape-choice', 'guarantee-21', 'lower-bound-20'];

export function scoreCandy(answer, review = {}) {
  const final = review.finalNumber ?? {};
  const quoteValid = typeof final.quote === 'string' && final.quote.trim().length > 0
    && answer.includes(final.quote);
  const numericStatus = quoteValid && Number.isInteger(final.value)
    ? final.value === 21 ? 'pass' : 'fail' : 'review';
  const criteria = CANDY_CRITERIA.map((id) => {
    const item = Array.isArray(review.criteria) ? review.criteria.find((criterion) => criterion?.id === id) : null;
    const evidenced = item && typeof item.quote === 'string' && item.quote.trim()
      && answer.includes(item.quote) && typeof item.reason === 'string' && item.reason.trim();
    return { id, status: evidenced && ['pass', 'fail'].includes(item.status) ? item.status : 'review',
      quote: evidenced ? item.quote : '', reason: evidenced ? item.reason : '待考官引用作答并判断' };
  });
  const states = [numericStatus, ...criteria.map((item) => item.status)];
  return {
    question: 'candy',
    numeric: { status: numericStatus, value: quoteValid ? final.value : null, expected: 21,
      quote: quoteValid ? final.quote : '' },
    criteria,
    overall: states.includes('fail') ? 'fail' : states.every((state) => state === 'pass') ? 'pass' : 'review',
  };
}

if (isMain(import.meta.url)) {
  try {
    const answer = await readFile(process.argv[2], 'utf8');
    const review = process.argv[3] ? JSON.parse(await readFile(process.argv[3], 'utf8')) : {};
    console.log(JSON.stringify(scoreCandy(answer, review), null, 2));
  } catch { console.error('无法读取作答或考官评估文件'); process.exitCode = 1; }
}
