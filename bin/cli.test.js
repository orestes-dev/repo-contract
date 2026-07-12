import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "cli.js");

const FORM = join(".github", "ISSUE_TEMPLATE", "task.yml");

// Run `cli.js init` (plus any extra args) with cwd set to `dir`.
function runInit(dir, ...args) {
  return spawnSync(process.execPath, [CLI, "init", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "iqg-init-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("init warns and still scaffolds when cwd is not a git root", () => {
  withTempDir((dir) => {
    const { status, stderr } = runInit(dir);
    assert.equal(status, 0);
    assert.match(stderr, /no \.git in the current directory/);
    assert.ok(existsSync(join(dir, ".github", "ISSUE_TEMPLATE", "task.yml")));
    assert.ok(
      existsSync(join(dir, ".github", "workflows", "issue-quality.yml")),
    );
  });
});

test("init does not warn when a .git entry is present", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, ".git"));
    const { status, stderr } = runInit(dir);
    assert.equal(status, 0);
    assert.doesNotMatch(stderr, /no \.git/);
  });
});

test("init is idempotent: a second run leaves identical files untouched", () => {
  withTempDir((dir) => {
    runInit(dir);
    const { status, stdout } = runInit(dir);
    assert.equal(status, 0);
    assert.match(stdout, /ok\s+.*task\.yml/);
    assert.match(stdout, /ok\s+.*issue-quality\.yml/);
  });
});

test("init fails loudly and writes nothing when a file has drifted", () => {
  withTempDir((dir) => {
    runInit(dir);
    const form = join(dir, FORM);
    writeFileSync(form, "locally edited\n");
    const { status, stdout, stderr } = runInit(dir);
    assert.equal(status, 1);
    assert.match(stdout, /stale\s+.*task\.yml/);
    assert.match(stdout, /ok\s+.*issue-quality\.yml/);
    assert.match(stderr, /Re-run with --force/);
    // Nothing written: the drifted file keeps its local content.
    assert.equal(readFileSync(form, "utf8"), "locally edited\n");
  });
});

test("init --force upgrades drifted files and skips identical ones", () => {
  withTempDir((dir) => {
    runInit(dir);
    const form = join(dir, FORM);
    const canonical = readFileSync(form, "utf8");
    writeFileSync(form, "locally edited\n");
    const { status, stdout } = runInit(dir, "--force");
    assert.equal(status, 0);
    assert.match(stdout, /update\s+.*task\.yml/);
    assert.match(stdout, /ok\s+.*issue-quality\.yml/);
    assert.equal(readFileSync(form, "utf8"), canonical);
  });
});
