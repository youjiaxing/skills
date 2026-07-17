import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CONFIG_RELATIVE_PATH = path.join('docs', 'agents', 'local-tracker.json');

import {
  addClosedField,
  buildConfig,
  inspectSetup,
  main,
  parseStatusRoles,
} from '../scripts/setup-local-tracker.mjs';

const TRACKER_DOC = `# Issue tracker: Local Markdown\n\nIssues live under .scratch/<feature>/issues/<NN>-<slug>.md.\n`;
const TRIAGE_DOC = `# Triage Labels\n\n| Label in mattpocock/skills | Label in our tracker |\n| --- | --- |\n| \`needs-triage\` | \`needs-triage\` |\n| \`needs-info\` | \`needs-info\` |\n| \`ready-for-agent\` | \`agent-ready\` |\n| \`ready-for-human\` | \`human-ready\` |\n| \`wontfix\` | \`wontfix\` |\n`;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yjx-local-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs', 'agents'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'agents', 'issue-tracker.md'), TRACKER_DOC);
  await writeFile(path.join(root, 'docs', 'agents', 'triage-labels.md'), TRIAGE_DOC);
  const issues = path.join(root, '.scratch', 'feature', 'issues');
  await mkdir(issues, { recursive: true });
  return { root, issues };
}

test('parses canonical roles from Matt triage mapping table', () => {
  const roles = parseStatusRoles(TRIAGE_DOC);
  assert.equal(roles['ready-for-agent'], 'agent-ready');
  assert.equal(buildConfig(roles).completionField, 'Closed');
});

test('addClosedField preserves plain and bold field style', () => {
  const plain = addClosedField('# A\n\nStatus: ready-for-agent\n\n## Comments\n');
  const bold = addClosedField('# B\r\n\r\n**Status:** ready-for-agent\r\n\r\n## Comments\r\n');
  assert.equal(plain.changed, true);
  assert.match(plain.source, /Status: ready-for-agent\nClosed: false/);
  assert.equal(bold.changed, true);
  assert.match(bold.source, /\*\*Status:\*\* ready-for-agent\r\n\*\*Closed:\*\* false/);
});

test('addClosedField refuses issue without a status field', () => {
  const result = addClosedField('# A\n\n## Comments\n');
  assert.deepEqual({ changed: result.changed, reason: result.reason }, { changed: false, reason: 'missing-status' });
});

test('preview inventories legacy issues without modifying them', async (t) => {
  const work = await fixture(t);
  const issuePath = path.join(work.issues, '01-legacy.md');
  await writeFile(issuePath, '# Legacy\n\nStatus: agent-ready\n\n## Blocked by\n\nNone\n');
  const before = await readFile(issuePath, 'utf8');
  const report = await inspectSetup(work.root);
  assert.equal(report.config.action, 'create');
  assert.deepEqual(report.migration.eligible, ['.scratch/feature/issues/01-legacy.md']);
  assert.equal(await readFile(issuePath, 'utf8'), before);
});

test('apply writes config but does not migrate unless requested', async (t) => {
  const work = await fixture(t);
  const issuePath = path.join(work.issues, '01-legacy.md');
  await writeFile(issuePath, '# Legacy\n\nStatus: agent-ready\n\n## Blocked by\n\nNone\n');
  const writes = [];
  const oldWrite = process.stdout.write;
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await main(['--project-root', work.root, '--apply', '--yes', '--json']);
  } finally {
    process.stdout.write = oldWrite;
  }
  const config = JSON.parse(await readFile(path.join(work.root, CONFIG_RELATIVE_PATH), 'utf8'));
  assert.equal(config.statusRoles['ready-for-agent'], 'agent-ready');
  assert.doesNotMatch(await readFile(issuePath, 'utf8'), /Closed:/);
  assert.ok(writes.join('').includes('"applied"'));
});

test('apply with migration adds Closed false to eligible legacy issues', async (t) => {
  const work = await fixture(t);
  const issuePath = path.join(work.issues, '01-legacy.md');
  await writeFile(issuePath, '# Legacy\n\n**Status:** agent-ready\n\n**Blocked by:** None\n');
  const oldWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await main(['--project-root', work.root, '--apply', '--yes', '--migrate-closed']);
  } finally {
    process.stdout.write = oldWrite;
  }
  assert.match(await readFile(issuePath, 'utf8'), /\*\*Closed:\*\* false/);
});
