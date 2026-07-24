// Tests for the vendored repo-contract git hooks shipped by `init`
// (templates/git-hooks/*). Three concerns:
//   1. Drift: this repo's own `.repo-contract/hooks/` copies stay
//      byte-identical to the canonical `templates/git-hooks/` bundle, and
//      `init` drops + repairs them.
//   2. Behavior: the shipped hooks block a bad commit and honor a
//      `.repo-contract.json` opt-out, quoting its reason (ADR 0002).
//   3. Activation: `init` points `core.hooksPath` at the relative
//      `.repo-contract/hooks` and writes the hooks executable, so a checkout
//      that never ran an install
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

// Run a shipped hook the way git does: `sh -e <hook> [args]` with cwd at the repo.
function runHook(dir, name, ...args) {
  return spawnSync(
    "sh",
    ["-e", join(dir, ".repo-contract", "hooks", name), ...args],
    {
      cwd: dir,
      encoding: "utf8",
    },
  );
}

function initInto(dir, ...args) {
  return spawnSync(process.execPath, [CLI, "init", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: GIT_ENV,
  });
}

// --- init: drops the hooks, and --force repairs a tampered vendored hook ---

test("init drops both repo-contract hooks into a fresh repo", () => {
  withTempDir((dir) => {
    const { status } = initInto(dir);
    assert.equal(status, 0);
    for (const name of HOOK_NAMES) {
      const dest = join(dir, ".repo-contract", "hooks", name);
      assert.ok(existsSync(dest), `${name} was not created`);
      assert.equal(
        readFileSync(dest, "utf8"),
        read(join("templates", "git-hooks", name)),
      );
    }
  });
});

test("init reports a tampered hook as stale and --force repairs it", () => {
  withTempDir((dir) => {
    initInto(dir);
    const dest = join(dir, ".repo-contract", "hooks", "pre-commit");
    const canonical = readFileSync(dest, "utf8");
    writeFileSync(dest, "#!/usr/bin/env sh\nexit 0\n");
    const plain = initInto(dir);
    assert.equal(plain.status, 1);
    assert.match(plain.stdout, /stale\s+.*\.repo-contract\/hooks\/pre-commit/);
    const forced = initInto(dir, "--force");
    assert.equal(forced.status, 0);
    assert.match(
      forced.stdout,
      /update\s+.*\.repo-contract\/hooks\/pre-commit/,
    );
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
  test(`the dogfood .repo-contract/hooks/${name} is executable`, () => {
    assert.ok(isExecutable(join(ROOT, ".repo-contract", "hooks", name)));
  });
}

test("init sets core.hooksPath to the relative hook directory", () => {
  withGitRepo((dir) => {
    const { status, stdout } = initInto(dir);
    assert.equal(status, 0);
    assert.match(stdout, /create {3}core\.hooksPath=\.repo-contract\/hooks/);
    assert.equal(hooksPathOf(dir), ".repo-contract/hooks");
    for (const name of HOOK_NAMES) {
      assert.ok(
        isExecutable(join(dir, ".repo-contract", "hooks", name)),
        `${name} not +x`,
      );
    }
  });
});

// A foreign local value is one repo-contract did not write. It is not repointed
// on a routine run (ADR 0020): the git-hooks scaffold is blocked in the
// pre-flight, none of its files are written, and the run exits non-zero — while
// the other scaffolds still install.
test("init blocks git-hooks on a foreign core.hooksPath and writes none of its files", () => {
  withGitRepo((dir, git) => {
    git("config", "core.hooksPath", ".husky");
    const { status, stdout } = initInto(dir);
    assert.notEqual(status, 0, "the block exits non-zero");
    assert.match(stdout, /block\s+core\.hooksPath=\.husky/);
    assert.match(stdout, /--overwrite-hooks-path/);
    assert.match(stdout, /git config --local --unset core\.hooksPath/);
    // The foreign value is left exactly as it was, and no hook files were laid down.
    assert.equal(hooksPathOf(dir), ".husky");
    for (const name of HOOK_NAMES) {
      assert.ok(
        !existsSync(join(dir, ".repo-contract", "hooks", name)),
        `${name} was written despite the block`,
      );
    }
    // The other scaffolds install regardless of local git config.
    assert.ok(
      existsSync(join(dir, ".github", "workflows", "issue-quality.yml")),
      "a non-hooks scaffold was blocked too",
    );
    assert.match(stdout, /create .github\/workflows\/issue-quality\.yml/);
    // The manifest records what landed: the other scaffolds, never the withheld
    // git-hooks (the honest "manifest = installed" contract).
    const manifest = JSON.parse(
      readFileSync(join(dir, ".repo-contract.json"), "utf8"),
    );
    assert.deepEqual(manifest.scaffolds, ["quality-gates", "commit-hygiene"]);
  });
});

// An absolute value is foreign like any other now: repo-contract only ever writes
// the relative form, so it never authored an absolute one. It blocks rather than
// being silently relativised, and the block names the worktree-pinning hazard.
test("init blocks an absolute core.hooksPath rather than relativising it", () => {
  withGitRepo((dir, git) => {
    git("config", "core.hooksPath", join(dir, ".repo-contract", "hooks"));
    const { status, stdout } = initInto(dir);
    assert.notEqual(status, 0);
    assert.match(stdout, /block\s+core\.hooksPath=\//);
    assert.match(stdout, /absolute/);
    assert.equal(hooksPathOf(dir), join(dir, ".repo-contract", "hooks"));
  });
});

// The explicit, separately-named opt-in adopts a foreign value, writes the hook
// files, and prints the displaced value (uncommitted, so unrecoverable).
test("--overwrite-hooks-path adopts a foreign value and prints the one it displaced", () => {
  withGitRepo((dir, git) => {
    git("config", "core.hooksPath", ".husky");
    const { status, stdout } = initInto(dir, "--overwrite-hooks-path");
    assert.equal(status, 0);
    assert.match(stdout, /overwrite core\.hooksPath=\.repo-contract\/hooks/);
    assert.match(stdout, /displaced '\.husky'/);
    assert.equal(hooksPathOf(dir), ".repo-contract/hooks");
    for (const name of HOOK_NAMES) {
      assert.ok(
        isExecutable(join(dir, ".repo-contract", "hooks", name)),
        `${name} not +x`,
      );
    }
  });
});

// A hooks-only selection that hits a foreign value blocks and installs nothing:
// there is no other scaffold to carry the run, so the exit is non-zero and clean.
test("--only git-hooks on a foreign value blocks with nothing installed", () => {
  withGitRepo((dir, git) => {
    git("config", "core.hooksPath", ".husky");
    const { status, stdout } = initInto(dir, "--only", "git-hooks");
    assert.notEqual(status, 0);
    assert.match(stdout, /block\s+core\.hooksPath=\.husky/);
    assert.equal(hooksPathOf(dir), ".husky");
    // Nothing landed, so there is nothing to record and no manifest is written.
    assert.ok(
      !existsSync(join(dir, ".repo-contract.json")),
      "a manifest was written for a run that installed nothing",
    );
  });
});

test("init reports activation skipped outside a git repository", () => {
  withTempDir((dir) => {
    const { status, stdout } = initInto(dir);
    assert.equal(status, 0);
    assert.match(stdout, /skip\s+core\.hooksPath \(no git repository here\)/);
    assert.match(stdout, /git config core\.hooksPath \.repo-contract\/hooks/);
    // The closing summary reports what happened, never a live-hooks claim the
    // run did not earn.
    assert.match(stdout, /The git hooks are NOT active/);
    assert.doesNotMatch(stdout, /hooks are live/);
  });
});

// Regression (issue #79): a checkout that never ran a package-manager install
// has no generated shim and no node_modules. Before activation moved into
// `init`, git found nothing to run and the commit landed with enforcement
// silently absent. It must now be blocked.
test("a shim-less, never-installed checkout does not commit unenforced", () => {
  withGitRepo((dir, git) => {
    initInto(dir);
    assert.ok(
      !existsSync(join(dir, ".repo-contract", "hooks", "_")),
      "a generated shim exists",
    );
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
// With the relative value each worktree resolves `.repo-contract/hooks` under its own root and
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
    const marker = join(wt, ".repo-contract", "hooks", "pre-commit");
    writeFileSync(
      marker,
      "#!/usr/bin/env sh\necho WORKTREE_HOOK >&2\nexit 1\n",
    );
    chmodSync(marker, 0o755);
    gitIn(wt, "add", ".repo-contract/hooks/pre-commit");
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

test("pre-commit chains to an optional .repo-contract/hooks/local extension", () => {
  withGitRepo((dir, git) => {
    initInto(dir);
    git("switch", "-c", "feat/x");
    mkdirSync(join(dir, ".repo-contract", "hooks", "local"), {
      recursive: true,
    });
    writeFileSync(
      join(dir, ".repo-contract", "hooks", "local", "pre-commit"),
      "echo LOCAL_RAN\nexit 0\n",
    );
    writeFileSync(join(dir, "a.txt"), "x\n");
    git("add", "a.txt");
    const { status, stdout } = runHook(dir, "pre-commit");
    assert.equal(status, 0);
    assert.match(stdout, /LOCAL_RAN/);
  });
});
