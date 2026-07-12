// Gate core: validates an issue body, reconciles the mutually-exclusive quality
// labels, and keeps a single bot comment in sync. Every write is diff-based, so
// a re-run in the correct state writes nothing and the label triggers do not
// loop.

import {
  validate,
  labelFor,
  hasOverrideRationale,
  failures,
  warnings,
} from "./validator.js";
import { renderComment } from "./report.js";
import {
  LABEL,
  LABEL_META,
  STATUS,
  COMMENT_MARKER,
  OVERRIDE_LABEL,
  OVERRIDE_HEADING,
} from "./constants.js";

/** @typedef {import('./validator.js').Scorecard} Scorecard */
/** @typedef {import('./github.js').GitHub} GitHub */

const ALL_QUALITY_LABELS = [LABEL.FAILING, LABEL.WARNING, LABEL.PASS];

/**
 * Author must be a bot so a human who pastes the marker isn't adopted.
 * @param {object} c - A GitHub comment resource.
 * @returns {boolean}
 */
const isGateComment = (c) =>
  c.user?.type === "Bot" && c.body?.includes(COMMENT_MARKER);

/**
 * Drive the issue to carry exactly `desiredLabel` (or none). Add before remove:
 * an interrupted run then leaves the issue over-labeled rather than unlabeled,
 * which is more visible and self-corrects next run.
 * @param {GitHub} gh
 * @param {number} issueNumber
 * @param {string[]} currentLabels
 * @param {string|null} desiredLabel - The quality label to keep, or null for none.
 * @returns {Promise<void>}
 */
async function reconcileLabels(gh, issueNumber, currentLabels, desiredLabel) {
  const current = new Set(currentLabels);

  if (desiredLabel && !current.has(desiredLabel)) {
    const meta = LABEL_META[desiredLabel];
    await gh.ensureLabel(desiredLabel, meta.color, meta.description);
    await gh.addLabels(issueNumber, [desiredLabel]);
  }

  const toRemove = ALL_QUALITY_LABELS.filter(
    (label) => label !== desiredLabel && current.has(label),
  );
  for (const label of toRemove) await gh.removeLabel(issueNumber, label);
}

/**
 * Remove the gate's own comment if present.
 * @param {GitHub} gh
 * @param {number} issueNumber
 * @returns {Promise<void>}
 */
async function deleteGateComment(gh, issueNumber) {
  const existing = await gh.findComment(issueNumber, isGateComment);
  if (existing) await gh.deleteComment(existing.id);
}

/**
 * Upsert the scorecard comment. Every outcome carries it, pass included: a green
 * checklist confirms the gate ran.
 * @param {GitHub} gh
 * @param {number} issueNumber
 * @param {Scorecard} result
 * @returns {Promise<void>}
 */
async function syncComment(gh, issueNumber, result) {
  const existing = await gh.findComment(issueNumber, isGateComment);
  const bodyText = renderComment(result);
  if (!existing) {
    await gh.createComment(issueNumber, bodyText);
    return;
  }
  // Rewrite only on change, to avoid comment churn.
  if (existing.body.trim() !== bodyText.trim()) {
    await gh.updateComment(existing.id, bodyText);
  }
}

/**
 * Core gate logic, decoupled from process env so tests can inject a client and
 * event.
 * @param {object} params
 * @param {GitHub} params.gh
 * @param {object} params.event - The webhook event payload, carrying `.issue`.
 * @returns {Promise<string>} A status string for logging.
 */
export async function run({ gh, event }) {
  const eventIssue = event.issue;
  if (!eventIssue) throw new Error("Event payload has no issue.");

  // Fetch fresh: the event payload's body/labels can be stale.
  const issue = await gh.getIssue(eventIssue.number);
  const body = issue.body || "";
  const currentLabels = (issue.labels || []).map((l) =>
    typeof l === "string" ? l : l.name,
  );

  // Manual override: label plus a written rationale bypasses the gate.
  if (currentLabels.includes(OVERRIDE_LABEL) && hasOverrideRationale(body)) {
    await reconcileLabels(gh, issue.number, currentLabels, null);
    await deleteGateComment(gh, issue.number);
    return `issue #${issue.number}: overridden`;
  }

  const result = validate(body, issue.title);

  // Override signalled but incomplete: nudge the author, as a warning line.
  if (currentLabels.includes(OVERRIDE_LABEL) && !hasOverrideRationale(body)) {
    result.checks.push({
      key: "override",
      label: "Override",
      status: STATUS.WARN,
      message: `\`${OVERRIDE_LABEL}\` is set but there is no \`## ${OVERRIDE_HEADING}\` section; the gate still applies`,
    });
  }

  const desiredLabel = labelFor(result);
  await reconcileLabels(gh, issue.number, currentLabels, desiredLabel);
  await syncComment(gh, issue.number, result);

  const fails = failures(result.checks);
  const warns = warnings(result.checks);
  if (fails.length > 0) {
    return `issue #${issue.number}: failing (${fails.length} error(s))`;
  }
  if (warns.length > 0) {
    return `issue #${issue.number}: warning (${warns.length} warning(s))`;
  }
  return `issue #${issue.number}: passing`;
}
