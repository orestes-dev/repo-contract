// Tests for the vendored repo-contract git hooks shipped by `init`
// (templates/husky/*). Three concerns:
//   1. Drift: this repo's own `.husky/` copies stay byte-identical to the
//      canonical `templates/husky/` bundle, and `init` drops + repairs them.
//   2. Behavior: the shipped hooks block a bad commit and honor a
//      `.repo-contract.json` opt-out, quoting its reason (ADR 0002).
//   3. Activation: `init` points `core.hooksPath` at the relative `.husky` and
//      writes the hooks executable, so a checkout that never ran an install
//      enforces the baseline and a linked worktree runs its own committed hooks
//      (ADR 0012). Those two are exercised through a real `git commit`, since a
//      hook git never invokes is exactly the failure being regression-tested.
// The hooks are POSIX sh + git + jq only; the behavior tests invoke them with
// `sh -e` directly rather than through a commit, which is faster and equivalent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  existsSync,
  statSync,
  chmodSync,
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

// Every git invocation, `init` included, runs with the developer's global and
// system git config neutralized: `core.hooksPath` is exactly what these tests
// assert on, and a machine that sets it globally (the tier-1 agent-hygiene
// hooks do) would otherwise change what `init` reports.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

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
      spawnSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV });
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
    env: GIT_ENV,
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
        join(dir, ".repo-contract.json"),
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
        /skipConventionalCommits opt-out from \.repo-contract\.json \(true\)/,
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
        join(dir, ".repo-contract.json"),
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
        /maxAllowedEmDashes opt-out from \.repo-contract\.json \(1\)/,
      );
    });
  },
);

// --- activation: core.hooksPath, the executable bit, and real commits ---

const isExecutable = (path) => (statSync(path).mode & 0o111) !== 0;

const gitIn = (dir, ...args) =>
  spawnSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV });

const hooksPathOf = (dir) =>
  gitIn(dir, "config", "--get", "core.hooksPath").stdout.trim();

// Stage a file and attempt a real commit, so the assertion covers whether git
// invokes the hook at all, not just what the hook does once invoked.
function commitAttempt(dir, message, file = "a.txt") {
  writeFileSync(join(dir, file), `${Math.random()}\n`);
  gitIn(dir, "add", file);
  return gitIn(dir, "commit", "-m", message);
}

for (const name of HOOK_NAMES) {
  test(`the dogfood .husky/${name} is executable`, () => {
    assert.ok(isExecutable(join(ROOT, ".husky", name)));
  });
}

test("init sets core.hooksPath to the relative hook directory", () => {
  withGitRepo((dir) => {
    const { status, stdout } = initInto(dir);
    assert.equal(status, 0);
    assert.match(stdout, /create {3}core\.hooksPath=\.husky/);
    assert.equal(hooksPathOf(dir), ".husky");
    for (const name of HOOK_NAMES) {
      assert.ok(isExecutable(join(dir, ".husky", name)), `${name} not +x`);
    }
  });
});

test("init repairs an absolute core.hooksPath into a relative one", () => {
  withGitRepo((dir, git) => {
    git("config", "core.hooksPath", join(dir, ".husky", "_"));
    const { status, stdout } = initInto(dir);
    assert.equal(status, 0);
    assert.match(stdout, /repair\s+core\.hooksPath=\.husky \(was '\//);
    assert.match(stdout, /absolute/);
    assert.equal(hooksPathOf(dir), ".husky");
  });
});

test("init reports activation skipped outside a git repository", () => {
  withTempDir((dir) => {
    const { status, stdout } = initInto(dir);
    assert.equal(status, 0);
    assert.match(stdout, /skip\s+core\.hooksPath \(no git repository here\)/);
    assert.match(stdout, /git config core\.hooksPath \.husky/);
    // The closing summary reports what happened, never a live-hooks claim the
    // run did not earn.
    assert.match(stdout, /The git hooks are NOT active/);
    assert.doesNotMatch(stdout, /hooks are live/);
  });
});

// Regression (issue #79): a checkout that never ran a package-manager install
// has no husky shim and no node_modules. Before activation moved into `init`,
// git found nothing to run and the commit landed with enforcement silently
// absent. It must now be blocked.
test("a shim-less, never-installed checkout does not commit unenforced", () => {
  withGitRepo((dir, git) => {
    initInto(dir);
    assert.ok(!existsSync(join(dir, ".husky", "_")), "a husky shim exists");
    assert.ok(!existsSync(join(dir, "node_modules")), "node_modules exists");

    const onDefault = commitAttempt(dir, "feat(x): land on main");
    assert.notEqual(onDefault.status, 0);
    assert.match(onDefault.stderr, /default branch 'main'/);

    git("switch", "-c", "feat/x");
    const badSubject = commitAttempt(dir, "just some words");
    assert.notEqual(badSubject.status, 0);
    assert.match(badSubject.stderr, /Conventional Commits/);

    const good = commitAttempt(dir, "feat(x): a well-formed commit");
    assert.equal(good.status, 0, good.stderr);
  });
});

// Regression (issue #79): `core.hooksPath` lives in the shared `.git/config`,
// so an absolute value pins every linked worktree to one fixed checkout's hooks.
// With the relative value each worktree resolves `.husky` under its own root and
// runs the hooks committed on its own branch.
test("a linked worktree runs its own committed hooks, not the main checkout's", () => {
  withGitRepo((dir, git) => {
    initInto(dir);
    git("switch", "-c", "feat/base");
    git("add", "-A");
    assert.equal(git("commit", "-m", "feat(x): scaffold").status, 0);

    const wt = join(dir, "wt");
    git("worktree", "add", "-b", "feat/other", wt);

    // Replace the worktree branch's pre-commit with a marker that always fails.
    // Staging it needs --no-verify precisely because the hook it installs is the
    // one under test; this is fixture setup, not a sanctioned bypass.
    const marker = join(wt, ".husky", "pre-commit");
    writeFileSync(
      marker,
      "#!/usr/bin/env sh\necho WORKTREE_HOOK >&2\nexit 1\n",
    );
    chmodSync(marker, 0o755);
    gitIn(wt, "add", ".husky/pre-commit");
    gitIn(wt, "commit", "--no-verify", "-m", "chore: worktree marker hook");

    const inWorktree = commitAttempt(wt, "feat(x): from the worktree");
    assert.notEqual(inWorktree.status, 0);
    assert.match(inWorktree.stderr, /WORKTREE_HOOK/);

    // The main checkout is unaffected: its own branch's hook still governs, and
    // the worktree's marker never reaches it.
    const inMain = commitAttempt(dir, "feat(x): from the main checkout");
    assert.equal(inMain.status, 0, inMain.stderr);
    assert.doesNotMatch(inMain.stderr, /WORKTREE_HOOK/);
  });
});

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
