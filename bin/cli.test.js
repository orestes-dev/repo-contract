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

import { goodBody as PASSING_ISSUE_BODY } from "../src/fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "cli.js");

const FORM = join(".github", "ISSUE_TEMPLATE", "task.yml");
const PR_FORM = join(".github", "PULL_REQUEST_TEMPLATE.md");
const PR_WORKFLOW = join(".github", "workflows", "pr-readiness.yml");

// Run `cli.js init` (plus any extra args) with cwd set to `dir`.
function runInit(dir, ...args) {
  return spawnSync(process.execPath, [CLI, "init", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
}

// Run `cli.js <args>` with cwd set to `dir`, for the file-oriented commands.
function runCli(dir, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: "utf8",
  });
}

// A PR body that passes every local structural check: every required section
// present and non-empty, no Divergence flagged.
const PASSING_PR_BODY = [
  "## Summary",
  "Adds the validate-pr preflight command.",
  "",
  "## Verification",
  "`yarn test` is green.",
  "",
  "## Scope",
  "The bin/ CLI only.",
  "",
  "## Decisions",
  "None; mirrors the existing validate command.",
  "",
].join("\n");

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
    assert.ok(existsSync(join(dir, ".template.issue.md")));
    assert.ok(
      existsSync(join(dir, ".github", "workflows", "issue-quality.yml")),
    );
    assert.ok(existsSync(join(dir, PR_FORM)));
    assert.ok(existsSync(join(dir, ".template.pr.md")));
    assert.ok(existsSync(join(dir, PR_WORKFLOW)));
  });
});

test("init prints the Suggested rule naming both Forms and validate-pr, writing it nowhere", () => {
  withTempDir((dir) => {
    const { status, stdout } = runInit(dir);
    assert.equal(status, 0);
    assert.match(stdout, /Suggested rule/);
    assert.match(stdout, /\.template\.issue\.md/);
    assert.match(stdout, /\.template\.pr\.md/);
    assert.match(stdout, /validate-issue/);
    assert.match(stdout, /validate-pr/);
    // Stdout-only: no rules file is written into the repo.
    assert.ok(!existsSync(join(dir, "AGENTS.md")));
    assert.ok(!existsSync(join(dir, "CLAUDE.md")));
  });
});

test("init --force upgrades a drifted PR Form", () => {
  withTempDir((dir) => {
    runInit(dir);
    const prForm = join(dir, PR_FORM);
    const canonical = readFileSync(prForm, "utf8");
    writeFileSync(prForm, "locally edited\n");
    const plain = runInit(dir);
    assert.equal(plain.status, 1);
    assert.match(plain.stdout, /stale\s+.*PULL_REQUEST_TEMPLATE\.md/);
    const forced = runInit(dir, "--force");
    assert.equal(forced.status, 0);
    assert.match(forced.stdout, /update\s+.*PULL_REQUEST_TEMPLATE\.md/);
    assert.equal(readFileSync(prForm, "utf8"), canonical);
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

test("validate-issue passes a well-formed issue body with a conventional title", () => {
  withTempDir((dir) => {
    const file = join(dir, "issue.md");
    writeFileSync(file, PASSING_ISSUE_BODY);
    const { status, stdout } = runCli(
      dir,
      "validate-issue",
      "issue.md",
      "--title",
      "feat(search): debounce the query input",
    );
    assert.equal(status, 0);
    assert.match(stdout, /Issue quality gate: passed/);
  });
});

test("validate-issue exits 2 on a usage error when no file is given", () => {
  withTempDir((dir) => {
    const { status, stderr } = runCli(dir, "validate-issue");
    assert.equal(status, 2);
    assert.match(stderr, /usage: quality-gate validate-issue <file>/);
  });
});

test("validate is no longer a command and hits the usage-error path", () => {
  withTempDir((dir) => {
    const file = join(dir, "issue.md");
    writeFileSync(file, PASSING_ISSUE_BODY);
    const { status, stderr } = runCli(dir, "validate", "issue.md");
    assert.equal(status, 2);
    assert.match(
      stderr,
      /usage: quality-gate <init\|validate-issue\|validate-pr\|sweep>/,
    );
  });
});

test("validate-pr passes a well-formed PR body with a conventional title", () => {
  withTempDir((dir) => {
    const file = join(dir, "pr.md");
    writeFileSync(file, PASSING_PR_BODY);
    const { status, stdout } = runCli(
      dir,
      "validate-pr",
      "pr.md",
      "--title",
      "feat(cli): add validate-pr preflight command",
    );
    assert.equal(status, 0);
    assert.match(stdout, /PR readiness gate: passed/);
  });
});

test("validate-pr exits 1 on a missing required section", () => {
  withTempDir((dir) => {
    const file = join(dir, "pr.md");
    writeFileSync(file, "## Summary\nOnly a summary, no verification.\n");
    const { status, stdout } = runCli(
      dir,
      "validate-pr",
      "pr.md",
      "--title",
      "feat(cli): add validate-pr preflight command",
    );
    assert.equal(status, 1);
    assert.match(stdout, /PR readiness gate: FAILED/);
    assert.match(stdout, /Verification/);
  });
});

test("validate-pr exits 2 on a usage error when no file is given", () => {
  withTempDir((dir) => {
    const { status, stderr } = runCli(dir, "validate-pr");
    assert.equal(status, 2);
    assert.match(stderr, /usage: quality-gate validate-pr <file>/);
  });
});

test("help prints usage to stdout and exits 0", () => {
  for (const arg of ["help", "--help", "-h"]) {
    const { status, stdout, stderr } = runCli(ROOT, arg);
    assert.equal(status, 0, `${arg} should exit 0`);
    assert.match(
      stdout,
      /usage: quality-gate <init\|validate-issue\|validate-pr\|sweep>/,
    );
    assert.equal(stderr, "");
  }
});

test("an unknown command prints usage to stderr and exits 2", () => {
  const { status, stdout, stderr } = runCli(ROOT, "bogus");
  assert.equal(status, 2);
  assert.match(
    stderr,
    /usage: quality-gate <init\|validate-issue\|validate-pr\|sweep>/,
  );
  assert.equal(stdout, "");
});

test("usage lists the supported commands and drops the removed scaffold command", () => {
  const { status, stderr } = runCli(ROOT, "bogus");
  assert.equal(status, 2);
  assert.match(stderr, /init\|validate-issue\|validate-pr\|sweep/);
  // "scaffold" survives only as the verb in init's description, never as a
  // command line of its own.
  assert.doesNotMatch(stderr, /^\s*scaffold\s/m);
});
