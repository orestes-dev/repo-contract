#!/usr/bin/env node
// CLI entry for `npx github:orestes-dev/issue-quality-gate <command>`.
//
//   init             Drop the Issue Form + thin workflow into the current repo.
//   validate <file>  Run the validator against an issue body file (pre-flight).
//   sweep            Backfill labels + scorecards across a repo's open issues.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { validate, failures } from '../src/validator.js';
import { renderCli } from '../src/report.js';
import { init } from '../src/commands/init.js';
import { sweep } from '../src/commands/sweep.js';

function cmdValidate(file) {
  if (!file) {
    console.error('usage: issue-quality-gate validate <file>');
    process.exit(2);
  }
  const body = readFileSync(resolve(process.cwd(), file), 'utf8');
  const result = validate(body);
  console.log(renderCli(result));
  process.exit(failures(result.checks).length > 0 ? 1 : 0);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'init':
      return init();
    case 'validate':
      return cmdValidate(rest[0]);
    case 'sweep':
      return sweep();
    default:
      console.error(
        'usage: issue-quality-gate <init|validate|sweep>\n' +
          '  init             scaffold the Issue Form + workflow into this repo\n' +
          '  validate <file>  validate an issue body file (exit 1 on hard errors)\n' +
          '  sweep            backfill labels + scorecards on a repo\'s open issues',
      );
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
