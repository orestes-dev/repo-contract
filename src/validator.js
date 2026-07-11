// Deterministic, dependency-free validator. The issue body is parsed with plain
// string ops (no regex) into `### <label>` sections.

import {
  RULES,
  NO_RESPONSE,
  LABEL,
  STATUS,
  OVERRIDE_HEADING,
} from "./schema.js";
import { loadForm } from "./form.js";

/**
 * @typedef {import('./form.js').Field} Field
 * @typedef {import('./schema.js').Rule} Rule
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

// Structure from the Issue Form, joined to RULES on `id`. A broken form throws
// here (fail loud) rather than degrading to "no checks".
const FIELDS = loadForm();

// Checklist prefixes matching GitHub's task-list rendering.
const BULLETS = ["-", "*", "+"];
const BOXES = ["[ ]", "[x]", "[X]"];
const CHECKLIST_PREFIXES = BULLETS.flatMap((bullet) =>
  BOXES.map((box) => `${bullet} ${box}`),
);

// Only these headings delimit a section, so a `##`-looking line pasted inside a
// field can't mis-split the body.
const KNOWN_HEADINGS = new Set([
  ...FIELDS.map((f) => f.label),
  OVERRIDE_HEADING,
]);

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
 * Split a body into a { heading: text } map on the known headings.
 * @param {string} body
 * @returns {Record<string, string>}
 */
export function parseSections(body) {
  const sections = {};
  let current = null;
  let buffer = [];

  const flush = () => {
    if (current !== null) sections[current] = buffer.join("\n").trim();
  };

  for (const rawLine of String(body ?? "").split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const heading = parseHeading(line);
    if (heading !== null && KNOWN_HEADINGS.has(heading)) {
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
const check = (key, label, status, message) => ({
  key,
  label,
  status,
  message,
});

/**
 * Dropdown: membership in the form's options, plus RULES `blocking` values too
 * big to land as one issue. Both hard.
 * @param {Field} field
 * @param {Rule} [rule]
 * @param {string} value
 * @returns {Check}
 */
function checkEnum(field, rule, value) {
  const { id, label, options } = field;
  if (!options.includes(value)) {
    return check(
      id,
      label,
      STATUS.FAIL,
      `must be one of ${options.join(", ")}`,
    );
  }
  if ((rule?.blocking ?? []).includes(value)) {
    return check(
      id,
      label,
      STATUS.FAIL,
      `${value} is too big to land as one issue; split it into smaller issues`,
    );
  }
  return check(id, label, STATUS.PASS, value);
}

/**
 * Checklist: at least `minItems` non-empty markdown checklist items.
 * @param {Field} field
 * @param {Rule} rule
 * @param {string} value
 * @returns {Check}
 */
function checkChecklist(field, rule, value) {
  const { id, label } = field;
  const min = rule.minItems ?? 1;
  const items = countChecklistItems(value);
  if (items < min) {
    const need =
      min === 1
        ? "at least one checklist item"
        : `at least ${min} checklist items`;
    return check(id, label, STATUS.FAIL, `must contain ${need} (\`- [ ]\`)`);
  }
  return check(
    id,
    label,
    STATUS.PASS,
    `${items} checklist item${items === 1 ? "" : "s"}`,
  );
}

/**
 * Prose: `minLength` is hard, `maxLength` warning-only. Worst status wins.
 * @param {Field} field
 * @param {Rule} [rule]
 * @param {string} value
 * @returns {Check}
 */
function checkProse(field, rule, value) {
  const { id, label } = field;
  const min = rule?.minLength;
  if (min && value.length < min) {
    return check(
      id,
      label,
      STATUS.FAIL,
      `too short (${value.length} chars, need at least ${min})`,
    );
  }
  const max = rule?.maxLength;
  if (max && value.length > max) {
    return check(
      id,
      label,
      STATUS.WARN,
      `long (${value.length} chars, over ${max}); trim narrative bloat`,
    );
  }
  return check(id, label, STATUS.PASS, `present (${value.length} chars)`);
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
  const { id, label, required, type } = field;
  const value = fieldValue(sections, label);
  if (value === "") {
    if (!required)
      return check(id, label, STATUS.PASS, "optional; not provided");
    return check(
      id,
      label,
      STATUS.FAIL,
      type === "dropdown" ? "missing" : "missing or empty",
    );
  }
  if (type === "dropdown") return checkEnum(field, rule, value);
  if (rule?.checklist) return checkChecklist(field, rule, value);
  return checkProse(field, rule, value);
}

/**
 * Validate a body against the form-derived structure joined to RULES. Returns a
 * per-check scorecard, one line per field in form order.
 * @param {string} body
 * @returns {Scorecard}
 */
export function validate(body) {
  const sections = parseSections(body);
  const checks = FIELDS.map((field) =>
    checkField(sections, field, RULES[field.id]),
  );
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
