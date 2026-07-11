// `sweep`: backfill labels + scorecards across a repo's open issues.

import { execFileSync } from 'node:child_process';

import { GitHub } from '../github.js';
import { sweep as runSweep } from '../sweep.js';

// `sweep` runs locally on demand, not in CI, so it borrows the operator's own
// GitHub CLI session for both credentials and repo context instead of demanding
// a GITHUB_TOKEN and a --repo flag. `gh` is already how this workflow talks to
// GitHub everywhere else.
function gh(args, hint) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8' }).trim();
  } catch {
    console.error(`error: \`gh ${args.join(' ')}\` failed. ${hint}`);
    process.exit(2);
  }
}

export async function sweep() {
  const token = gh(
    ['auth', 'token'],
    'Install the GitHub CLI and run `gh auth login`.',
  );
  const { owner, name } = JSON.parse(
    gh(
      ['repo', 'view', '--json', 'owner,name'],
      'Run this from inside a GitHub repository clone.',
    ),
  );
  const client = new GitHub({
    token,
    apiUrl: process.env.GITHUB_API_URL,
    owner: owner.login,
    repo: name,
  });

  const { swept, failed, totalCount, capped } = await runSweep({
    gh: client,
    log: (line) => console.log(line),
  });

  const tally = `swept ${swept}, failed ${failed.length}`;
  console.log(`\n${tally}`);
  if (capped) {
    console.log(
      `note: ${totalCount} issues matched but the Search API caps results at ` +
        '1000. Swept issues drop out of the query, so re-run `sweep` to continue.',
    );
  }
  process.exit(failed.length > 0 ? 1 : 0);
}
