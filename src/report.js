// Renders a validation scorecard for the bot comment and CLI. Both show every
// check, pass included.

import {
  COMMENT_MARKER,
  STATUS,
  OVERRIDE_LABEL,
  OVERRIDE_HEADING,
} from "./schema.js";
import { worstStatus } from "./validator.js";

/** @typedef {import('./validator.js').Check} Check */

const ICON = {
  [STATUS.PASS]: "✅",
  [STATUS.WARN]: "⚠️",
  [STATUS.FAIL]: "❌",
};

const FIX_FOOTER =
  `> Fix the failing checks, or add the \`${OVERRIDE_LABEL}\` label with an ` +
  `\`## ${OVERRIDE_HEADING}\` section in the issue body to bypass.`;
const WARN_FOOTER = "> All required checks pass. Warnings are informational.";
const PASS_FOOTER =
  "> All checks pass. This issue meets the structural quality bar.";

const FOOTER_BY_STATUS = {
  [STATUS.FAIL]: FIX_FOOTER,
  [STATUS.WARN]: WARN_FOOTER,
  [STATUS.PASS]: PASS_FOOTER,
};

// Terminal one-liner for the run's worst status.
const CLI_STATUS_LABEL = {
  [STATUS.FAIL]: "FAILED",
  [STATUS.WARN]: "passed with warnings",
  [STATUS.PASS]: "passed",
};

/**
 * The footer line for the worst status in the scorecard.
 * @param {Check[]} checks
 * @returns {string}
 */
const footer = (checks) => FOOTER_BY_STATUS[worstStatus(checks)];

/**
 * Bot-comment markdown, with the hidden marker for in-place updates.
 * @param {{checks: Check[]}} scorecard
 * @returns {string}
 */
export function renderComment({ checks }) {
  const lines = [COMMENT_MARKER, "### Issue Quality Checklist", ""];
  for (const c of checks) {
    lines.push(`- ${ICON[c.status]} **${c.label}**: ${c.message}`);
  }
  lines.push("", footer(checks));
  return lines.join("\n");
}

/**
 * Plain-text report for terminal / CLI output.
 * @param {{checks: Check[]}} scorecard
 * @returns {string}
 */
export function renderCli({ checks }) {
  const lines = [
    `Issue quality gate: ${CLI_STATUS_LABEL[worstStatus(checks)]}`,
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
