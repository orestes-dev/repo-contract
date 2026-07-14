// Structural validator for a pull request. PR structure is defined here in code
// (the source of truth), not parsed from Markdown at runtime; the
// `.github/PULL_REQUEST_TEMPLATE.md` is drift-tested against `PR_SECTIONS`. The
// gate checks presence only, never conformance: a required section must be
// present and non-empty, and the title must follow Conventional Commits.

import { check, checkTitle, parseSections } from "./validator.js";
import {
  STATUS,
  OVERRIDE_HEADING,
  LABEL,
  OVERRIDE_LABEL,
} from "./constants.js";

/** @typedef {import('./validator.js').Check} Check */
/** @typedef {import('./validator.js').Scorecard} Scorecard */
/** @typedef {import('./github.js').LinkedIssue} LinkedIssue */

// A linked issue is "ready" (per CONTEXT.md Readiness) when it carries any of
// these labels: the positive pass/warning/override union, never the mere absence
// of `failing` (which would sweep in un-gated issues).
const READY_LABELS = [LABEL.PASS, LABEL.WARNING, OVERRIDE_LABEL];

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
 * drift-tested against. Summary, Verification, Scope, and Decisions are required
 * by presence; Divergence is optional until its flag checkbox is checked, when it
 * owes a rationale (enforced by `checkDivergence`, not the presence loop).
 * @type {PrSection[]}
 */
export const PR_SECTIONS = [
  { heading: "Summary", required: true },
  { heading: "Verification", required: true },
  { heading: "Scope", required: true },
  { heading: "Decisions", required: true },
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
    return check(key, heading, STATUS.FAIL, "missing");
  }
  return check(key, heading, STATUS.PASS, "present");
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
  return check(key, heading, STATUS.PASS, "flagged with rationale");
}

/** The scorecard key/label for the transitive linked-issue readiness check. */
const LINKED_KEY = "linked-issues";
const LINKED_LABEL = "Linked issues";

/**
 * Whether a linked issue carries a ready label (pass/warning/override union).
 * @param {LinkedIssue} issue
 * @returns {boolean}
 */
const isIssueReady = (issue) =>
  issue.labels.some((name) => READY_LABELS.includes(name));

/**
 * A trailing note about cross-repo links, which are ignored for readiness (the
 * workflow token cannot reliably read another repo's labels). Empty when there
 * are none, so the scorecard says so rather than passing silently.
 * @param {LinkedIssue[]} crossRepo
 * @returns {string}
 */
function crossRepoNote(crossRepo) {
  if (crossRepo.length === 0) return "";
  const plural = crossRepo.length === 1 ? "" : "s";
  return ` (${crossRepo.length} cross-repo link${plural} ignored for readiness)`;
}

/**
 * Transitive readiness check: every same-repo linked issue must be ready, and a
 * PR must close at least one same-repo issue (each is a spec it claims to
 * satisfy). Cross-repo links are ignored but noted. Hard error on zero links or
 * any not-ready issue; the check re-runs only on PR events, so a failure hints
 * at re-running once a linked issue is fixed (`docs/adr/0002`).
 * @param {LinkedIssue[]} linkedIssues
 * @returns {Check}
 */
function checkLinkedIssues(linkedIssues) {
  const sameRepo = linkedIssues.filter((i) => i.sameRepo);
  const note = crossRepoNote(linkedIssues.filter((i) => !i.sameRepo));
  if (sameRepo.length === 0) {
    return check(
      LINKED_KEY,
      LINKED_LABEL,
      STATUS.FAIL,
      `no same-repo linked issue; link the issue(s) this PR closes with \`Closes #N\`${note}`,
    );
  }
  const notReady = sameRepo.filter((i) => !isIssueReady(i));
  if (notReady.length > 0) {
    const list = notReady.map((i) => `#${i.number}`).join(", ");
    return check(
      LINKED_KEY,
      LINKED_LABEL,
      STATUS.FAIL,
      `not ready: ${list}; every linked issue must pass, warn, or be overridden before merge. If you've since fixed them, re-run this check.${note}`,
    );
  }
  const plural = sameRepo.length === 1 ? "" : "s";
  return check(
    LINKED_KEY,
    LINKED_LABEL,
    STATUS.PASS,
    `${sameRepo.length} linked issue${plural} ready${note}`,
  );
}

/**
 * Validate a PR body and title into a scorecard: the Conventional Commits title
 * check leads, followed by one presence check per required section, the
 * Divergence conditional-rationale check, and, when `linkedIssues` is supplied,
 * the transitive readiness check. The CLI preflight omits `linkedIssues` (no PR
 * exists yet), so readiness is checked only in CI.
 * @param {string} body - The PR description.
 * @param {string} [title] - The PR title; absent is treated as an empty (failing) title.
 * @param {LinkedIssue[]} [linkedIssues] - The PR's native linked issues, or
 *   undefined to skip the readiness check (CLI preflight).
 * @returns {Scorecard}
 */
export function validatePr(body, title = "", linkedIssues) {
  const sections = parseSections(body, PR_HEADINGS);
  const checks = [
    checkTitle(title),
    ...PR_SECTIONS.filter((s) => s.required).map((s) =>
      checkSection(sections, s),
    ),
  ];
  const flagged = PR_SECTIONS.find((s) => s.flag);
  if (flagged) checks.push(checkDivergence(sections, flagged));
  if (linkedIssues !== undefined) {
    checks.push(checkLinkedIssues(linkedIssues));
  }
  return { checks };
}
