#!/usr/bin/env node
/**
 * Read-only inventory of .scratch/*/issues/*.md and docs/agents/local-tracker.json
 * for yjx-local-tracker-setup preview.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ISSUE_FILE_RE = /^\d+-.+\.md$/i;
const FIELD_RE = /^(?:\*\*)?([A-Za-z][A-Za-z0-9 _-]*)(?:\*\*)?:\s*(.*)$/;

function parseHeaderFields(raw) {
  const fields = {};
  for (const line of raw.split(/\r?\n/)) {
    if (/^##\s+/.test(line)) break;
    const m = line.replace(/：/g, ':').match(FIELD_RE);
    if (!m) continue;
    const key = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
    fields[key] = m[2].trim();
  }
  return fields;
}

export function inventoryLocalTracker(projectRoot) {
  const root = path.resolve(projectRoot || process.cwd());
  const configPath = path.join(root, 'docs', 'agents', 'local-tracker.json');
  let configStatus = { exists: fs.existsSync(configPath), protocol: null, error: null };
  if (configStatus.exists) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      configStatus.protocol = parsed?.protocol ?? null;
    } catch (err) {
      configStatus.error = err.message;
    }
  }

  const scratchRoot = path.join(root, '.scratch');
  const features = [];
  const summary = {
    totalIssues: 0,
    statusResolved: 0,
    statusClaimed: 0,
    statusWontfix: 0,
    otherStatus: 0,
    missingStatus: 0,
    legacyClosedTrue: 0,
    legacyClosedFalse: 0,
    unreadableFiles: [],
  };

  if (fs.existsSync(scratchRoot)) {
    for (const entry of fs.readdirSync(scratchRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const issuesDir = path.join(scratchRoot, entry.name, 'issues');
      if (!fs.existsSync(issuesDir)) continue;
      const featureStat = { feature: entry.name, total: 0, missingStatus: 0, legacyClosed: 0 };
      for (const file of fs.readdirSync(issuesDir)) {
        if (!ISSUE_FILE_RE.test(file)) continue;
        const full = path.join(issuesDir, file);
        let raw;
        try {
          raw = fs.readFileSync(full, 'utf8');
        } catch (err) {
          summary.unreadableFiles.push({ file: full, error: err.message });
          continue;
        }
        const fields = parseHeaderFields(raw);
        featureStat.total += 1;
        summary.totalIssues += 1;
        const status = (fields.status ?? '').toLowerCase();
        if (!status) {
          summary.missingStatus += 1;
          featureStat.missingStatus += 1;
        } else if (status === 'resolved') summary.statusResolved += 1;
        else if (status === 'claimed') summary.statusClaimed += 1;
        else if (status === 'wontfix') summary.statusWontfix += 1;
        else summary.otherStatus += 1;

        const closed = (fields.closed ?? '').toLowerCase();
        if (closed === 'true') {
          summary.legacyClosedTrue += 1;
          featureStat.legacyClosed += 1;
        } else if (closed === 'false') {
          summary.legacyClosedFalse += 1;
          featureStat.legacyClosed += 1;
        }
      }
      features.push(featureStat);
    }
  }

  return { projectRoot: root, config: configStatus, summary, features };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--project-root');
  const root = idx >= 0 && args[idx + 1] ? args[idx + 1] : process.cwd();
  process.stdout.write(JSON.stringify(inventoryLocalTracker(root), null, 2) + '\n');
}
