#!/usr/bin/env node
// CLI entry for `npx github:orestes-dev/quality-gate <command>`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validate, failures } from "../src/validator.js";
import { validatePr } from "../src/pr-validator.js";
import { renderCli, PR_PRESENTATION } from "../src/report.js";
import { init } from "../src/commands/init.js";
import { sweep } from "../src/commands/sweep.js";

/** Usage banner shared by the help path (stdout, exit 0) and the unknown-command path (stderr, exit 2). */
const USAGE =
  "usage: quality-gate <init|validate-issue|validate-pr|sweep>\n" +
  "  init [--force]   scaffold the Issue Form + PR Form, their workflows, and the\n" +
  "                   repo-contract git hooks into this repo\n" +
  "                   (fails on drifted files; --force upgrades in place)\n" +
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
      "usage: quality-gate validate-issue <file> [--title <title>]",
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
    console.error("usage: quality-gate validate-pr <file> [--title <title>]");
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
  process.exit(1);
});
