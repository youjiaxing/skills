import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts");

// Installed skills are reached through a symlinked directory; the CLI must still run main().
for (const script of ["retro-ledger.mjs"]) {
  test(`${script} runs when invoked through a symlinked skill directory`, (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retro-entry-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const link = path.join(tmp, "skill-scripts");
    try {
      fs.symlinkSync(scriptsDir, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`cannot create directory link: ${error.code}`);
      return;
    }
    const output = execFileSync(process.execPath, ["--no-warnings", path.join(link, script), "--help"], { encoding: "utf8" });
    assert.match(output, /Usage:/);
  });
}
