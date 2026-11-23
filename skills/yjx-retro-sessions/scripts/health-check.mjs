#!/usr/bin/env node
/**
 * Zero-token static health precheck for agent rule files and skills.
 * Flags dead relative markdown links, dead heading anchors across SKILL.md and
 * references/*.md, frontmatter mismatches, and size/line budget warnings.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_RULE_BYTES_WARN = 20_000;
const DEFAULT_RULE_BYTES_CAP = 24_000;
const DEFAULT_SKILL_LINES_WARN = 500;

function collectReferenceFiles(refRoot, out) {
  if (!fs.existsSync(refRoot)) return;
  let entries;
  try {
    entries = fs.readdirSync(refRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(refRoot, ent.name);
    if (ent.isDirectory()) {
      collectReferenceFiles(full, out);
    } else if ((ent.isFile() || ent.isSymbolicLink()) && ent.name.endsWith(".md")) {
      out.push({ filePath: full, kind: "reference" });
    }
  }
}

function collectRuleAndSkillFiles(rootDir) {
  const files = [];
  const topCandidates = ["AGENTS.md", "CLAUDE.md", path.join("prompts", "AGENTS.md")];
  for (const rel of topCandidates) {
    const full = path.join(rootDir, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      files.push({ filePath: full, kind: "rule" });
    }
  }

  for (const skillBase of [path.join(rootDir, "skills"), path.join(rootDir, ".agents", "skills"), path.join(rootDir, ".claude", "skills")]) {
    if (!fs.existsSync(skillBase)) continue;
    let entries;
    try {
      entries = fs.readdirSync(skillBase, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const skillDir = path.join(skillBase, ent.name);
      const skillFile = path.join(skillDir, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        files.push({ filePath: skillFile, kind: "skill", dirName: ent.name });
      }
      collectReferenceFiles(path.join(skillDir, "references"), files);
    }
  }
  return files;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^['"]|['"]$/g, "").trim();
  }
  return meta;
}

function stripCodeBlocksAndComments(text) {
  return text.replace(/```[\s\S]*?```/g, "").replace(/<!--[\s\S]*?-->/g, "");
}

function toGfmBaseSlug(rawHeading) {
  // Match GitHub-slugger behavior: preserve intraword '_' (e.g. snake_case/filenames in code spans)
  // and preserve 1:1 spaces as '-' after stripping punctuation (e.g. "a / b" -> "a--b").
  return rawHeading
    .replace(/\s+#+\s*$/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*~]/g, "")
    .replace(/(^|[^\p{L}\p{N}])_+|_+([^\p{L}\p{N}]|$)/gu, "$1$2")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/ /g, "-");
}

function getHeadingAnchors(filePath, cache) {
  if (cache.has(filePath)) return cache.get(filePath);
  const raw = fs.readFileSync(filePath, "utf8");
  const cleaned = stripCodeBlocksAndComments(raw);
  const counts = new Map();
  const anchors = new Set();
  for (const line of cleaned.split(/\r?\n/)) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (!m) continue;
    const base = toGfmBaseSlug(m[1]);
    if (!base) continue;
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  cache.set(filePath, anchors);
  return anchors;
}

function decodeHash(hash) {
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

function checkRelativeLinks(text, filePath, rootDir, anchorCache) {
  const issues = [];
  const cleaned = stripCodeBlocksAndComments(text);
  const baseDir = path.dirname(filePath);
  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = linkRe.exec(cleaned)) !== null) {
    const rawTarget = m[1].trim();
    let target = rawTarget;
    if (!target || /^(https?:|mailto:|t3-citation:|file:\/\/)/i.test(target)) continue;
    if (/^(?:link|url|<[^>]+>)$/i.test(target)) continue;
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);

    const hashIdx = target.indexOf("#");
    const rawHash = hashIdx >= 0 ? target.slice(hashIdx + 1).trim() : "";
    const filePart = (hashIdx >= 0 ? target.slice(0, hashIdx) : target).replace(/:\d+(?::\d+)?$/, "").trim();

    let resolvedTarget = null;
    if (!filePart) {
      if (!rawHash) continue;
      resolvedTarget = filePath;
    } else {
      const resolvedFromFile = path.resolve(baseDir, filePart);
      const resolvedFromRoot = path.resolve(rootDir, filePart);
      if (fs.existsSync(resolvedFromFile)) resolvedTarget = resolvedFromFile;
      else if (fs.existsSync(resolvedFromRoot)) resolvedTarget = resolvedFromRoot;
      else {
        issues.push({ type: "dead_link", detail: `Missing target: ${rawTarget}` });
        continue;
      }
    }

    if (rawHash && resolvedTarget.toLowerCase().endsWith(".md") && !/^L\d+(?:-L?\d+)?$/i.test(rawHash)) {
      const expectedAnchor = decodeHash(rawHash).toLowerCase();
      const anchors = getHeadingAnchors(resolvedTarget, anchorCache);
      if (!anchors.has(expectedAnchor)) {
        issues.push({ type: "dead_anchor", detail: `Missing anchor '#${rawHash}' in '${path.relative(rootDir, resolvedTarget).replace(/\\/g, "/")}'` });
      }
    }
  }
  return issues;
}

export function runHealthCheck({ rootDir = process.cwd(), extraFiles = [] } = {}) {
  const absRoot = path.resolve(rootDir);
  const targets = collectRuleAndSkillFiles(absRoot);
  for (const f of extraFiles) {
    const abs = path.resolve(absRoot, f);
    if (fs.existsSync(abs)) targets.push({ filePath: abs, kind: "rule" });
  }

  const findings = [];
  const inspected = [];
  const anchorCache = new Map();

  for (const item of targets) {
    const raw = fs.readFileSync(item.filePath, "utf8");
    const bytes = Buffer.byteLength(raw, "utf8");
    const lines = raw.split(/\r?\n/).length;
    const relPath = path.relative(absRoot, item.filePath).replace(/\\/g, "/");
    inspected.push({ path: relPath, kind: item.kind, bytes, lines });

    const linkIssues = checkRelativeLinks(raw, item.filePath, absRoot, anchorCache);
    for (const issue of linkIssues) {
      findings.push({ path: relPath, severity: "error", type: issue.type, detail: issue.detail });
    }

    if (item.kind === "reference") continue;

    if (item.kind === "skill") {
      const fm = parseFrontmatter(raw);
      if (!fm || !fm.name || !fm.description) {
        findings.push({ path: relPath, severity: "error", type: "frontmatter_missing", detail: "Missing YAML frontmatter name or description" });
      } else if (item.dirName && fm.name !== item.dirName) {
        findings.push({ path: relPath, severity: "warn", type: "name_mismatch", detail: `Frontmatter name '${fm.name}' != directory '${item.dirName}'` });
      }
      if (lines > DEFAULT_SKILL_LINES_WARN) {
        findings.push({ path: relPath, severity: "warn", type: "skill_long", detail: `${lines} lines (> ${DEFAULT_SKILL_LINES_WARN} line progressive-disclosure guideline)` });
      }
      if (bytes > DEFAULT_RULE_BYTES_CAP) {
        const manualOnly = fm?.["disable-model-invocation"] === "true";
        findings.push({
          path: relPath,
          severity: manualOnly ? "info" : "warn",
          type: "size_over_24kb",
          detail: `${bytes} bytes (> ${DEFAULT_RULE_BYTES_CAP}B; ${manualOnly ? "manual-only skill" : "consider splitting to references/"})`,
        });
      }
    } else if (bytes > DEFAULT_RULE_BYTES_CAP) {
      findings.push({ path: relPath, severity: "error", type: "rule_over_cap", detail: `${bytes} bytes (> ${DEFAULT_RULE_BYTES_CAP}B Antigravity rule cap, risks truncation)` });
    } else if (bytes > DEFAULT_RULE_BYTES_WARN) {
      findings.push({ path: relPath, severity: "warn", type: "rule_near_cap", detail: `${bytes} bytes (approaching ${DEFAULT_RULE_BYTES_CAP}B rule cap)` });
    }
  }

  return {
    rootDir: absRoot,
    filesChecked: inspected.length,
    inspected,
    findings,
  };
}

function formatMarkdown(res) {
  const lines = [
    "# Rule & Skill Static Health Check",
    "",
    `- Root: \`${res.rootDir}\``,
    `- Files checked: **${res.filesChecked}** | Findings: **${res.findings.length}**`,
    "",
  ];
  if (res.findings.length === 0) {
    lines.push("No dead links, frontmatter errors, or budget warnings found.");
  } else {
    for (const f of res.findings) {
      lines.push(`- [${f.severity.toUpperCase()}] \`${f.path}\` (${f.type}): ${f.detail}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function parseCliArgs(argv) {
  const opts = { extraFiles: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") opts.rootDir = argv[++i];
    else if (a === "--extra") opts.extraFiles.push(argv[++i]);
    else if (a === "--format") opts.format = argv[++i];
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: health-check.mjs [--root <repo>] [--extra <file> ...] [--format md|json]");
    return;
  }
  const res = runHealthCheck(opts);
  if (opts.format === "json") console.log(JSON.stringify(res, null, 2));
  else process.stdout.write(formatMarkdown(res));
}

// Installed skills are symlinks; compare real paths or the script silently skips main().
function isEntrypoint() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  try {
    main();
  } catch (err) {
    console.error(`health-check: ${err.message}`);
    process.exit(1);
  }
}
