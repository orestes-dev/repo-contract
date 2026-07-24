// The TTY prompt that asks which scaffolds to add (ADR 0016).
//
// Isolated from `selection.js` so the precedence rules stay testable with a plain
// function stub and no terminal. This module is the only place `@clack/prompts` is
// imported: the dependency budget for prompting is the CLI surface alone, never
// the vendored git hooks, which keep their POSIX sh + jq budget so they run before
// any install (ADR 0015).
//
// `@clack/prompts` is pinned exactly. `npx`-from-git resolves the CLI's
// dependencies with no lockfile, so an exact pin is the only thing standing
// between a consumer and whatever the range would float to on the day they run it.

import { scaffold } from "./scaffolds.js";
import { HOOKS_PATH } from "./hook-activation.js";

/**
 * Whether this run may ask. Both ends must be a terminal: clack reads keystrokes
 * from stdin and repaints stdout, and on a non-TTY stdin its prompt never
 * resolves at all — the process would exit having neither asked nor installed.
 * Checking here is what keeps that from ever being reachable.
 * @param {object} [streams]
 * @param {NodeJS.ReadStream} [streams.input]
 * @param {NodeJS.WriteStream} [streams.output]
 * @returns {boolean}
 */
export function canPrompt({
  input = process.stdin,
  output = process.stdout,
} = {}) {
  return input.isTTY === true && output.isTTY === true;
}

/**
 * Ask which of the not-yet-installed scaffolds to add.
 *
 * Only absent scaffolds are offered, and the installed ones are listed above as
 * fixed context. A multiselect pre-checked to the current record would render
 * unchecking as an available move and then refuse it; offering only what is
 * missing makes deselection unrepresentable rather than merely rejected.
 *
 * Resolves to the chosen ids, or to `null` when the operator cancels.
 * @param {string[]} offer - The not-yet-installed ids, in `SCAFFOLD_IDS` order.
 * @param {string[]} installed - The recorded selection, shown as context.
 * @returns {Promise<string[]|null>}
 */
export async function promptForScaffolds(offer, installed) {
  const clack = await import("@clack/prompts");

  clack.intro("repo-contract init");

  if (installed.length > 0) {
    clack.note(
      installed.map((id) => `${id} — ${scaffold(id).summary}`).join("\n"),
      "Already installed (init never removes these)",
    );
  }

  const picked = await clack.multiselect({
    message: "Which scaffolds should this repo install?",
    options: offer.map((id) => ({
      value: id,
      label: id,
      hint: scaffold(id).summary,
    })),
    // Nothing selected is not a selection: a run that would install nothing is an
    // error on both paths, so the prompt re-asks rather than accepting it.
    required: installed.length === 0,
    // A first-time install defaults to everything, which is what the package did
    // before selection existed; adding to an existing install starts empty, so a
    // distracted Enter adds nothing rather than everything.
    initialValues: installed.length === 0 ? [...offer] : [],
  });

  if (clack.isCancel(picked)) {
    clack.cancel("Cancelled.");
    return null;
  }

  clack.outro(
    picked.length === 0
      ? "Nothing to add; keeping the recorded selection."
      : `Installing: ${picked.join(", ")}`,
  );
  return picked;
}

/**
 * Ask whether to adopt a foreign local `core.hooksPath` (ADR 0020), the
 * interactive twin of the `--overwrite-hooks-path` flag. The caller only reaches
 * here on a TTY (`canPrompt`), with `git-hooks` selected and a foreign value
 * present and the flag absent; a non-interactive run skips straight to the block
 * instead of ever hanging on this question.
 *
 * Names the value at stake and that it is unrecoverable, and defaults to `false`:
 * a distracted Enter keeps the operator's value rather than displacing it.
 * Resolves to `false` on cancel, which lands on the same block as declining.
 * @param {string} value - The foreign value that would be displaced.
 * @returns {Promise<boolean>} Whether to overwrite.
 */
export async function promptForOverwriteHooksPath(value) {
  const clack = await import("@clack/prompts");
  const answer = await clack.confirm({
    message:
      `This repo's local core.hooksPath is '${value}', which repo-contract did not set. ` +
      `Overwrite it with ${HOOKS_PATH} to activate the git hooks? The displaced value ` +
      "is committed nowhere and cannot be recovered.",
    initialValue: false,
  });
  return clack.isCancel(answer) ? false : answer === true;
}
