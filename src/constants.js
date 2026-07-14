// The gate's internal constants: labels, statuses, and the markers/headings the
// action keys off. The enforced RULES and title format are a separate tuning
// surface; STRUCTURE lives in the Issue Form.

// GitHub renders an empty optional field as this literal. Treat it as absent.
export const NO_RESPONSE = "_No response_";

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
    description: "Issue has failing quality checks; not ready for pickup",
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

// Scorecard line for an exempt object (a bot-authored PR): a single pass check,
// so the gate still leaves a comment explaining why it did not enforce.
export const EXEMPT_CHECK = {
  key: "exempt",
  label: "Author",
  message: "bot-authored; gate exempt",
};
