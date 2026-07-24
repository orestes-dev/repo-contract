// Tests for the `core.hooksPath` plumbing shared by `init` and `uninstall`.
// `ensureHooksPath` is also exercised end-to-end through a real `git commit` in
// `git-hooks.test.js`; here both halves of the shared ownership rule (ADR 0020)
// are unit-tested against a scratch repo's *local* config:
//   - `ensureHooksPath` (install side): unset -> set, managed -> ok, foreign ->
//     block, foreign + opt-in -> overwrite (printing the displaced value).
//   - `releaseHooksPath` (uninstall side): releases only this repo's own local
//     managed value and leaves anything else (a foreign local value, or the
//     global tier-1 hooks) exactly as it found it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HOOKS_PATH,
  ensureHooksPath,
  foreignHooksPath,
  releaseHooksPath,
} from "./hook-activation.js";

// A scratch git repo with an optional starting *local* `core.hooksPath`,
// auto-cleaned. Reads assert against the local scope, since a developer's global
// `core.hooksPath` (the tier-1 hooks) is inherited by every fresh repo's merged
// config and would mask an unset local value.
function withRepo(hooksPath) {
  const dir = mkdtempSync(join(tmpdir(), "rc-release-"));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  if (hooksPath !== undefined) {
    execFileSync("git", ["-C", dir, "config", "core.hooksPath", hooksPath], {
      stdio: "ignore",
    });
  }
  return dir;
}

const readLocal = (dir) =>
  execFileSync(
    "git",
    ["-C", dir, "config", "--local", "--get", "core.hooksPath"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim();

// `--local --get` exits 1 when the key is unset locally; treat that as "".
const readLocalOrEmpty = (dir) => {
  try {
    return readLocal(dir);
  } catch {
    return "";
  }
};

test("releaseHooksPath unsets the managed local value and reports it", () => {
  const dir = withRepo(HOOKS_PATH);
  try {
    const lines = [];
    const outcome = releaseHooksPath({ cwd: dir, log: (l) => lines.push(l) });
    assert.equal(outcome, "released");
    assert.equal(readLocalOrEmpty(dir), "", "local core.hooksPath is unset");
    assert.match(lines[0], /^unset\s+core\.hooksPath/);
    assert.match(lines[0], /handed back/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A local value repo-contract did not set is not ours to remove: an operator's
// own directory, or a legacy `.husky` no command migrates forward (ADR 0021).
test("releaseHooksPath leaves a foreign local value alone and reports it", () => {
  const dir = withRepo(".husky");
  try {
    const lines = [];
    const outcome = releaseHooksPath({ cwd: dir, log: (l) => lines.push(l) });
    assert.equal(outcome, "left");
    assert.equal(readLocalOrEmpty(dir), ".husky", "the foreign value survives");
    assert.match(lines[0], /^keep\s+core\.hooksPath=\.husky/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// With no local value, there is nothing repo-contract set to release: the global
// tier-1 hooks (if any) simply keep running, untouched.
test("releaseHooksPath is a no-op when no local core.hooksPath is set", () => {
  const dir = withRepo(undefined);
  try {
    const lines = [];
    const outcome = releaseHooksPath({ cwd: dir, log: (l) => lines.push(l) });
    assert.equal(outcome, "absent");
    assert.match(lines[0], /^ok\s+core\.hooksPath is not set in this repo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseHooksPath skips outside a git repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-release-nogit-"));
  try {
    const lines = [];
    const outcome = releaseHooksPath({ cwd: dir, log: (l) => lines.push(l) });
    assert.equal(outcome, "skipped");
    assert.match(lines[0], /^skip\s+core\.hooksPath \(no git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- ensureHooksPath: the install-side ownership rule (ADR 0020) ---

test("ensureHooksPath sets the managed value when local config leaves it unset", () => {
  const dir = withRepo(undefined);
  try {
    const lines = [];
    const outcome = ensureHooksPath({ cwd: dir, log: (l) => lines.push(l) });
    assert.equal(outcome, "created");
    assert.equal(readLocalOrEmpty(dir), HOOKS_PATH);
    assert.match(lines[0], /^create\s+core\.hooksPath=\.repo-contract\/hooks/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The whole reason ownership reads the *local* value, not the merged effective
// one: a global tier-1 `core.hooksPath` (the agent-hygiene hooks) is inherited by
// every fresh repo but is not repo-contract's to touch. Local unset under such a
// global must still set the managed value, never treat the global as foreign and
// block.
test("ensureHooksPath sets the managed value when only a global (tier-1) value exists", () => {
  const globalFile = mkdtempSync(join(tmpdir(), "rc-global-")) + "/config";
  writeFileSync(globalFile, "[core]\n\thooksPath = /some/tier1/hooks\n");
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  const savedSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = globalFile;
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  // Create the repo under the same global, so its local config starts unset.
  const dir = withRepo(undefined);
  try {
    assert.equal(foreignHooksPath(dir), "", "the global value is not foreign");
    const lines = [];
    const outcome = ensureHooksPath({ cwd: dir, log: (l) => lines.push(l) });
    assert.equal(outcome, "created");
    assert.equal(readLocalOrEmpty(dir), HOOKS_PATH);
  } finally {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = savedSystem;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureHooksPath is a no-op when the managed value is already set", () => {
  const dir = withRepo(HOOKS_PATH);
  try {
    const lines = [];
    const outcome = ensureHooksPath({ cwd: dir, log: (l) => lines.push(l) });
    assert.equal(outcome, "ok");
    assert.equal(readLocalOrEmpty(dir), HOOKS_PATH);
    assert.match(lines[0], /^ok\s+core\.hooksPath=\.repo-contract\/hooks/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A foreign value is left exactly as it was, and the block names both remedies.
test("ensureHooksPath blocks a foreign value and leaves it untouched", () => {
  const dir = withRepo(".husky");
  try {
    const lines = [];
    const outcome = ensureHooksPath({ cwd: dir, log: (l) => lines.push(l) });
    assert.equal(outcome, "blocked");
    assert.equal(readLocalOrEmpty(dir), ".husky", "the foreign value survives");
    const report = lines.join("\n");
    assert.match(report, /^block\s+core\.hooksPath=\.husky/);
    assert.match(report, /inert/);
    assert.match(report, /git config --local --unset core\.hooksPath/);
    assert.match(report, /--overwrite-hooks-path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The block is a discovery point, not just a refusal: whatever hook tool held
// `core.hooksPath` can keep running through the local chain, so the message says
// so, and says it without naming a tool, since the remedy is the same for all.
test("the foreign-value block points at the local chain, tool-agnostically", () => {
  // Not `.husky`: the block echoes the foreign value verbatim, so a husky value
  // would satisfy the "names no tool" assertion trivially and by accident.
  const dir = withRepo(".githooks");
  try {
    const lines = [];
    ensureHooksPath({ cwd: dir, log: (l) => lines.push(l) });
    const report = lines.join("\n");
    assert.match(
      report,
      /\.repo-contract\/hooks\/local\/\{pre-commit,commit-msg\}/,
    );
    assert.match(report, /keep running/);
    assert.doesNotMatch(report, /husky/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// An absolute value is foreign too, and the block flags the worktree-pinning hazard.
test("ensureHooksPath blocks an absolute value and names the worktree hazard", () => {
  const dir = withRepo("/etc/hooks");
  try {
    const lines = [];
    const outcome = ensureHooksPath({ cwd: dir, log: (l) => lines.push(l) });
    assert.equal(outcome, "blocked");
    assert.equal(readLocalOrEmpty(dir), "/etc/hooks");
    assert.match(lines.join("\n"), /absolute/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The opt-in adopts the foreign value and prints the one it displaced, since a
// local core.hooksPath is uncommitted and cannot be recovered.
test("ensureHooksPath overwrites a foreign value under the opt-in and prints the displaced one", () => {
  const dir = withRepo(".husky");
  try {
    const lines = [];
    const outcome = ensureHooksPath({
      cwd: dir,
      log: (l) => lines.push(l),
      overwrite: true,
    });
    assert.equal(outcome, "overwritten");
    assert.equal(readLocalOrEmpty(dir), HOOKS_PATH);
    const report = lines.join("\n");
    assert.match(report, /^overwrite core\.hooksPath=\.repo-contract\/hooks/);
    assert.match(report, /displaced '\.husky'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The opt-in is inert where there is nothing foreign to adopt: an unset value is
// simply created, not "overwritten".
test("ensureHooksPath with the opt-in still just creates an unset value", () => {
  const dir = withRepo(undefined);
  try {
    const lines = [];
    const outcome = ensureHooksPath({
      cwd: dir,
      log: (l) => lines.push(l),
      overwrite: true,
    });
    assert.equal(outcome, "created");
    assert.equal(readLocalOrEmpty(dir), HOOKS_PATH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureHooksPath skips outside a git repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-ensure-nogit-"));
  try {
    const lines = [];
    const outcome = ensureHooksPath({ cwd: dir, log: (l) => lines.push(l) });
    assert.equal(outcome, "skipped");
    assert.match(lines[0], /^skip\s+core\.hooksPath \(no git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
