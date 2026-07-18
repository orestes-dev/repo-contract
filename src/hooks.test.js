// Tests for the vendored repo-contract git hooks shipped by `init`
// (templates/husky/*). Three concerns:
//   1. Drift: this repo's own `.husky/` copies stay byte-identical to the
//      canonical `templates/husky/` bundle, and `init` drops + repairs them.
//   2. Behavior: the shipped hooks block a bad commit and honor a
//      `.quality-gate.json` opt-out, quoting its reason (ADR 0002).
// The hooks are POSIX sh + git + jq only; husky runs them with `sh -e`, so the
// tests invoke them the same way rather than through a real husky install.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "cli.js");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const HOOK_NAMES = ["commit-msg", "pre-commit"];
const jqAvailable =
  spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qg-hooks-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A temp git repo on `main` (the default branch), for the pre-commit hook whose
// checks read branch and staged state.
function withGitRepo(fn) {
  withTempDir((dir) => {
    const git = (...args) =>
      spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-b", "main");
    git("config", "user.email", "t@t.io");
    git("config", "user.name", "t");
    fn(dir, git);
  });
}

// Run a shipped hook the way husky does: `sh -e <hook> [args]` with cwd at the repo.
function runHook(dir, name, ...args) {
  return spawnSync("sh", ["-e", join(dir, ".husky", name), ...args], {
    cwd: dir,
    encoding: "utf8",
  });
}

function initInto(dir, ...args) {
  return spawnSync(process.execPath, [CLI, "init", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
}

// --- drift: the dogfood .husky hooks are byte-identical to the bundle ---

// `init` writes each canonical hook to `.husky/<name>` verbatim; this repo's own
// copies are its dogfood instance, so each must stay byte-identical to the bundle
// or the hooks a consumer gets drift from the ones this repo runs (ADR 0002/0003).
for (const name of HOOK_NAMES) {
  test(`the dogfood .husky/${name} is byte-identical to the templates bundle`, () => {
    assert.equal(
      read(join(".husky", name)),
      read(join("templates", "husky", name)),
    );
  });
}

// --- init: drops the hooks, and --force repairs a tampered vendored hook ---

test("init drops both repo-contract hooks into a fresh repo", () => {
  withTempDir((dir) => {
    const { status } = initInto(dir);
    assert.equal(status, 0);
    for (const name of HOOK_NAMES) {
      const dest = join(dir, ".husky", name);
      assert.ok(existsSync(dest), `${name} was not created`);
      assert.equal(
        readFileSync(dest, "utf8"),
        read(join("templates", "husky", name)),
      );
    }
  });
});

test("init reports a tampered hook as stale and --force repairs it", () => {
  withTempDir((dir) => {
    initInto(dir);
    const dest = join(dir, ".husky", "pre-commit");
    const canonical = readFileSync(dest, "utf8");
    writeFileSync(dest, "#!/usr/bin/env sh\nexit 0\n");
    const plain = initInto(dir);
    assert.equal(plain.status, 1);
    assert.match(plain.stdout, /stale\s+.*\.husky\/pre-commit/);
    const forced = initInto(dir, "--force");
    assert.equal(forced.status, 0);
    assert.match(forced.stdout, /update\s+.*\.husky\/pre-commit/);
    assert.equal(readFileSync(dest, "utf8"), canonical);
  });
});

// --- behavior: commit-msg ---

function writeMsg(dir, text) {
  const f = join(dir, "MSG");
  writeFileSync(f, text);
  return f;
}

test("commit-msg passes a Conventional Commits subject", () => {
  withTempDir((dir) => {
    initInto(dir);
    const f = writeMsg(dir, "feat(hooks): ship repo-contract hooks\n");
    assert.equal(runHook(dir, "commit-msg", f).status, 0);
  });
});

test("commit-msg blocks a non-conventional subject", () => {
  withTempDir((dir) => {
    initInto(dir);
    const f = writeMsg(dir, "just some words\n");
    const { status, stderr } = runHook(dir, "commit-msg", f);
    assert.equal(status, 1);
    assert.match(stderr, /Conventional Commits/);
  });
});

test("commit-msg blocks an em-dash in the message", () => {
  withTempDir((dir) => {
    initInto(dir);
    const f = writeMsg(dir, "feat(x): add a thing — with an em-dash\n");
    const { status, stderr } = runHook(dir, "commit-msg", f);
    assert.equal(status, 1);
    assert.match(stderr, /em-dash/);
  });
});

test(
  "commit-msg honors a skipConventionalCommits opt-out and quotes its reason",
  { skip: !jqAvailable },
  () => {
    withTempDir((dir) => {
      initInto(dir);
      const reason = "legacy import commits predate the convention";
      writeFileSync(
        join(dir, ".quality-gate.json"),
        JSON.stringify({
          overrides: { skipConventionalCommits: { value: true, reason } },
        }),
      );
      const f = writeMsg(dir, "just some words\n");
      const { status, stderr } = runHook(dir, "commit-msg", f);
      assert.equal(status, 0);
      assert.match(stderr, /bypassed/);
      assert.match(stderr, new RegExp(reason));
      assert.match(
        stderr,
        /skipConventionalCommits opt-out from \.quality-gate\.json \(true\)/,
      );
    });
  },
);

// --- behavior: pre-commit ---

test("pre-commit blocks a commit on the default branch", () => {
  withGitRepo((dir, git) => {
    initInto(dir);
    writeFileSync(join(dir, "a.txt"), "x\n");
    git("add", "a.txt");
    const { status, stderr } = runHook(dir, "pre-commit");
    assert.equal(status, 1);
    assert.match(stderr, /default branch 'main'/);
  });
});

test("pre-commit allows a commit on a feature branch", () => {
  withGitRepo((dir, git) => {
    initInto(dir);
    git("switch", "-c", "feat/x");
    writeFileSync(join(dir, "a.txt"), "x\n");
    git("add", "a.txt");
    assert.equal(runHook(dir, "pre-commit").status, 0);
  });
});

test("pre-commit blocks an em-dash in staged markdown", () => {
  withGitRepo((dir, git) => {
    initInto(dir);
    git("switch", "-c", "feat/x");
    writeFileSync(join(dir, "doc.md"), "a line — with an em-dash\n");
    git("add", "doc.md");
    const { status, stderr } = runHook(dir, "pre-commit");
    assert.equal(status, 1);
    assert.match(stderr, /em-dash/);
  });
});

test(
  "pre-commit honors a maxAllowedEmDashes budget and quotes its reason",
  { skip: !jqAvailable },
  () => {
    withGitRepo((dir, git) => {
      initInto(dir);
      git("switch", "-c", "feat/x");
      const reason = "AGENTS.md is generated and contains one em-dash";
      writeFileSync(
        join(dir, ".quality-gate.json"),
        JSON.stringify({
          overrides: { maxAllowedEmDashes: { value: 1, reason } },
        }),
      );
      writeFileSync(join(dir, "doc.md"), "a line — within budget\n");
      git("add", "doc.md");
      const { status, stderr } = runHook(dir, "pre-commit");
      assert.equal(status, 0);
      assert.match(stderr, new RegExp(reason));
      assert.match(
        stderr,
        /maxAllowedEmDashes opt-out from \.quality-gate\.json \(1\)/,
      );
    });
  },
);

test("pre-commit chains to an optional .husky/local extension", () => {
  withGitRepo((dir, git) => {
    initInto(dir);
    git("switch", "-c", "feat/x");
    mkdirSync(join(dir, ".husky", "local"), { recursive: true });
    writeFileSync(
      join(dir, ".husky", "local", "pre-commit"),
      "echo LOCAL_RAN\nexit 0\n",
    );
    writeFileSync(join(dir, "a.txt"), "x\n");
    git("add", "a.txt");
    const { status, stdout } = runHook(dir, "pre-commit");
    assert.equal(status, 0);
    assert.match(stdout, /LOCAL_RAN/);
  });
});
