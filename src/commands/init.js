// `init`: scaffold the Issue Form + thin workflow into the current repo.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

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

export function init() {
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
    '\nDone. Commit both files to opt this repo into the issue quality gate.\n' +
      'The gate only labels issues going forward. To backfill labels + scorecards ' +
      'onto the existing open backlog, run: issue-quality-gate sweep',
  );
}
