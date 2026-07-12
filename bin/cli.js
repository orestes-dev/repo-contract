#!/usr/bin/env node
// CLI entry for `npx github:orestes-dev/quality-gate <command>`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validate, failures } from "../src/validator.js";
import { validatePr } from "../src/pr-validator.js";
import { renderCli, PR_PRESENTATION } from "../src/report.js";
import { loadForm } from "../src/form.js";
import { init } from "../src/commands/init.js";
import { sweep } from "../src/commands/sweep.js";

/**
 * Validate an issue body file and print the scorecard. Exits 1 on hard errors,
 * 2 on usage error. An optional `--title <title>` also checks the title against
 * the Conventional Commits format the gate enforces in CI.
 * @param {string[]} args - Positional file path plus optional `--title <title>`.
 * @returns {void}
 */
function cmdValidate(args) {
  const titleFlag = args.indexOf("--title");
  const title = titleFlag === -1 ? undefined : args[titleFlag + 1];
  const file = args.find(
    (a, i) => !a.startsWith("--") && (titleFlag === -1 || i !== titleFlag + 1),
  );
  if (!file) {
    console.error("usage: quality-gate validate <file> [--title <title>]");
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
 * linked-issue readiness stays CI-authoritative.
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
 * Print a blank issue body skeleton: one `### <heading>` section per Issue Form
 * field, in form order, for an agent to fill before pre-flight validation. The
 * headings are derived from the form at runtime, so the skeleton tracks the form
 * without a committed duplicate. Stdout only, like `validate`.
 * @returns {void}
 */
function cmdScaffold() {
  const skeleton = loadForm()
    .map((field) => `### ${field.label}`)
    .join("\n\n");
  console.log(skeleton);
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
    case "validate":
      return cmdValidate(rest);
    case "validate-pr":
      return cmdValidatePr(rest);
    case "scaffold":
      return cmdScaffold();
    case "sweep":
      return sweep();
    default:
      console.error(
        "usage: quality-gate <init|validate|validate-pr|scaffold|sweep>\n" +
          "  init [--force]   scaffold the Issue Form + workflow into this repo\n" +
          "                   (fails on drifted files; --force upgrades in place)\n" +
          "  validate <file> [--title <title>]     validate an issue body file (exit 1 on hard errors)\n" +
          "  validate-pr <file> [--title <title>]  validate a PR body file (exit 1 on hard errors)\n" +
          "  scaffold         print a blank issue body skeleton for an agent to fill\n" +
          "  sweep            backfill labels + scorecards on a repo's open issues",
      );
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
