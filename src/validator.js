// Deterministic, dependency-free validator. The issue body is parsed with plain
// string ops (no regex) into `### <heading>` sections. Headings inside fenced code
// blocks (``` or ~~~) are skipped, so a schema heading pasted into a repro can't
// mis-split the body.

import { FIELDS, RULES, CONVENTIONAL_COMMIT_TYPES } from "./rules.js";
import {
  NO_RESPONSE,
  LABEL,
  STATUS,
  OVERRIDE_HEADING,
  REJECTION_HEADING,
  WONTFIX_LABEL,
} from "./constants.js";

/**
 * @typedef {import('./rules.js').Field} Field
 * @typedef {import('./rules.js').Rule} Rule
 */

/**
 * One line of the scorecard: a single field's outcome.
 * @typedef {object} Check
 * @property {string} key - The field id.
 * @property {string} label - The field's rendered heading.
 * @property {'pass'|'warn'|'fail'} status
 * @property {string} message - Rendered verbatim into the scorecard line.
 */

/**
 * A full validation result: one check per field, in form order.
 * @typedef {object} Scorecard
 * @property {Check[]} checks
 */

// Checklist prefixes matching GitHub's task-list rendering.
const BULLETS = ["-", "*", "+"];
const BOXES = ["[ ]", "[x]", "[X]"];
const CHECKLIST_PREFIXES = BULLETS.flatMap((bullet) =>
  BOXES.map((box) => `${bullet} ${box}`),
);

// Only these headings delimit a section, so a `##`-looking line pasted inside a
// field can't mis-split the body.
const KNOWN_HEADINGS = new Set([
  ...FIELDS.map((f) => f.heading),
  OVERRIDE_HEADING,
  REJECTION_HEADING,
]);

// A Rejection's reason is held to the same substance floor as Context: below it,
// the section exists but records nothing recallable.
const REJECTION_MIN_LENGTH = /** @type {number} */ (RULES.context.minLength);

// The Rejection check's scorecard key. Not a field id (it has no `rules.js`
// entry), so it is named here rather than derived from the descriptor.
const REJECTION_KEY = "rejection";

// A title must open with a Conventional Commits type, an optional `(scope)`, an
// optional `!` breaking-change marker, then `: ` and a non-empty summary.
const CONVENTIONAL_TITLE = new RegExp(
  `^(${CONVENTIONAL_COMMIT_TYPES.join("|")})(\\([^)]+\\))?!?: .+`,
);

/**
 * The heading text of a markdown h2/h3 line (`## ` or `### `).
 * @param {string} line
 * @returns {string|null} The heading text, or null if the line isn't an h2/h3.
 */
function parseHeading(line) {
  let hashes = 0;
  while (hashes < line.length && line[hashes] === "#") hashes += 1;
  if (hashes < 2 || line[hashes] !== " ") return null;
  return line.slice(hashes + 1).trim();
}

/**
 * A fenced-code-block delimiter: a run of 3+ backticks or tildes, indented at
 * most 3 spaces, followed only by an info string. Returns the run's fence
 * character and length, or null when the line isn't a fence.
 * @param {string} line
 * @returns {{ char: string, len: number, info: string }|null}
 */
function parseFence(line) {
  let indent = 0;
  while (indent < line.length && line[indent] === " ") indent += 1;
  if (indent > 3) return null;
  const char = line[indent];
  if (char !== "`" && char !== "~") return null;
  let len = 0;
  while (line[indent + len] === char) len += 1;
  if (len < 3) return null;
  const info = line.slice(indent + len).trim();
  // A backtick info string can't contain a backtick (CommonMark), so such a line
  // isn't an opening fence.
  if (char === "`" && info.includes("`")) return null;
  return { char, len, info };
}

/**
 * Split a body into a { heading: text } map on the known headings, skipping any
 * heading inside a fenced code block. The issue callers rely on the default
 * heading set; the PR validator passes its own so the same parser serves both.
 * @param {string} body
 * @param {Set<string>} [knownHeadings] - Headings that delimit a section.
 * @returns {Record<string, string>}
 */
export function parseSections(body, knownHeadings = KNOWN_HEADINGS) {
  /** @type {Record<string, string>} */
  const sections = {};
  /** @type {string|null} */
  let current = null;
  /** @type {string[]} */
  let buffer = [];
  /** @type {{ char: string, len: number, info: string }|null} */
  let fence = null;

  const flush = () => {
    if (current !== null) sections[current] = buffer.join("\n").trim();
  };

  for (const rawLine of String(body ?? "").split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const marker = parseFence(line);

    // Inside a fence: content only. A bare fence of the same character, at least
    // as long as the opener, closes it.
    if (fence !== null) {
      if (
        marker !== null &&
        marker.char === fence.char &&
        marker.len >= fence.len &&
        marker.info === ""
      ) {
        fence = null;
      }
      if (current !== null) buffer.push(line);
      continue;
    }

    // A fence opener is content, never a heading.
    if (marker !== null) {
      fence = marker;
      if (current !== null) buffer.push(line);
      continue;
    }

    const heading = parseHeading(line);
    if (heading !== null && knownHeadings.has(heading)) {
      flush();
      current = heading;
      buffer = [];
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  flush();
  return sections;
}

/**
 * Whether the body carries a non-empty `## Override rationale` section.
 * @param {string} body
 * @returns {boolean}
 */
export function hasOverrideRationale(body) {
  const sections = parseSections(body);
  const rationale = sections[OVERRIDE_HEADING];
  return typeof rationale === "string" && rationale.trim().length > 0;
}

/**
 * Field value, treating the form's empty-response placeholder as absent.
 * @param {Record<string, string>} sections
 * @param {string} heading
 * @returns {string} The trimmed value, or '' when absent or placeholder.
 */
function fieldValue(sections, heading) {
  const raw = sections[heading];
  if (raw === undefined) return "";
  const trimmed = raw.trim();
  if (trimmed === NO_RESPONSE) return "";
  return trimmed;
}

/**
 * Count checklist items with actual text; a bare `- [ ]` prefill doesn't count.
 * @param {string} text
 * @returns {number}
 */
function countChecklistItems(text) {
  let count = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const prefix = CHECKLIST_PREFIXES.find((p) => line.startsWith(p));
    if (prefix === undefined) continue;
    if (line.slice(prefix.length).trim().length > 0) count += 1;
  }
  return count;
}

/**
 * Build one check result.
 * @param {string} key - The field id.
 * @param {string} label - The field's heading.
 * @param {'pass'|'warn'|'fail'} status
 * @param {string} message
 * @returns {Check}
 */
export const check = (key, label, status, message) => ({
  key,
  label,
  status,
  message,
});

/**
 * Oxford-comma "or" list: `["XS"]` → `XS`, `["XS","S"]` → `XS or S`,
 * `["XS","S","M"]` → `XS, S, or M`.
 * @param {string[]} items
 * @returns {string}
 */
function orList(items) {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

/**
 * Dropdown: membership in the field's options, plus RULES `blocking` values too
 * big to land as one issue. Both hard. The message names the rule (the sizes
 * that land as one issue, derived from options minus `blocking`), identical on
 * pass and fail; a blocking value appends a value-free imperative, never the
 * author's selected value.
 * @param {Field} field
 * @param {Rule|undefined} rule
 * @param {string} value
 * @returns {Check}
 */
function checkEnum(field, rule, value) {
  const { id, heading, options = [] } = field;
  const blocking = rule?.blocking ?? [];
  const core = `${orList(options.filter((o) => !blocking.includes(o)))} lands as one issue`;
  if (!options.includes(value) || blocking.includes(value)) {
    const suffix = blocking.includes(value)
      ? " — split it into smaller issues"
      : "";
    return check(id, heading, STATUS.FAIL, core + suffix);
  }
  return check(id, heading, STATUS.PASS, core);
}

/**
 * Checklist: at least `minItems` non-empty markdown checklist items.
 * @param {Field} field
 * @param {Rule} rule
 * @param {string} value
 * @returns {Check}
 */
function checkChecklist(field, rule, value) {
  const { id, heading } = field;
  const min = rule.minItems ?? 1;
  const core =
    min === 1
      ? "at least one checklist item"
      : `at least ${min} checklist items`;
  const items = countChecklistItems(value);
  const status = items < min ? STATUS.FAIL : STATUS.PASS;
  return check(id, heading, status, core);
}

/**
 * The rule a prose field states: its length bounds as a phrase, derived from the
 * rule so it stays the single source of truth. A field with no length rule is
 * presence-only, so it states `present`.
 * @param {Rule|undefined} rule
 * @returns {string}
 */
function proseCore(rule) {
  const min = rule?.minLength;
  const max = rule?.maxLength;
  if (min && max) return `${min}–${max} characters`;
  if (min) return `at least ${min} characters`;
  if (max) return `at most ${max} characters`;
  return "present";
}

/**
 * Prose: `minLength` is hard, `maxLength` warning-only. Worst status wins. The
 * message states the rule (the length bounds), identical across statuses; only
 * the icon carries the verdict, and a `long` warning appends a value-free
 * imperative. The author's measured length is never printed.
 * @param {Field} field
 * @param {Rule|undefined} rule
 * @param {string} value
 * @returns {Check}
 */
function checkProse(field, rule, value) {
  const { id, heading } = field;
  const core = proseCore(rule);
  const min = rule?.minLength;
  if (min && value.length < min) {
    return check(id, heading, STATUS.FAIL, core);
  }
  const max = rule?.maxLength;
  if (max && value.length > max) {
    return check(
      id,
      heading,
      STATUS.WARN,
      `${core} — consider trimming, but not at the cost of information`,
    );
  }
  return check(id, heading, STATUS.PASS, core);
}

/**
 * One field's check. Absent-but-optional passes rather than failing, so a
 * `required: false` field stops blocking on absence.
 * @param {Record<string, string>} sections
 * @param {Field} field
 * @param {Rule} [rule]
 * @returns {Check}
 */
function checkField(sections, field, rule) {
  const { id, heading, required, type } = field;
  const value = fieldValue(sections, heading);
  if (value === "" && !required) {
    if (rule?.warnIfEmpty) {
      return check(
        id,
        heading,
        STATUS.WARN,
        "recommended; add it so implementers aren't left guessing",
      );
    }
    return check(id, heading, STATUS.PASS, "optional; not provided");
  }
  // A required-but-empty field falls through to its type check, which fails
  // against the rule it can't meet: the scorecard states the rule to satisfy
  // (`30–1500 characters`), the icon conveying "unmet", never "missing".
  if (type === "dropdown") return checkEnum(field, rule, value);
  if (rule?.checklist) return checkChecklist(field, rule, value);
  return checkProse(field, rule, value);
}

/**
 * Whether a subject line opens with a Conventional Commits `type(scope): summary`.
 * The single Conventional Commits matcher, shared by the title check and the
 * commit-hygiene gate's per-commit subject check, so both key off one regex.
 * @param {string} subject - A commit subject or issue/PR title.
 * @returns {boolean}
 */
export const isConventionalSubject = (subject) => {
  const value = String(subject ?? "").trim();
  return value !== "" && CONVENTIONAL_TITLE.test(value);
};

/**
 * Title: a Conventional Commits `type(scope): summary`, so it maps onto the
 * eventual branch/commit. Metadata, not a form field, so it's checked here and
 * prepended to the scorecard rather than derived from the form structure. Hard.
 * @param {string} title - The issue title.
 * @returns {Check}
 */
export function checkTitle(title) {
  // The message states the rule, identical on pass and fail; the icon is the
  // sole verdict, never the author's title verbatim.
  const core = "Conventional Commits: `type(scope): summary`";
  const status = isConventionalSubject(title) ? STATUS.PASS : STATUS.FAIL;
  return check("title", "Title", status, core);
}

/**
 * A Rejection's `## Rejection rationale`: absent or empty is a hard error
 * (applying `wontfix` is a deliberate act, so recording nothing is a real
 * defect), present but below the Context floor is a warning. Like every other
 * check, the message states the rule identically across statuses; only the icon
 * carries the verdict.
 * @param {Record<string, string>} sections
 * @returns {Check}
 */
function checkRejection(sections) {
  const core = `\`${WONTFIX_LABEL}\` owes a reason: at least ${REJECTION_MIN_LENGTH} characters`;
  const value = (sections[REJECTION_HEADING] ?? "").trim();
  if (value === "") {
    return check(REJECTION_KEY, REJECTION_HEADING, STATUS.FAIL, core);
  }
  if (value.length < REJECTION_MIN_LENGTH) {
    return check(
      REJECTION_KEY,
      REJECTION_HEADING,
      STATUS.WARN,
      `${core} — say why it was declined and what would reopen the question`,
    );
  }
  return check(REJECTION_KEY, REJECTION_HEADING, STATUS.PASS, core);
}

/**
 * Label names from a GitHub label list, which the REST API renders as objects
 * and some payloads as bare strings.
 * @param {Array<string|{name: string}>} labels
 * @returns {string[]}
 */
const labelNames = (labels) =>
  labels.map((label) => (typeof label === "string" ? label : label.name));

/**
 * Validate a body against the `FIELDS` descriptor joined to RULES. Returns a
 * per-check scorecard, one line per field in descriptor order. When `title` is given
 * (CI always passes it; the CLI only when `--title` is supplied), a title check
 * is prepended so the scorecard leads with it.
 *
 * A `wontfix` issue is a Rejection: it is checked for a `## Rejection rationale`
 * on top of the work-item checks, never instead of them, since a declined issue
 * whose original what/why is unreadable is no more useful than one with no
 * reason recorded.
 * @param {string} body
 * @param {string} [title] - The issue title, or undefined to skip the check.
 * @param {Array<string|{name: string}>} [labels] - The issue's labels; the
 *   `wontfix` label alone selects the Rejection check.
 * @returns {Scorecard}
 */
export function validate(body, title, labels = []) {
  const sections = parseSections(body);
  const checks = FIELDS.map((field) =>
    checkField(sections, field, RULES[field.id]),
  );
  if (title !== undefined) checks.unshift(checkTitle(title));
  if (labelNames(labels).includes(WONTFIX_LABEL)) {
    checks.push(checkRejection(sections));
  }
  return { checks };
}

/**
 * @param {Check[]} checks
 * @returns {Check[]} The failing checks.
 */
export const failures = (checks) =>
  checks.filter((c) => c.status === STATUS.FAIL);

/**
 * @param {Check[]} checks
 * @returns {Check[]} The warning checks.
 */
export const warnings = (checks) =>
  checks.filter((c) => c.status === STATUS.WARN);

/**
 * The worst status present across the checks: fail beats warn beats pass. The
 * single source of "worst wins" the label and both renderers key off.
 * @param {Check[]} checks
 * @returns {'pass'|'warn'|'fail'}
 */
export function worstStatus(checks) {
  if (checks.some((c) => c.status === STATUS.FAIL)) return STATUS.FAIL;
  if (checks.some((c) => c.status === STATUS.WARN)) return STATUS.WARN;
  return STATUS.PASS;
}

const LABEL_BY_STATUS = {
  [STATUS.FAIL]: LABEL.FAILING,
  [STATUS.WARN]: LABEL.WARNING,
  [STATUS.PASS]: LABEL.PASS,
};

/**
 * Which quality label the scorecard implies: worst wins.
 * @param {Scorecard} scorecard
 * @returns {string} One of the mutually-exclusive `LABEL` values.
 */
export const labelFor = ({ checks }) => LABEL_BY_STATUS[worstStatus(checks)];
