// The RULES the gate enforces plus the fixed labels/statuses. STRUCTURE lives in
// the Issue Form and is derived by `form.js`; this module owns only what the
// form can't express, keyed by field `id`.

/**
 * A constraint the Issue Form can't express, keyed by field `id`.
 * @typedef {object} Rule
 * @property {number} [minLength] - Prose length floor (hard).
 * @property {number} [maxLength] - Prose length ceiling (warning).
 * @property {boolean} [checklist] - Field must be a markdown checklist.
 * @property {number} [minItems] - Minimum non-empty checklist items.
 * @property {string[]} [blocking] - Dropdown options too big to land as one issue.
 * @property {boolean} [warnIfEmpty] - Optional field whose absence is a warning,
 *   not a silent pass: recommended context an implementer shouldn't have to guess.
 */

// Every number is restated in the README and guarded by a drift test.
/** @type {Record<string, Rule>} */
export const RULES = {
  context: { minLength: 30, maxLength: 1500 },
  "acceptance-criteria": { checklist: true, minItems: 1 },
  "out-of-scope": { minLength: 10 },
  decisions: { warnIfEmpty: true },
  "affected-files": { warnIfEmpty: true },
  "depends-on": {},
  size: { blocking: ["L", "XL"] },
};

// Conventional Commits types the issue title must open with. The gate enforces
// `type(scope): summary` so a title maps cleanly onto the eventual branch/commit.
export const CONVENTIONAL_COMMIT_TYPES = [
  "feat",
  "fix",
  "perf",
  "refactor",
  "test",
  "build",
  "chore",
  "docs",
  "style",
  "ci",
  "revert",
];

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
