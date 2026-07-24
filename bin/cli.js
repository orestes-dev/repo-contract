#!/usr/bin/env node
// CLI entry for `npx github:orestes-dev/repo-contract <command>`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validate, failures } from "../src/validator.js";
import { validatePr } from "../src/pr-validator.js";
import { renderCli, PR_PRESENTATION } from "../src/report.js";
import { init } from "../src/commands/init.js";
import { uninstall } from "../src/commands/uninstall.js";
import { sweep } from "../src/commands/sweep.js";
import { SCAFFOLDS } from "../src/scaffolds.js";
import { SelectionError } from "../src/selection.js";

/**
 * The scaffold vocabulary, rendered from the manifest so `--help` cannot drift
 * from what `init` actually installs.
 */
const SCAFFOLD_HELP = SCAFFOLDS.map(
  ({ id, summary }) => `                     ${id.padEnd(15)}${summary}`,
).join("\n");

/** Usage banner shared by the help path (stdout, exit 0) and the unknown-command path (stderr, exit 2). */
const USAGE =
  "usage: repo-contract <init|uninstall|validate-issue|validate-pr|sweep>\n" +
  "  init [--force] [--only <ids>] [--overwrite-hooks-path]\n" +
  "                   install a selected subset of repo-contract's features into\n" +
  "                   this repo, and activate the git hooks if selected\n" +
  "                   (core.hooksPath=.repo-contract/hooks, relative so linked\n" +
  "                   worktrees run their own)\n" +
  "                   (fails on drifted files; --force upgrades in place)\n" +
  "                   A foreign local core.hooksPath (one repo-contract did not\n" +
  "                   set: a stale .husky, your own directory, an absolute path)\n" +
  "                   blocks the git-hooks scaffold only, writing none of its\n" +
  "                   files; --overwrite-hooks-path adopts it (distinct from\n" +
  "                   --force, since a local core.hooksPath is uncommitted and\n" +
  "                   unrecoverable) and prints the value it displaced.\n" +
  "                   Scaffolds (--only takes a comma-separated list):\n" +
  SCAFFOLD_HELP +
  "\n" +
  "                   Without --only, a terminal prompts for the ones not yet\n" +
  "                   installed; otherwise the selection recorded in\n" +
  "                   .repo-contract.json is honoured, or all of them when the\n" +
  "                   repo has no record. init only ever adds: dropping an\n" +
  "                   installed scaffold is `repo-contract uninstall <id>`.\n" +
  "  uninstall <ids>  remove one or more named scaffolds' footprint: their files,\n" +
  "                   their entry in the .repo-contract.json manifest, and (for\n" +
  "                   git-hooks) core.hooksPath when it still holds the managed\n" +
  "                   value. Remote labels are named as manual cleanup, never\n" +
  "                   deleted. Scaffold ids (space- or comma-separated):\n" +
  SCAFFOLD_HELP +
  "\n" +
  "  validate-issue <file> [--title <title>]  validate an issue body file (exit 1 on hard errors)\n" +
  "  validate-pr <file> [--title <title>]     validate a PR body file (exit 1 on hard errors)\n" +
  "  sweep            backfill labels + scorecards on a repo's open issues";

/**
 * Validate an issue body file and print the scorecard. Exits 1 on hard errors,
 * 2 on usage error. An optional `--title <title>` also checks the title against
 * the Conventional Commits format the gate enforces in CI.
 * @param {string[]} args - Positional file path plus optional `--title <title>`.
 * @returns {void}
 */
function cmdValidateIssue(args) {
  const titleFlag = args.indexOf("--title");
  const title = titleFlag === -1 ? undefined : args[titleFlag + 1];
  const file = args.find(
    (a, i) => !a.startsWith("--") && (titleFlag === -1 || i !== titleFlag + 1),
  );
  if (!file) {
    console.error(
      "usage: repo-contract validate-issue <file> [--title <title>]",
    );
    process.exit(2);
  }
  const body = readFileSync(resolve(process.cwd(), file), "utf8");
  const result = validate(body, title);
  console.log(renderCli(result));
  process.exit(failures(result.checks).length > 0 ? 1 : 0);
}

/**
 * Validate a PR body file and print the PR scorecard. Exits 1 on hard errors, 2
 * on usage error. An optional `--title <title>` checks the title against the
 * Conventional Commits format. `validatePr` is called without linked issues, so
 * only what is knowable locally (body structure + title) is checked; transitive
 * linked-issue clearance stays CI-authoritative.
 * @param {string[]} args - Positional file path plus optional `--title <title>`.
 * @returns {void}
 */
function cmdValidatePr(args) {
  const titleFlag = args.indexOf("--title");
  const title = titleFlag === -1 ? undefined : args[titleFlag + 1];
  const file = args.find(
    (a, i) => !a.startsWith("--") && (titleFlag === -1 || i !== titleFlag + 1),
  );
  if (!file) {
    console.error("usage: repo-contract validate-pr <file> [--title <title>]");
    process.exit(2);
  }
  const body = readFileSync(resolve(process.cwd(), file), "utf8");
  const result = validatePr(body, title);
  console.log(renderCli(result, { presentation: PR_PRESENTATION }));
  process.exit(failures(result.checks).length > 0 ? 1 : 0);
}

/**
 * Dispatch the sub-command named in argv.
 * @returns {Promise<void>}
 */
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "init":
      return init(rest);
    case "uninstall":
      return uninstall(rest);
    case "validate-issue":
      return cmdValidateIssue(rest);
    case "validate-pr":
      return cmdValidatePr(rest);
    case "sweep":
      return sweep();
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      process.exit(0);
    // eslint-disable-next-line no-fallthrough -- unreachable: the help cases above call process.exit
    default:
      console.error(USAGE);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  // A selection error carries the exit code its kind deserves: 2 for a malformed
  // request (an unknown scaffold id, like an unknown command), 1 for a
  // well-formed one refused on policy.
  process.exit(err instanceof SelectionError ? err.code : 1);
});
