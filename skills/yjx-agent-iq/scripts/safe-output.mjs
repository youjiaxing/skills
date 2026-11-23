import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(url) {
  try { return realpathSync(fileURLToPath(url)) === realpathSync(process.argv[1]); }
  catch { return false; }
}

// Diagnostic output is an allowlisted projection, never a redacted copy of a configuration.
export function safeMetadata(value = {}) {
  const token = (item) => typeof item === 'string' && /^[a-zA-Z0-9._/: -]{1,160}$/.test(item) ? item : undefined;
  let origin;
  try {
    const url = new URL(value.baseUrl ?? value.base_url);
    if (['http:', 'https:'].includes(url.protocol)) origin = url.origin;
  } catch { /* malformed URLs never reach output */ }
  return Object.fromEntries(Object.entries({
    provider: token(value.provider), model: token(value.model),
    supported: typeof value.supported === 'boolean' ? value.supported : undefined, origin,
  }).filter(([, item]) => item !== undefined));
}

const CODES = new Set(['invalid_arguments', 'configuration_unavailable', 'executable_unavailable',
  'local_cli_not_authorized', 'capture_unavailable', 'execution_failed', 'rate_limited',
  'timeout', 'io_failed', 'unknown_failure']);
export function safeFailure(code, metadata) {
  return { code: CODES.has(code) ? code : 'unknown_failure', ...safeMetadata(metadata) };
}
