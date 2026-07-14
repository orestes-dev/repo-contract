// Renders a validation scorecard for the bot comment and CLI. Both show every
// check, pass included. The object-specific chrome (marker, heading, footers,
// override banner) is injected as a `presentation`, so one renderer serves every
// gate; `ISSUE_PRESENTATION` is the default and keeps the issue gate verbatim.

import {
  COMMENT_MARKER,
  STATUS,
  OVERRIDE_LABEL,
  OVERRIDE_HEADING,
  PR_COMMENT_MARKER,
  PR_OVERRIDE_LABEL,
} from "./constants.js";
import { worstStatus } from "./validator.js";

/** @typedef {import('./validator.js').Check} Check */

/**
 * The object-specific chrome around a scorecard: the hidden comment marker, the
 * scorecard heading, the CLI one-liner label, the per-status footers, and the
 * override banner/footer. Injected so one renderer serves the issue and PR gates.
 * @typedef {object} Presentation
 * @property {string} marker - Hidden HTML comment identifying the bot comment.
 * @property {string} heading - Scorecard `###` heading.
 * @property {string} cliLabel - Terminal one-liner prefix, e.g. "Issue quality gate".
 * @property {Record<'pass'|'warn'|'fail', string>} footers - Footer per worst status.
 * @property {string} overrideBanner - Leading banner when the gate is overridden.
 * @property {string} overrideFooter - Footer when the gate is overridden.
 */

const ICON = {
  [STATUS.PASS]: "✅",
  [STATUS.WARN]: "⚠️",
  [STATUS.FAIL]: "❌",
};

// The issue gate's chrome, kept verbatim from before the seam existed. Also the
// default presentation, so `renderComment(scorecard)` still renders an issue
// scorecard with no caller changes.
/** @type {Presentation} */
export const ISSUE_PRESENTATION = {
  marker: COMMENT_MARKER,
  heading: "Issue Quality Checklist",
  cliLabel: "Issue quality gate",
  footers: {
    [STATUS.FAIL]:
      `> Fix the failing checks, or add the \`${OVERRIDE_LABEL}\` label with an ` +
      `\`## ${OVERRIDE_HEADING}\` section in the issue body to bypass.`,
    [STATUS.WARN]: "> All required checks pass. Warnings are informational.",
    [STATUS.PASS]:
      "> All checks pass. This issue meets the structural quality bar.",
  },
  overrideBanner:
    `> ⏭️ **Gate overridden.** The \`${OVERRIDE_LABEL}\` label and an ` +
    `\`## ${OVERRIDE_HEADING}\` section are both set, so no quality label is ` +
    `applied. The checks below are advisory.`,
  overrideFooter:
    `> Remove the \`${OVERRIDE_LABEL}\` label or the \`## ${OVERRIDE_HEADING}\` ` +
    `section to re-apply the gate.`,
};

// The PR gate's chrome. The PR gate hard-fails CI, so its failing footer points
// at the red check as the merge-blocking signal, not the label.
/** @type {Presentation} */
export const PR_PRESENTATION = {
  marker: PR_COMMENT_MARKER,
  heading: "PR Readiness Checklist",
  cliLabel: "PR readiness gate",
  footers: {
    [STATUS.FAIL]:
      `> This check is failing, which blocks merge. Fix the failing checks, or ` +
      `add the \`${PR_OVERRIDE_LABEL}\` label with an \`## ${OVERRIDE_HEADING}\` ` +
      `section in the PR description to bypass.`,
    [STATUS.WARN]: "> All required checks pass. Warnings are informational.",
    [STATUS.PASS]:
      "> All checks pass. This PR meets the structural quality bar.",
  },
  overrideBanner:
    `> ⏭️ **Gate overridden.** The \`${PR_OVERRIDE_LABEL}\` label and an ` +
    `\`## ${OVERRIDE_HEADING}\` section are both set, so no quality label is ` +
    `applied. The checks below are advisory.`,
  overrideFooter:
    `> Remove the \`${PR_OVERRIDE_LABEL}\` label or the \`## ${OVERRIDE_HEADING}\` ` +
    `section to re-apply the gate.`,
};

// Terminal one-liner for the run's worst status.
const CLI_STATUS_LABEL = {
  [STATUS.FAIL]: "FAILED",
  [STATUS.WARN]: "passed with warnings",
  [STATUS.PASS]: "passed",
};

/**
 * Bot-comment markdown, with the hidden marker for in-place updates. On an
 * override the scorecard still renders, leading with a banner that the gate is
 * bypassed, so every run leaves a comment behind.
 * @param {{checks: Check[]}} scorecard
 * @param {{overridden?: boolean, presentation?: Presentation}} [options]
 * @returns {string}
 */
export function renderComment(
  { checks },
  { overridden = false, presentation = ISSUE_PRESENTATION } = {},
) {
  const lines = [presentation.marker, `### ${presentation.heading}`, ""];
  if (overridden) lines.push(presentation.overrideBanner, "");
  for (const c of checks) {
    lines.push(`- ${ICON[c.status]} **${c.label}**: ${c.message}`);
  }
  lines.push(
    "",
    overridden
      ? presentation.overrideFooter
      : presentation.footers[worstStatus(checks)],
  );
  return lines.join("\n");
}

/**
 * Plain-text report for terminal / CLI output.
 * @param {{checks: Check[]}} scorecard
 * @param {{presentation?: Presentation}} [options]
 * @returns {string}
 */
export function renderCli(
  { checks },
  { presentation = ISSUE_PRESENTATION } = {},
) {
  const lines = [
    `${presentation.cliLabel}: ${CLI_STATUS_LABEL[worstStatus(checks)]}`,
  ];
  for (const c of checks) {
    lines.push(`  ${ICON[c.status]} ${c.label}: ${strip(c.message)}`);
  }
  return lines.join("\n");
}

/**
 * Drop markdown bold/code markers for terminal readability.
 * @param {string} text
 * @returns {string}
 */
function strip(text) {
  return text.split("**").join("").split("`").join("");
}
