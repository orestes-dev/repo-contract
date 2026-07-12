// The gate's internal constants: labels, statuses, and the markers/headings the
// action keys off. The enforced RULES and title format are a separate tuning
// surface; STRUCTURE lives in the Issue Form.

// GitHub renders an empty optional field as this literal. Treat it as absent.
export const NO_RESPONSE = "_No response_";

// Per-check outcome, worst-wins across a field's rules.
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
export const OVERRIDE_HEADING = "Override rationale";

// Marker embedded in the bot comment so it can be found and updated in place.
export const COMMENT_MARKER = "<!-- issue-quality-gate -->";
