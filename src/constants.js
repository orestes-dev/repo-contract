// The gate's internal constants: labels, statuses, and the markers/headings the
// action keys off. The enforced RULES and title format are a separate tuning
// surface; STRUCTURE is code-owned in rules.js, not the Issue Form (ADR 0003).

// GitHub renders an empty optional field as this literal. Treat it as absent.
export const NO_RESPONSE = "_No response_";

// The committed, repo-root config file the package reads for enforcement
// opt-outs. JSON so it parses with `JSON.parse` (no added dependency) and stays
// `jq`-queryable. Absent means full enforcement with no opt-outs.
export const CONFIG_FILENAME = ".quality-gate.json";

/**
 * Per-check outcome, worst-wins across a field's rules.
 * @typedef {'pass'|'warn'|'fail'} Status
 */

/** @type {{ PASS: 'pass', WARN: 'warn', FAIL: 'fail' }} */
export const STATUS = { PASS: "pass", WARN: "warn", FAIL: "fail" };

// Labels applied by the gate. Mutually exclusive.
export const LABEL = {
  FAILING: "issue-quality:failing",
  WARNING: "issue-quality:warning",
  PASS: "issue-quality:pass",
};

// Colors/descriptions so the gate creates labels intentionally, not gray/blank.
export const LABEL_META = {
  [LABEL.FAILING]: {
    color: "d93f0b",
    description:
      "Issue has failing quality checks; below the minimum structure and substance bar",
  },
  [LABEL.WARNING]: {
    color: "fbca04",
    description: "Issue passes but has non-blocking quality warnings",
  },
  [LABEL.PASS]: {
    color: "0e8a16",
    description: "Issue meets all quality checks",
  },
};

// Manual escape hatch: this label plus a non-empty `## Override rationale`
// section bypasses the gate.
export const OVERRIDE_LABEL = "override:issue-quality";
// Shared by both gates: the `## <heading>` a bypass rationale lives under.
export const OVERRIDE_HEADING = "Override rationale";

// Marker embedded in the bot comment so it can be found and updated in place.
export const COMMENT_MARKER = "<!-- issue-quality-gate -->";

// PR labels applied by the PR gate. Mutually exclusive, mirroring LABEL.
export const PR_LABEL = {
  FAILING: "pr-readiness:failing",
  WARNING: "pr-readiness:warning",
  PASS: "pr-readiness:pass",
};

// Colors/descriptions so the PR gate creates its labels intentionally.
export const PR_LABEL_META = {
  [PR_LABEL.FAILING]: {
    color: "d93f0b",
    description: "PR has failing readiness checks; merge is blocked",
  },
  [PR_LABEL.WARNING]: {
    color: "fbca04",
    description: "PR passes but has non-blocking readiness warnings",
  },
  [PR_LABEL.PASS]: {
    color: "0e8a16",
    description: "PR meets all readiness checks",
  },
};

// PR manual escape hatch: this label plus a `## Override rationale` section
// bypasses the PR gate for a human author (bots auto-pass without one).
export const PR_OVERRIDE_LABEL = "override:pr-readiness";

// Distinct from COMMENT_MARKER so a PR (which is also an issue) can carry both
// scorecards without either gate adopting the other's comment.
export const PR_COMMENT_MARKER = "<!-- pr-readiness-gate -->";

// Commit-hygiene labels applied by the commit gate. Mutually exclusive,
// mirroring LABEL/PR_LABEL. The commit axis is its OWN namespace, distinct from
// issue-quality and pr-readiness, so one override never waives unrelated checks
// (ADR 0002, orestes/dotfiles#52).
export const COMMIT_LABEL = {
  FAILING: "commit-hygiene:failing",
  WARNING: "commit-hygiene:warning",
  PASS: "commit-hygiene:pass",
};

// Colors/descriptions so the commit gate creates its labels intentionally.
export const COMMIT_LABEL_META = {
  [COMMIT_LABEL.FAILING]: {
    color: "d93f0b",
    description: "PR has failing commit-hygiene checks; merge is blocked",
  },
  [COMMIT_LABEL.WARNING]: {
    color: "fbca04",
    description: "PR passes but has non-blocking commit-hygiene warnings",
  },
  [COMMIT_LABEL.PASS]: {
    color: "0e8a16",
    description: "PR meets all commit-hygiene checks",
  },
};

// Commit-gate manual escape hatch: this label plus a `## Override rationale`
// section bypasses the commit gate for a human author (bots auto-pass without
// one). Its own override label, so bypassing commit hygiene never waives PR
// readiness or issue quality.
export const COMMIT_OVERRIDE_LABEL = "override:commit-hygiene";

// Distinct from COMMENT_MARKER and PR_COMMENT_MARKER so a PR can carry all three
// scorecards without any gate adopting another's comment.
export const COMMIT_COMMENT_MARKER = "<!-- commit-hygiene-gate -->";

// Enforcement opt-out keys read from `.quality-gate.json` (src/config.js). They
// mirror the `git config hooks.*` opt-outs of the local baseline hooks
// (~/.dotfiles/git-hooks/), so the CI mirror relaxes on the same axes and the
// bypass stays legible: a committed, reviewable data field with a required
// reason (ADR 0002).
export const OPT_OUT = {
  // Allow the PR head branch to be the default branch.
  DEFAULT_BRANCH: "allowDefaultBranchCommits",
  // Skip the Conventional Commits subject check across the PR's commits.
  CONVENTIONAL: "skipConventionalCommits",
  // Skip the em-dash-in-diff check entirely.
  EM_DASH: "allowEmDashes",
  // Allow up to <value> em dashes added across *.md/*.mdx in the diff.
  EM_DASH_BUDGET: "maxAllowedEmDashes",
};

// Scorecard line for an exempt object (a bot-authored PR): a single pass check,
// so the gate still leaves a comment explaining why it did not enforce.
export const EXEMPT_CHECK = {
  key: "exempt",
  label: "Author",
  message: "bot-authored; gate exempt",
};
