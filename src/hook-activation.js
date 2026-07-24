// Hook activation (CONTEXT.md): the `core.hooksPath` plumbing that decides
// whether the vendored `git-hooks` scaffold actually runs, split out from
// `init` so both `init` (which claims the managed path) and `uninstall` (which
// hands it back) share one constant and one reader rather than importing one
// command from another (ADR 0012, ADR 0017).
//
// Distinct from the shipped **Hook** scripts (`templates/git-hooks/*`): this
// module owns where git looks for them and their executable bit, never their
// contents. `git-hooks.test.js` black-boxes the scripts; this file's behaviour
// is covered in `hook-activation.test.js`.

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

// Activation (ADR 0012). Vendoring a hook file only guarantees it can *run*;
// git runs it only once `core.hooksPath` points at the directory holding it.
// `init` sets that itself so a checkout that never ran a package-manager install
// (fresh clone, linked worktree, container) still enforces the baseline.
//
// The value is deliberately RELATIVE. `core.hooksPath` lives in the shared
// `.git/config`, so an absolute path pins every linked worktree to one fixed
// checkout's hooks; git resolves a relative one against the worktree root, so
// each worktree runs the hooks committed on its own branch (githooks(5): git
// chdirs to the worktree root before invoking a hook).
//
// The target is `.repo-contract/hooks`: the vendored hooks are executable POSIX
// sh, so git can exec them directly with no shim, no `node_modules`, and no
// install step. The directory is namespaced under `.repo-contract/` rather than
// named `.husky` or `.githooks` because a vendoring tool must not claim a name a
// consumer may already own for its own hooks (ADR 0017).
//
// A literal, not a `join()`: this is a git config value, not a filesystem path,
// and it must match the forward-slash form the `prepare` script and the docs
// tell a consumer to set by hand.
export const HOOKS_PATH = ".repo-contract/hooks";

/**
 * Read `core.hooksPath` as it applies to this checkout, or `""` when unset.
 * `git config --get` exits 1 on a missing key, which is not an error here. This
 * reads the *effective* value (local over global over system), which is what a
 * git hook actually runs against: `init` repairs whatever this resolves to, and
 * `findOrphans` asks it "is this still enforcing?".
 * @param {string} cwd
 * @returns {string}
 */
export function readHooksPath(cwd) {
  try {
    return execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Read `core.hooksPath` from *this repo's own* config only (never global or
 * system), or `""` when unset there. `init` writes activation to the local scope
 * (a per-clone setting, never committed), so this is the value that answers "did
 * repo-contract set this?" — as opposed to a tier-1 global `core.hooksPath` that
 * `uninstall` must hand back to, not clobber.
 * @param {string} cwd
 * @returns {string}
 */
function readLocalHooksPath(cwd) {
  try {
    return execFileSync(
      "git",
      ["config", "--local", "--get", "core.hooksPath"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return "";
  }
}

/**
 * Point `core.hooksPath` at the vendored hook directory, so the files `init`
 * just wrote actually run (ADR 0012, ADR 0017). Sets the relative
 * `.repo-contract/hooks`, and repairs any other value, including a legacy
 * `.husky`/`.husky/_` and any absolute path that would make every linked
 * worktree run one fixed checkout's hooks.
 *
 * Reports the outcome as one line, the way the file and label loops do. Outside
 * a git repository there is nothing to configure: say so loudly (the hooks are
 * inert until someone sets it) and leave the exit code alone, since scaffolding
 * into a directory before `git init` is legitimate. A `git config` that fails
 * where a repository *does* exist is fatal: silently leaving enforcement off is
 * the exact failure mode this step exists to remove.
 * @param {object} params
 * @param {string} [params.cwd]
 * @param {(line: string) => void} params.log
 * @returns {string} `skipped`, `ok`, `created`, or `repaired`.
 */
export function ensureHooksPath({ cwd = process.cwd(), log }) {
  if (!existsSync(resolve(cwd, ".git"))) {
    log(
      `skip     core.hooksPath (no git repository here). The vendored hooks will\n` +
        `         not run until you set it: git config core.hooksPath ${HOOKS_PATH}`,
    );
    return "skipped";
  }

  const current = readHooksPath(cwd);
  if (current === HOOKS_PATH) {
    log(`ok       core.hooksPath=${HOOKS_PATH}`);
    return "ok";
  }

  try {
    execFileSync("git", ["config", "core.hooksPath", HOOKS_PATH], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    console.error(
      `\nerror: could not set core.hooksPath to ${HOOKS_PATH} (${error instanceof Error ? error.message : String(error)}).\n` +
        "The vendored hooks are on disk but git will not run them, so the commit " +
        "baseline is NOT enforced in this checkout. Fix the git config, or run " +
        `\`git config core.hooksPath ${HOOKS_PATH}\` by hand, and re-run init.`,
    );
    process.exit(1);
  }

  if (current === "") {
    log(`create   core.hooksPath=${HOOKS_PATH}`);
    return "created";
  }
  const why = isAbsolute(current)
    ? "absolute, so every linked worktree ran this one checkout's hooks"
    : "did not point at the vendored hooks";
  log(`repair   core.hooksPath=${HOOKS_PATH} (was '${current}': ${why})`);
  return "repaired";
}

/**
 * Hand activation back when the `git-hooks` scaffold is uninstalled: unset this
 * repo's *local* `core.hooksPath` only where it still holds the managed
 * `.repo-contract/hooks` value, so a global tier-1 `core.hooksPath` (or none)
 * takes over again. The mirror image of {@link ensureHooksPath}, and as
 * conservative on the way out as that is assertive on the way in: `init` claims
 * the local value, `uninstall` releases only that.
 *
 * Scoped to the local config on purpose. `init` never writes global or system
 * config, so a `core.hooksPath` there belongs to the operator (the tier-1
 * agent-hygiene hooks, precisely what should resume once the repo's own value is
 * gone) and is out of bounds. A *local* value that is not `.repo-contract/hooks`
 * is likewise left alone and reported: `uninstall` releases only the value it
 * set, and touches nothing it did not, so anything else here (an operator's own
 * directory, or a leftover from a prior install) is not ours to delete. Outside a
 * git repository, or with no local value set, there is nothing to release; say
 * so and move on.
 * @param {object} params
 * @param {string} [params.cwd]
 * @param {(line: string) => void} params.log
 * @returns {string} `skipped`, `absent`, `released`, or `left`.
 */
export function releaseHooksPath({ cwd = process.cwd(), log }) {
  if (!existsSync(resolve(cwd, ".git"))) {
    log("skip     core.hooksPath (no git repository here; nothing to unset)");
    return "skipped";
  }

  const local = readLocalHooksPath(cwd);
  if (local === "") {
    log(
      "ok       core.hooksPath is not set in this repo's config; nothing to unset",
    );
    return "absent";
  }
  if (local !== HOOKS_PATH) {
    log(
      `keep     core.hooksPath=${local} (not the ${HOOKS_PATH} value repo-contract sets, so left alone)`,
    );
    return "left";
  }

  try {
    execFileSync("git", ["config", "--local", "--unset", "core.hooksPath"], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    console.error(
      `\nerror: could not unset core.hooksPath (${error instanceof Error ? error.message : String(error)}).\n` +
        `The vendored hooks are being removed but git still points at ${HOOKS_PATH}, so it will ` +
        "log a hint on every commit until you run `git config --local --unset core.hooksPath` by hand.",
    );
    process.exit(1);
  }
  log(
    `unset    core.hooksPath (was ${HOOKS_PATH}); activation handed back to any global hooks`,
  );
  return "released";
}
