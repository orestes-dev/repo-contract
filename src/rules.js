// The RULES the gate enforces: the tuning surface. STRUCTURE lives in the Issue
// Form; this module owns only the constraints the form can't express, keyed by
// field `id`, plus the title format the gate requires. Edit here to change the
// bar.

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
