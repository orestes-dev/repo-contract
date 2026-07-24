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

// The consumer-owned extension point the vendored hooks call last (CONTEXT.md,
// `templates/git-hooks/pre-commit`). Named here because the foreign-value block
// has to point a displaced operator at it: `core.hooksPath` is single-valued, so
// taking the slot displaces whatever hook tool held it, and this chain is how
// those hooks keep running. Deliberately tool-agnostic; naming husky (or any
// other tool) would re-narrow a remedy that applies to all of them.
//
// Module-local: the chain is consumer-owned, so no other module here reads or
// writes it, and only this message needs to name it.
const LOCAL_CHAIN = `${HOOKS_PATH}/local`;

/**
 * Read `core.hooksPath` as it applies to this checkout, or `""` when unset.
 * `git config --get` exits 1 on a missing key, which is not an error here. This
 * reads the *effective* value (local over global over system), which is what a
 * git hook actually runs against, so `findOrphans` asks it "is this still
 * enforcing?". `init`'s own write path reads the *local* value instead
 * ({@link foreignHooksPath}), since ownership is a per-repo fact and a global
 * tier-1 value is not repo-contract's to touch (ADR 0020).
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
 * `uninstall` must hand back to, not clobber. Both `init` and `uninstall` decide
 * ownership from this local value, never the merged effective one (ADR 0020).
 * @param {string} cwd
 * @returns {string}
 */
export function readLocalHooksPath(cwd) {
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
 * This repo's *local* `core.hooksPath` when it is **foreign** — set to anything
 * other than the managed `.repo-contract/hooks` — else `""`. Unset and
 * already-managed both return `""`, since neither blocks `init`.
 *
 * This is the single ownership equality (ADR 0020), surfaced for `init`'s
 * pre-flight to gate the `git-hooks` scaffold on before it writes anything: a
 * foreign value means an activation `init` does not own, so the vendored hooks
 * would sit inert. A `.husky`, an operator's own directory, and any absolute
 * path are all foreign alike; repo-contract only ever *writes* the relative
 * managed value, so it never authored anything else. Outside a git repository
 * the local read is empty, so this is `""` and nothing is blocked
 * ({@link ensureHooksPath} reports the no-repo case).
 * @param {string} cwd
 * @returns {string} The foreign value, or `""` when unset or already managed.
 */
export function foreignHooksPath(cwd) {
  const local = readLocalHooksPath(cwd);
  return local === "" || local === HOOKS_PATH ? "" : local;
}

/**
 * Point `core.hooksPath` at the vendored hook directory, so the files `init`
 * just wrote actually run (ADR 0012, ADR 0017, ADR 0020). Owns only the value it
 * set: it writes the relative `.repo-contract/hooks` when this repo's *local*
 * config leaves it unset, leaves the managed value in place when it already
 * holds it, and refuses to touch a **foreign** value (one repo-contract did not
 * write) unless the caller passed an explicit `overwrite` opt-in.
 *
 * The ownership test reads the *local* value only (never the merged effective
 * one), the mirror of `releaseHooksPath` on the way out. A foreign value with no
 * opt-in reports the block and returns without writing; `init`'s pre-flight
 * withholds the `git-hooks` files in that same case, so nothing is half-laid.
 * With `overwrite`, the foreign value is displaced and printed, because a local
 * `core.hooksPath` is not committed and has no reflog to recover it from.
 *
 * Reports the outcome as one line (or a loud block), the way the file and label
 * loops do. Outside a git repository there is nothing to configure: say so
 * loudly (the hooks are inert until someone sets it) and leave the exit code
 * alone, since scaffolding into a directory before `git init` is legitimate. A
 * `git config` that fails where a repository *does* exist is fatal: silently
 * leaving enforcement off is the exact failure mode this step exists to remove.
 * @param {object} params
 * @param {string} [params.cwd]
 * @param {(line: string) => void} params.log
 * @param {boolean} [params.overwrite] - Adopt a foreign local value (the
 *   `--overwrite-hooks-path` / prompt opt-in). Ignored when the value is unset
 *   or already managed.
 * @returns {string} `skipped`, `ok`, `created`, `overwritten`, or `blocked`.
 */
export function ensureHooksPath({
  cwd = process.cwd(),
  log,
  overwrite = false,
}) {
  if (!existsSync(resolve(cwd, ".git"))) {
    log(
      `skip     core.hooksPath (no git repository here). The vendored hooks will\n` +
        `         not run until you set it: git config core.hooksPath ${HOOKS_PATH}`,
    );
    return "skipped";
  }

  const local = readLocalHooksPath(cwd);
  if (local === HOOKS_PATH) {
    log(`ok       core.hooksPath=${HOOKS_PATH}`);
    return "ok";
  }

  // A foreign value is not `init`'s to repoint. Without the explicit opt-in,
  // report the block (the pre-flight has already withheld the hook files) and
  // return, leaving the operator's value exactly as it was.
  if (local !== "" && !overwrite) {
    const hazard = isAbsolute(local)
      ? " It is absolute, which would pin every linked worktree to one fixed\n         checkout's hooks even once resolved."
      : "";
    log(
      `block    core.hooksPath=${local} was not set by repo-contract, so the vendored\n` +
        `         git hooks would sit on disk inert (git runs hooks only from the path this\n` +
        `         points at). No git-hooks files were written.${hazard}\n` +
        `         Resolve it either way, with git-hooks selected: unset it\n` +
        `         (git config --local --unset core.hooksPath) and re-run init, or re-run with\n` +
        `         --overwrite-hooks-path to have repo-contract adopt ${HOOKS_PATH}\n` +
        `         (the displaced value is not committed and cannot be recovered).\n` +
        `         Either way the hooks you have now can keep running: move their bodies into\n` +
        `         ${LOCAL_CHAIN}/{pre-commit,commit-msg} and the repo-contract hooks\n` +
        `         chain to them on every commit.`,
    );
    return "blocked";
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

  if (local === "") {
    log(`create   core.hooksPath=${HOOKS_PATH}`);
    return "created";
  }
  // Reached only under the explicit opt-in: print the displaced value, since a
  // local `core.hooksPath` is uncommitted and unrecoverable once overwritten.
  log(
    `overwrite core.hooksPath=${HOOKS_PATH} (displaced '${local}', which repo-contract did ` +
      `not set and which is committed nowhere: note it now if you still need it)`,
  );
  return "overwritten";
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
