// The issue STRUCTURE and the RULES the gate enforces, both owned here in code.
// `FIELDS` is the ordered field descriptor (id, heading, type, required,
// options): the runtime source of truth the validator reads directly. `RULES`
// is the constraint layer the descriptor can't express (min/max length,
// checklist count, blocking sizes), keyed by field `id`. `.github/ISSUE_TEMPLATE/
// task.yml` is a GitHub-UI rendering of this structure, drift-tested against it
// (src/validator.test.js), never read at runtime. Edit here to change the bar.

/**
 * One input field of the issue, rendered in the body as a `### <heading>`
 * section. The ordered list is the structural source of truth; `RULES` joins to
 * it on `id`.
 * @typedef {object} Field
 * @property {string} id - Stable key, unchanged across heading renames.
 * @property {string} heading - The rendered `### <heading>`.
 * @property {'input'|'textarea'|'dropdown'} type
 * @property {boolean} required
 * @property {string[]} [options] - Dropdown choices; undefined otherwise.
 */

// The ordered field descriptor: issue structure as code. Field order is list
// order, mirrored by the Issue Form and drift-tested against it.
/** @type {Field[]} */
export const FIELDS = [
  { id: "context", heading: "Context", type: "textarea", required: true },
  {
    id: "acceptance-criteria",
    heading: "Acceptance Criteria",
    type: "textarea",
    required: true,
  },
  {
    id: "out-of-scope",
    heading: "Out of Scope",
    type: "textarea",
    required: true,
  },
  { id: "decisions", heading: "Decisions", type: "textarea", required: false },
  {
    id: "affected-files",
    heading: "Affected files / entry points",
    type: "textarea",
    required: false,
  },
  {
    id: "depends-on",
    heading: "Depends on",
    type: "textarea",
    required: false,
  },
  {
    id: "size",
    heading: "Size",
    type: "dropdown",
    required: true,
    options: ["XS", "S", "M", "L", "XL"],
  },
];

/**
 * A constraint the field descriptor can't express, keyed by field `id`.
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
