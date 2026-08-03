import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(skillDir, "scripts", "cli.mjs");
const emptyFixture = path.join(skillDir, "fixtures", "empty-frontier");
const singleFixture = path.join(skillDir, "fixtures", "single-ready");

function runCli(args, cwd = skillDir) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

test("cli chain requires feature", () => {
  const result = runCli(["chain", "--fake-launcher", "--once"]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /feature is required/);
});

test("cli short form: positional feature defaults to chain", () => {
  const result = runCli([
    "demo",
    "--cwd", emptyFixture,
    "--project-root", emptyFixture,
    "--fake-launcher",
    "--once",
    "--stop",
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"feature": "demo"/);
  assert.match(result.stdout, /"stopped": true/);
});

test("cli short form: chain <feature> positional", () => {
  const result = runCli([
    "chain",
    "demo",
    "--cwd", singleFixture,
    "--project-root", singleFixture,
    "--fake-launcher",
    "--once",
    "--stop",
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /soft-stuck|02-do-work/);
});

test("cli chain uses repo config runtime when --runtime omitted", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ic-runtime-"));
  try {
    cpSync(emptyFixture, root, { recursive: true });
    mkdirSync(path.join(root, ".issue-crusher"), { recursive: true });
    writeFileSync(
      path.join(root, ".issue-crusher", "config.json"),
      JSON.stringify({ mode: "review", runtime: "claude" }, null, 2) + "\n",
    );
    const result = runCli([
      "demo",
      "--cwd", root,
      "--project-root", root,
      "--fake-launcher",
      "--once",
      "--stop",
    ], root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /runtime:\s*claude/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
