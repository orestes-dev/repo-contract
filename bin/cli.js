#!/usr/bin/env node
// CLI entry for `npx github:orestes-dev/issue-quality-gate <command>`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validate, failures } from "../src/validator.js";
import { renderCli } from "../src/report.js";
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
    console.error(
      "usage: issue-quality-gate validate <file> [--title <title>]",
    );
    process.exit(2);
  }
  const body = readFileSync(resolve(process.cwd(), file), "utf8");
  const result = validate(body, title);
  console.log(renderCli(result));
  process.exit(failures(result.checks).length > 0 ? 1 : 0);
}

/**
 * Dispatch the sub-command named in argv.
 * @returns {void|Promise<void>}
 */
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "init":
      return init();
    case "validate":
      return cmdValidate(rest);
    case "sweep":
      return sweep();
    default:
      console.error(
        "usage: issue-quality-gate <init|validate|sweep>\n" +
          "  init             scaffold the Issue Form + workflow into this repo\n" +
          "  validate <file> [--title <title>]  validate an issue body file (exit 1 on hard errors)\n" +
          "  sweep            backfill labels + scorecards on a repo's open issues",
      );
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
