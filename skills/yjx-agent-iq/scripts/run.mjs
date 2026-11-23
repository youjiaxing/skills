import { spawn, execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { recordAttempt, buildPrompt, writeRunReport, sha256 } from './results.mjs';
import { safeFailure, safeMetadata, isMain } from './safe-output.mjs';

const ROOT = join(homedir(), '.yjx-agent-iq', 'runs');
function parseArgs(argv) {
  const args = { command: argv[0], examinees: [], timeout: 300 };
  for (let i = 1; i < argv.length; i++) {
    const option = argv[i];
    if (option === '--allow-local-cli') args.allowLocalCli = true;
    else if (option === '--help') args.help = true;
    else {
      const fields = { '--agent': 'agent', '--model': 'model', '--id': 'id', '--question': 'question',
        '--timeout': 'timeout', '--config': 'config', '--examinee': 'examinee', '--capture': 'capture',
        '--prompt': 'prompt', '--review': 'review', '--output': 'output', '--executable': 'executable',
        '--entrypoint': 'entrypoint', '--source-link': 'sourceLink', '--evidence-root': 'evidenceRoot' };
      if (!fields[option] || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('invalid_arguments');
      const value = argv[++i];
      if (option === '--examinee') args.examinees.push(value);
      else args[fields[option]] = value;
    }
  }
  return args;
}
export async function resolveExecutable(command) {
  const candidates = isAbsolute(command) ? [command] : (process.env.PATH ?? '').split(delimiter)
    .filter(Boolean).map((directory) => join(directory, process.platform === 'win32' ? command + '.exe' : command));
  for (const file of candidates) {
    if (process.platform === 'win32' && !file.toLowerCase().endsWith('.exe')) continue;
    try { await access(file, constants.X_OK); return resolve(file); } catch { /* next PATH entry */ }
  }
  throw new Error('executable_unavailable');
}
export async function invokeCli(command, args, prompt, { cwd, timeoutMs }) {
  // Argument vectors go directly to an executable; no cmd.exe/PowerShell interpretation.
  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawn(command, args, { cwd, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { resolveResult({ code: null, stdout: '', stderr: '', error: 'execution_failed' }); return; }
    const stdout = [], stderr = [];
    let timedOut = false, overflow = false, size = 0;
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 16 * 1024 * 1024) chunks.push(chunk);
        else if (!overflow) { overflow = true; stop(); }
      });
    }
    child.stdin.on('error', () => {}); // EPIPE is represented by the process terminal status
    child.on('error', () => {
      clearTimeout(timer);
      resolveResult({ code: null, stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'), error: 'execution_failed', timedOut });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolveResult({ code, signal, timedOut, overflow, stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.end(prompt, 'utf8');
  });
}
function cliArgs(examinee, cwd) {
  const prefix = examinee.entrypoint ? [examinee.entrypoint] : [];
  if (examinee.entrypoint && !isAbsolute(examinee.entrypoint)) throw new Error('invalid_arguments');
  if (examinee.agent === 'claude') return [...prefix, '-p', '--tools', '', '--disable-slash-commands',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    '--output-format', 'stream-json', '--verbose', '--model', examinee.model];
  if (examinee.agent === 'codex') return [...prefix, 'exec', '--json', '--ephemeral', '--ignore-rules',
    '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', cwd, '--model', examinee.model];
  if (examinee.agent === 'gemini') return [...prefix, '-p', '', '--approval-mode', 'plan',
    '--output-format', 'stream-json', '--model', examinee.model];
  throw new Error('invalid_arguments');
}
async function makeRunRoot(output) {
  const base = output ? resolve(output) : ROOT;
  await mkdir(base, { recursive: true, mode: 0o700 });
  return mkdtemp(join(base, 'assessment-'));
}
export async function runLocal(examinee, question, attempt, root, timeoutMs,
  { invoke = invokeCli, cleanup = rm } = {}) {
  const prompt = await buildPrompt(question);
  const cwd = await mkdtemp(join(tmpdir(), 'yjx-agent-iq-'));
  let result;
  try {
    try {
      const command = await resolveExecutable(examinee.executable ?? examinee.agent);
      result = await invoke(command, cliArgs(examinee, cwd), prompt, { cwd, timeoutMs });
    } catch { result = { code: null, stdout: '', stderr: '', error: 'executable_unavailable' }; }
    const id = examinee.id + '/' + question + '/' + attempt;
    const target = join(root, sha256(id).slice(0, 20));
    const record = await recordAttempt({ root: target, id, provider: examinee.agent, model: examinee.model,
      question, prompt, raw: result.stdout, protocolProvider: examinee.agent, exitCode: result.code,
      timedOut: result.timedOut, complete: !result.error && !result.overflow, failureCode: result.error });
    await writeFile(join(target, 'stderr.txt'), result.stderr, { flag: 'wx', mode: 0o600 });
    return record;
  } finally {
    try { await cleanup(cwd, { recursive: true, force: true }); }
    catch { process.stderr.write(JSON.stringify({ code: 'cleanup_failed', directory: cwd }) + '\n'); }
  }
}
export async function main(argv) {
  const args = parseArgs(argv);
  if (args.command === '--help' || args.help) {
    console.log('考官内部入口：prepare（生成固定题面）、import（离线整理宿主证据）、once/compare（需显式授权本地 CLI）。');
    return;
  }
  if (!['prepare', 'import', 'once', 'compare'].includes(args.command)) throw new Error('invalid_arguments');
  if (!['candy', 'pelican', 'all'].includes(args.question)) throw new Error('invalid_arguments');
  if (args.command === 'prepare') {
    if (args.question === 'all' || !args.output) throw new Error('invalid_arguments');
    const prompt = await buildPrompt(args.question);
    await writeFile(resolve(args.output), prompt, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ promptPath: resolve(args.output), sha256: sha256(prompt) }));
    return;
  }
  if (args.command === 'import') {
    if (args.question === 'all' || !args.capture || !args.prompt || !args.model) throw new Error('invalid_arguments');
    const raw = JSON.parse(await readFile(args.capture, 'utf8'));
    const review = args.review ? JSON.parse(await readFile(args.review, 'utf8')) : {};
    const prompt = await readFile(args.prompt, 'utf8');
    const root = await makeRunRoot(args.output);
    const record = await recordAttempt({ root: join(root, 'attempt-1'), id: args.id ?? args.model,
      provider: args.agent ?? raw.actualProvider, model: args.model, question: args.question,
      raw, prompt, review, protocolProvider: 't3', sourceLink: args.sourceLink ?? raw.sourceLink,
      evidenceRoot: args.evidenceRoot ?? root });
    const summary = await writeRunReport(root, [record]);
    console.log(JSON.stringify({ root, summary, ...safeMetadata({ provider: record.provider, model: record.model }) }));
    return;
  }
  if (!args.allowLocalCli) throw new Error('local_cli_not_authorized');
  if (args.model && args.examinees.length) throw new Error('invalid_arguments');
  const config = args.model ? { examinees: [{ id: args.id ?? args.model, agent: args.agent, model: args.model,
    executable: args.executable, entrypoint: args.entrypoint }] }
    : parse(await readFile(args.config ?? join(homedir(), '.yjx-agent-iq', 'examinees.yaml'), 'utf8'));
  if (!Array.isArray(config?.examinees)) throw new Error('configuration_unavailable');
  const examinees = args.model ? config.examinees : args.examinees.map((id) => config.examinees.find((item) => item.id === id));
  if (!examinees.length || examinees.some((item) => !item || typeof item.id !== 'string'
    || !['claude', 'codex', 'gemini'].includes(item.agent) || typeof item.model !== 'string')) throw new Error('invalid_arguments');
  if (new Set(examinees.map((item) => item.id)).size !== examinees.length
    || (args.command === 'once' && examinees.length !== 1)) throw new Error('invalid_arguments');
  const timeoutMs = Number(args.timeout) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) throw new Error('invalid_arguments');
  const questions = args.question === 'all' ? ['candy', 'pelican'] : [args.question];
  const root = await makeRunRoot(args.output);
  // Models may run concurrently; attempts of one model remain serial. There are no automatic retries.
  const groups = await Promise.all(examinees.map(async (examinee) => {
    const records = [];
    for (const question of questions) {
      const count = args.command === 'compare' && question === 'candy' ? 3 : 1;
      for (let attempt = 1; attempt <= count; attempt++) records.push(await runLocal(examinee, question, attempt, root, timeoutMs));
    }
    return records;
  }));
  const records = groups.flat();
  const summary = await writeRunReport(root, records);
  console.log(JSON.stringify({ root, summary, visibility: '本地进程，不生成可见 T3 子会话' }));
}
if (isMain(import.meta.url)) main(process.argv.slice(2)).catch((error) => {
  console.error(JSON.stringify(safeFailure(error?.message)));
  process.exitCode = 1;
});
