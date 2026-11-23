import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { invokeCli, main, runLocal } from '../scripts/run.mjs';
import { sha256, writeRunReport } from '../scripts/results.mjs';
import { join } from 'node:path';

test('local execution requires explicit authorization before any invocation', async () => {
  await assert.rejects(main(['once', '--question', 'candy', '--model', 'fixture', '--agent', 'codex']),
    { message: 'local_cli_not_authorized' });
});
test('subprocess arguments and UTF-8 stdin bypass shell interpretation', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'iq-process-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const literal = '中文 & | $(literal) "quote" %PATH%';
  const result = await invokeCli(process.execPath, ['-e',
    'process.stdin.setEncoding("utf8");let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify([process.argv[1],s])))',
    literal], literal + '\n换行', { cwd, timeoutMs: 5000 });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), [literal, literal + '\n换行']);
});
test('timeout terminates the launched process and reports an incomplete run', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'iq-timeout-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const result = await invokeCli(process.execPath, ['-e', 'setInterval(()=>{},1000)'], '',
    { cwd, timeoutMs: 150 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test('cleanup failure preserves captured output and permits durable run summary', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'iq-cleanup-'));
  let workingDirectory;
  let evidenceBeforeCleanup = false;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (workingDirectory) await rm(workingDirectory, { recursive: true, force: true });
  });
  const warnings = [];
  t.mock.method(process.stderr, 'write', (value) => { warnings.push(value); return true; });
  const record = await runLocal({ id: 'cleanup', agent: 'codex', model: 'fixture', executable: process.execPath },
    'candy', 1, root, 1000, {
      invoke: async (_command, _args, _prompt, { cwd }) => {
        workingDirectory = cwd;
        return { code: 1, stdout: 'partial captured output', stderr: 'captured diagnostic' };
      },
      cleanup: async () => {
        const files = join(root, sha256('cleanup/candy/1').slice(0, 20));
        evidenceBeforeCleanup = await readFile(join(files, 'transcript.json'), 'utf8') === 'partial captured output'
          && await readFile(join(files, 'stderr.txt'), 'utf8') === 'captured diagnostic';
        throw Object.assign(new Error('private cleanup detail'), { code: 'EPERM' });
      },
    });
  assert.equal(evidenceBeforeCleanup, true);
  assert.equal(record.status, 'incomplete');
  assert.equal((await stat(workingDirectory)).isDirectory(), true);
  assert.equal((await writeRunReport(root, [record])).incomplete, 1);
  assert.deepEqual(warnings.map(value => JSON.parse(value)), [{ code: 'cleanup_failed', directory: workingDirectory }]);
});
