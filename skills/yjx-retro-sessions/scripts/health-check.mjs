#!/usr/bin/env node
/**
 * Zero-token static health precheck for agent rule files and skills.
 * Flags dead relative markdown links, missing script references, frontmatter
 * mismatches, and size/line budget warnings.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_RULE_BYTES_WARN = 20_000;
const DEFAULT_RULE_BYTES_CAP = 24_000;
const DEFAULT_SKILL_LINES_WARN = 500;

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
      const skillFile = path.join(skillBase, ent.name, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        files.push({ filePath: skillFile, kind: "skill", dirName: ent.name });
      }
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

function checkRelativeLinks(text, filePath, rootDir) {
  const issues = [];
  const cleaned = stripCodeBlocksAndComments(text);
  const baseDir = path.dirname(filePath);
  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = linkRe.exec(cleaned)) !== null) {
    let target = m[1].trim();
    if (!target || /^(https?:|mailto:|t3-citation:|#)/i.test(target)) continue;
    if (/^file:\/\//i.test(target)) continue;
    if (/^(?:link|url|<[^>]+>)$/i.test(target)) continue;
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    target = target.replace(/#.*$/, "").replace(/:\d+(?::\d+)?$/, "").trim();
    if (!target) continue;
    const resolvedFromFile = path.resolve(baseDir, target);
    const resolvedFromRoot = path.resolve(rootDir, target);
    if (!fs.existsSync(resolvedFromFile) && !fs.existsSync(resolvedFromRoot)) {
      issues.push({ type: "dead_link", target: m[1].trim() });
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

  for (const item of targets) {
    const raw = fs.readFileSync(item.filePath, "utf8");
    const bytes = Buffer.byteLength(raw, "utf8");
    const lines = raw.split(/\r?\n/).length;
    const relPath = path.relative(absRoot, item.filePath).replace(/\\/g, "/");
    inspected.push({ path: relPath, kind: item.kind, bytes, lines });

    const deadLinks = checkRelativeLinks(raw, item.filePath, absRoot);
    for (const d of deadLinks) {
      findings.push({ path: relPath, severity: "error", type: d.type, detail: `Missing target: ${d.target}` });
    }

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

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    main();
  } catch (err) {
    console.error(`health-check: ${err.message}`);
    process.exit(1);
  }
}
