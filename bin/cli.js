#!/usr/bin/env node
// CLI entry for `npx github:orestes-dev/issue-quality-gate <command>`.
//
//   init             Drop the Issue Form + thin workflow into the current repo.
//   validate <file>  Run the validator against an issue body file (pre-flight).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validate } from '../src/validator.js';
import { renderCli } from '../src/report.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const TEMPLATES = [
  {
    from: join(ROOT, 'templates', 'issue-form.yml'),
    to: join('.github', 'ISSUE_TEMPLATE', 'task.yml'),
  },
  {
    from: join(ROOT, 'templates', 'workflow.yml'),
    to: join('.github', 'workflows', 'issue-quality.yml'),
  },
];

function cmdInit() {
  // Soft guard against the one silent foot-gun: run from a subdirectory and the
  // files land where GitHub never looks. `.github/` is only read at the repo
  // root, whose worktree carries a `.git` entry (a directory in a normal clone,
  // a file in a linked worktree). Warn but proceed: scaffolding into a fresh
  // dir before `git init` is legitimate.
  if (!existsSync(resolve(process.cwd(), '.git'))) {
    console.warn(
      'warning: no .git in the current directory. GitHub only reads .github/ ' +
        'from the repository root; run this there or the workflow will not run.',
    );
  }

  for (const { from, to } of TEMPLATES) {
    const dest = resolve(process.cwd(), to);
    if (existsSync(dest)) {
      console.log(`skip   ${to} (already exists)`);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(from, 'utf8'));
    console.log(`create ${to}`);
  }
  console.log(
    '\nDone. Commit both files to opt this repo into the issue quality gate.',
  );
}

function cmdValidate(file) {
  if (!file) {
    console.error('usage: issue-quality-gate validate <file>');
    process.exit(2);
  }
  const body = readFileSync(resolve(process.cwd(), file), 'utf8');
  const result = validate(body);
  console.log(renderCli(result));
  process.exit(result.errors.length > 0 ? 1 : 0);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'init':
      return cmdInit();
    case 'validate':
      return cmdValidate(rest[0]);
    default:
      console.error(
        'usage: issue-quality-gate <init|validate>\n' +
          '  init             scaffold the Issue Form + workflow into this repo\n' +
          '  validate <file>  validate an issue body file (exit 1 on hard errors)',
      );
      process.exit(2);
  }
}

main();
