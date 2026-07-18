// Structural validator for a pull request's commit hygiene: the CI mirror of the
// local repo-contract baseline (~/.dotfiles/git-hooks/), which is bypassable with
// `--no-verify` and absent where a repo displaces `core.hooksPath`. It evaluates
// the three baseline commit-contract rules on the PR:
//
//   1. Conventional Commits subjects across the PR's commits (commit-msg hook)
//   2. no em dashes added in *.md/*.mdx in the diff (pre-commit hook)
//   3. the PR head branch is not the default branch (pre-commit hook)
//
// Each rule mirrors its hook's per-repo opt-out, but read from the committed
// `.repo-contract.json` (src/config.js) instead of per-machine `git config
// hooks.*`, so the bypass is durable, reviewable, and reason-bearing (ADR 0002).
// An opt-out relaxes to a pass whose message quotes the recorded reason, so the
// scorecard shows both that the check was skipped and why.

import { check, isConventionalSubject } from "./validator.js";
import { getOverride, formatOverride } from "./config.js";
import { STATUS, OPT_OUT } from "./constants.js";

/** @typedef {import('./validator.js').Check} Check */
/** @typedef {import('./validator.js').Scorecard} Scorecard */
/** @typedef {import('./config.js').Config} Config */

// The em dash the baseline bans. Spelled as a unicode escape so this source file
// never itself carries the character it forbids.
const EM_DASH = "\u2014";

// Subject prefixes the commit-msg hook skips: generated or fixup subjects that
// are never expected to be Conventional Commits.
const EXEMPT_SUBJECT_PREFIXES = ["Merge ", "Revert ", "fixup! ", "squash! "];

// Markdown extensions the em-dash rule governs, mirroring the pre-commit hook's
// `-- '*.md' '*.mdx'` pathspec.
const MARKDOWN_EXTENSIONS = [".md", ".mdx"];

// Scorecard keys/labels, one per baseline rule.
const SUBJECTS_KEY = "commit-subjects";
const SUBJECTS_LABEL = "Commit subjects";
const EM_DASH_KEY = "em-dashes";
const EM_DASH_LABEL = "Em dashes";
const BRANCH_KEY = "default-branch";
const BRANCH_LABEL = "Default branch";

/**
 * A commit's subject is exempt from the Conventional Commits check when it is a
 * merge, revert, fixup, or squash subject (matching the commit-msg hook).
 * @param {string} subject
 * @returns {boolean}
 */
const isExemptSubject = (subject) =>
  EXEMPT_SUBJECT_PREFIXES.some((p) => subject.startsWith(p));

/**
 * Whether a filename is a Markdown file the em-dash rule governs.
 * @param {string} filename
 * @returns {boolean}
 */
const isMarkdown = (filename) =>
  MARKDOWN_EXTENSIONS.some((ext) => filename.endsWith(ext));

/**
 * Count the em dashes on added lines of a unified-diff patch. An added line
 * starts with a single `+`; the `+++` file header is excluded. Plain string
 * scan, no regex.
 * @param {string} patch
 * @returns {number}
 */
function countAddedEmDashes(patch) {
  let count = 0;
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    let from = 0;
    for (;;) {
      const at = line.indexOf(EM_DASH, from);
      if (at === -1) break;
      count += 1;
      from = at + EM_DASH.length;
    }
  }
  return count;
}

/**
 * Conventional Commits subject check across the PR's commits: every non-exempt
 * subject must open with `type(scope): summary`. Skipped (pass) when the repo
 * opted out via `skipConventionalCommits` in `.repo-contract.json`.
 * @param {{sha: string, subject: string}[]} commits
 * @param {Config} config
 * @returns {Check}
 */
function checkSubjects(commits, config) {
  const override = getOverride(config, OPT_OUT.CONVENTIONAL);
  if (override) {
    return check(
      SUBJECTS_KEY,
      SUBJECTS_LABEL,
      STATUS.PASS,
      `skipped: ${formatOverride(OPT_OUT.CONVENTIONAL, override)}`,
    );
  }
  const enforced = commits.filter((c) => !isExemptSubject(c.subject));
  const offending = enforced.filter((c) => !isConventionalSubject(c.subject));
  const core =
    "every commit subject follows Conventional Commits: `type(scope): summary`";
  if (offending.length > 0) {
    const list = offending
      .map((c) => `${c.sha.slice(0, 7)} "${c.subject}"`)
      .join("; ");
    return check(
      SUBJECTS_KEY,
      SUBJECTS_LABEL,
      STATUS.FAIL,
      `${core}. Not conventional: ${list}`,
    );
  }
  return check(SUBJECTS_KEY, SUBJECTS_LABEL, STATUS.PASS, core);
}

/**
 * Em-dash check over the diff: no em dashes added on *.md/*.mdx lines. The
 * `allowEmDashes` opt-out skips it entirely; `maxAllowedEmDashes` sets a budget
 * (default 0), mirroring the pre-commit hook. Both read from `.repo-contract.json`.
 * @param {{filename: string, patch: string}[]} files
 * @param {Config} config
 * @returns {Check}
 */
function checkEmDashes(files, config) {
  const allow = getOverride(config, OPT_OUT.EM_DASH);
  if (allow) {
    return check(
      EM_DASH_KEY,
      EM_DASH_LABEL,
      STATUS.PASS,
      `skipped: ${formatOverride(OPT_OUT.EM_DASH, allow)}`,
    );
  }
  const budget = getOverride(config, OPT_OUT.EM_DASH_BUDGET);
  const max = typeof budget?.value === "number" ? budget.value : 0;
  const count = files
    .filter((f) => isMarkdown(f.filename))
    .reduce((sum, f) => sum + countAddedEmDashes(f.patch), 0);
  const budgetNote = budget
    ? ` ${formatOverride(OPT_OUT.EM_DASH_BUDGET, budget)}`
    : "";
  if (count > max) {
    return check(
      EM_DASH_KEY,
      EM_DASH_LABEL,
      STATUS.FAIL,
      `no em dashes added in *.md/*.mdx (max allowed: ${max}); use ',' '.' '()' ':' instead.${budgetNote}`,
    );
  }
  const core =
    max > 0
      ? `at most ${max} em dash(es) added in *.md/*.mdx`
      : "no em dashes added in *.md/*.mdx";
  return check(
    EM_DASH_KEY,
    EM_DASH_LABEL,
    STATUS.PASS,
    `${core}.${budgetNote}`,
  );
}

/**
 * Default-branch check: the PR's head branch must not be the base repo's default
 * branch (the CI mirror of the pre-commit "never commit to the default branch"
 * rule). Skipped (pass) when the repo opted out via `allowDefaultBranchCommits`.
 * A missing head or default branch name passes rather than false-failing.
 * @param {string} headRef - The PR head branch name.
 * @param {string} defaultBranch - The base repo's default branch name.
 * @param {Config} config
 * @returns {Check}
 */
function checkDefaultBranch(headRef, defaultBranch, config) {
  const override = getOverride(config, OPT_OUT.DEFAULT_BRANCH);
  if (override) {
    return check(
      BRANCH_KEY,
      BRANCH_LABEL,
      STATUS.PASS,
      `skipped: ${formatOverride(OPT_OUT.DEFAULT_BRANCH, override)}`,
    );
  }
  const core = "the PR is not opened from the default branch";
  if (headRef !== "" && defaultBranch !== "" && headRef === defaultBranch) {
    return check(
      BRANCH_KEY,
      BRANCH_LABEL,
      STATUS.FAIL,
      `${core}; the head branch is the default branch '${defaultBranch}'. Branch first.`,
    );
  }
  return check(BRANCH_KEY, BRANCH_LABEL, STATUS.PASS, core);
}

/**
 * Validate a PR's commit hygiene into a scorecard: the Conventional Commits
 * subject check leads, then the em-dash-in-diff check, then the default-branch
 * check. Each baseline rule mirrors its local hook and reads its opt-out from the
 * committed `.repo-contract.json` config.
 * @param {object} params
 * @param {{sha: string, subject: string}[]} [params.commits] - The PR's commits.
 * @param {{filename: string, patch: string}[]} [params.files] - The PR's changed files.
 * @param {string} [params.headRef] - The PR head branch name.
 * @param {string} [params.defaultBranch] - The base repo's default branch name.
 * @param {Config} [params.config] - The parsed `.repo-contract.json` opt-outs.
 * @returns {Scorecard}
 */
export function validateCommits({
  commits = [],
  files = [],
  headRef = "",
  defaultBranch = "",
  config = { overrides: {} },
}) {
  return {
    checks: [
      checkSubjects(commits, config),
      checkEmDashes(files, config),
      checkDefaultBranch(headRef, defaultBranch, config),
    ],
  };
}
