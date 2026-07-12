// Structural validator for a pull request. PR structure is defined here in code
// (the source of truth), not parsed from Markdown at runtime; the
// `.github/PULL_REQUEST_TEMPLATE.md` is drift-tested against `PR_SECTIONS`. The
// gate checks presence only, never conformance: a required section must be
// present and non-empty, and the title must follow Conventional Commits.

import { check, checkTitle, parseSections } from "./validator.js";
import { STATUS, OVERRIDE_HEADING } from "./constants.js";

/** @typedef {import('./validator.js').Check} Check */
/** @typedef {import('./validator.js').Scorecard} Scorecard */

/**
 * The checkbox label an author checks to flag a Divergence. Its exact text is
 * pinned to the template by the drift test, so the code that reads the flag and
 * the Markdown that renders it cannot drift apart.
 */
export const DIVERGENCE_FLAG =
  "This PR diverges from the linked issue's original what/why.";

/**
 * One section of the PR body: its `##`/`###` heading and whether the gate
 * requires it. A `flag` marks a section governed by a conditional-rationale rule
 * instead of plain presence: the section is optional (`required: false`) until
 * its flag checkbox is checked, at which point a rationale becomes mandatory.
 * @typedef {object} PrSection
 * @property {string} heading - The rendered section heading.
 * @property {boolean} required - Whether the gate enforces its presence.
 * @property {string} [flag] - The checkbox label whose checked state makes a
 *   rationale in this section mandatory.
 */

/**
 * The PR structure descriptor: the source of truth the Markdown template is
 * drift-tested against. Summary and Verification are required by presence;
 * Divergence is optional until its flag checkbox is checked, when it owes a
 * rationale (enforced by `checkDivergence`, not the presence loop).
 * @type {PrSection[]}
 */
export const PR_SECTIONS = [
  { heading: "Summary", required: true },
  { heading: "Verification", required: true },
  { heading: "Divergence", required: false, flag: DIVERGENCE_FLAG },
];

// Markdown task-list prefixes, split by checked state so the flag's checkbox can
// be read and so checkbox lines can be stripped when measuring the rationale.
const BULLETS = ["-", "*", "+"];
const CHECKED_BOXES = ["[x]", "[X]"];
const UNCHECKED_BOXES = ["[ ]"];
const CHECKED_PREFIXES = BULLETS.flatMap((bullet) =>
  CHECKED_BOXES.map((box) => `${bullet} ${box}`),
);
const CHECKBOX_PREFIXES = BULLETS.flatMap((bullet) =>
  [...CHECKED_BOXES, ...UNCHECKED_BOXES].map((box) => `${bullet} ${box}`),
);

const HTML_COMMENT_OPEN = "<!--";
const HTML_COMMENT_CLOSE = "-->";

// Headings that delimit a PR section when parsing the body: every declared
// section plus the override heading, so an override rationale isn't swallowed
// into the preceding section.
const PR_HEADINGS = new Set([
  ...PR_SECTIONS.map((s) => s.heading),
  OVERRIDE_HEADING,
]);

/**
 * Presence check for one required section: present and non-empty passes, absent
 * or empty is a hard error (the PR gate hard-fails CI on any error).
 * @param {Record<string, string>} sections
 * @param {PrSection} section
 * @returns {Check}
 */
function checkSection(sections, { heading }) {
  const value = (sections[heading] ?? "").trim();
  const key = heading.toLowerCase();
  if (value === "") {
    return check(key, heading, STATUS.FAIL, "missing or empty");
  }
  return check(key, heading, STATUS.PASS, `present (${value.length} chars)`);
}

/**
 * Whether the given section text carries the flag's checkbox in a checked state
 * (`- [x] <flag>`). Matched against the flag's exact label so a stray checked
 * box in the rationale prose does not trip the rule.
 * @param {string} sectionText
 * @param {string} flag
 * @returns {boolean}
 */
function isFlagChecked(sectionText, flag) {
  return sectionText.split("\n").some((rawLine) => {
    const line = rawLine.trim();
    const prefix = CHECKED_PREFIXES.find((p) => line.startsWith(p));
    return prefix !== undefined && line.slice(prefix.length).trim() === flag;
  });
}

/**
 * Strip `<!-- ... -->` spans so the template's inline voice guidance doesn't
 * count as a written rationale. An unterminated comment drops the rest of the
 * text. Plain string scan, no regex.
 * @param {string} text
 * @returns {string}
 */
function stripHtmlComments(text) {
  let result = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf(HTML_COMMENT_OPEN, i);
    if (open === -1) return result + text.slice(i);
    result += text.slice(i, open);
    const close = text.indexOf(
      HTML_COMMENT_CLOSE,
      open + HTML_COMMENT_OPEN.length,
    );
    if (close === -1) return result;
    i = close + HTML_COMMENT_CLOSE.length;
  }
  return result;
}

/**
 * The author's written rationale in a section: its content with checkbox lines
 * (the flag itself) and HTML guidance comments removed, trimmed. Empty means no
 * rationale was written.
 * @param {string} sectionText
 * @returns {string}
 */
function rationaleText(sectionText) {
  return stripHtmlComments(sectionText)
    .split("\n")
    .filter((rawLine) => {
      const line = rawLine.trim();
      return !CHECKBOX_PREFIXES.some((p) => line.startsWith(p));
    })
    .join("\n")
    .trim();
}

/**
 * Conditional-rationale check for the Divergence section: passes when the flag
 * is unchecked (no divergence declared), hard-fails when the flag is checked but
 * no rationale is written, passes when both are present. Presence only; the
 * honesty of the rationale is the reviewer's call, not the gate's.
 * @param {Record<string, string>} sections
 * @param {PrSection} section
 * @returns {Check}
 */
function checkDivergence(sections, { heading, flag = "" }) {
  const raw = sections[heading] ?? "";
  const key = heading.toLowerCase();
  if (!isFlagChecked(raw, flag)) {
    return check(key, heading, STATUS.PASS, "no divergence flagged");
  }
  const rationale = rationaleText(raw);
  if (rationale === "") {
    return check(
      key,
      heading,
      STATUS.FAIL,
      "flagged but missing a rationale; explain the divergence",
    );
  }
  return check(
    key,
    heading,
    STATUS.PASS,
    `flagged with rationale (${rationale.length} chars)`,
  );
}

/**
 * Validate a PR body and title into a scorecard: the Conventional Commits title
 * check leads, followed by one presence check per required section, then the
 * Divergence conditional-rationale check, in template order.
 * @param {string} body - The PR description.
 * @param {string} [title] - The PR title; absent is treated as an empty (failing) title.
 * @returns {Scorecard}
 */
export function validatePr(body, title = "") {
  const sections = parseSections(body, PR_HEADINGS);
  const checks = [
    checkTitle(title),
    ...PR_SECTIONS.filter((s) => s.required).map((s) =>
      checkSection(sections, s),
    ),
  ];
  const flagged = PR_SECTIONS.find((s) => s.flag);
  if (flagged) checks.push(checkDivergence(sections, flagged));
  return { checks };
}
