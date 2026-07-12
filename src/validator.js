// Deterministic, dependency-free validator. The issue body is parsed with plain
// string ops (no regex) into `### <heading>` sections. Headings inside fenced code
// blocks (``` or ~~~) are skipped, so a schema heading pasted into a repro can't
// mis-split the body.

import { FIELDS, RULES, CONVENTIONAL_COMMIT_TYPES } from "./rules.js";
import { NO_RESPONSE, LABEL, STATUS, OVERRIDE_HEADING } from "./constants.js";

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
]);

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
 * Dropdown: membership in the field's options, plus RULES `blocking` values too
 * big to land as one issue. Both hard.
 * @param {Field} field
 * @param {Rule|undefined} rule
 * @param {string} value
 * @returns {Check}
 */
function checkEnum(field, rule, value) {
  const { id, heading, options = [] } = field;
  if (!options.includes(value)) {
    return check(
      id,
      heading,
      STATUS.FAIL,
      `must be one of ${options.join(", ")}`,
    );
  }
  if ((rule?.blocking ?? []).includes(value)) {
    return check(
      id,
      heading,
      STATUS.FAIL,
      `${value} is too big to land as one issue; split it into smaller issues`,
    );
  }
  return check(id, heading, STATUS.PASS, value);
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
  const items = countChecklistItems(value);
  if (items < min) {
    const need =
      min === 1
        ? "at least one checklist item"
        : `at least ${min} checklist items`;
    return check(id, heading, STATUS.FAIL, `must contain ${need} (\`- [ ]\`)`);
  }
  return check(
    id,
    heading,
    STATUS.PASS,
    `${items} checklist item${items === 1 ? "" : "s"}`,
  );
}

/**
 * Prose: `minLength` is hard, `maxLength` warning-only. Worst status wins.
 * @param {Field} field
 * @param {Rule|undefined} rule
 * @param {string} value
 * @returns {Check}
 */
function checkProse(field, rule, value) {
  const { id, heading } = field;
  const min = rule?.minLength;
  if (min && value.length < min) {
    return check(
      id,
      heading,
      STATUS.FAIL,
      `too short (${value.length} chars, need at least ${min})`,
    );
  }
  const max = rule?.maxLength;
  if (max && value.length > max) {
    return check(
      id,
      heading,
      STATUS.WARN,
      `long (${value.length} chars, over ${max}); trim narrative bloat`,
    );
  }
  return check(id, heading, STATUS.PASS, `present (${value.length} chars)`);
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
  if (value === "") {
    if (required) {
      return check(
        id,
        heading,
        STATUS.FAIL,
        type === "dropdown" ? "missing" : "missing or empty",
      );
    }
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
  if (type === "dropdown") return checkEnum(field, rule, value);
  if (rule?.checklist) return checkChecklist(field, rule, value);
  return checkProse(field, rule, value);
}

/**
 * Title: a Conventional Commits `type(scope): summary`, so it maps onto the
 * eventual branch/commit. Metadata, not a form field, so it's checked here and
 * prepended to the scorecard rather than derived from the form structure. Hard.
 * @param {string} title - The issue title.
 * @returns {Check}
 */
export function checkTitle(title) {
  const value = String(title ?? "").trim();
  if (value === "") return check("title", "Title", STATUS.FAIL, "missing");
  if (!CONVENTIONAL_TITLE.test(value)) {
    return check(
      "title",
      "Title",
      STATUS.FAIL,
      "must follow Conventional Commits: `type(scope): summary`",
    );
  }
  return check("title", "Title", STATUS.PASS, value);
}

/**
 * Validate a body against the `FIELDS` descriptor joined to RULES. Returns a
 * per-check scorecard, one line per field in descriptor order. When `title` is given
 * (CI always passes it; the CLI only when `--title` is supplied), a title check
 * is prepended so the scorecard leads with it.
 * @param {string} body
 * @param {string} [title] - The issue title, or undefined to skip the check.
 * @returns {Scorecard}
 */
export function validate(body, title) {
  const sections = parseSections(body);
  const checks = FIELDS.map((field) =>
    checkField(sections, field, RULES[field.id]),
  );
  if (title !== undefined) checks.unshift(checkTitle(title));
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
