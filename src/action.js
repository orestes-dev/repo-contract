// Gate core: validates an object's body, reconciles the mutually-exclusive
// quality labels, and keeps a single bot comment in sync. Object-agnostic: every
// per-object fact (label namespace, override label, comment marker, structure
// provider, presentation, blocking policy) is injected through a `Gate`
// descriptor, so the issue gate and the PR gate are two callers of one core.
// Every write is diff-based, so a re-run in the correct state writes nothing and
// the label triggers do not loop.

import { hasOverrideRationale, worstStatus } from "./validator.js";
import { renderComment, renderApiUnavailable } from "./report.js";
import { STATUS, EXEMPT_CHECK } from "./constants.js";
import { issueGate } from "./gates/issue.js";
import { ApiUnavailableError } from "./github.js";

/** @typedef {import('./validator.js').Scorecard} Scorecard */
/** @typedef {import('./report.js').Presentation} Presentation */
/** @typedef {import('./github.js').GitHub} GitHub */
/** @typedef {import('./github.js').Comment} Comment */

/**
 * The subset of a gated object (issue or PR) the core reads.
 * @typedef {object} GatedObject
 * @property {number} number
 * @property {string} [title]
 * @property {string} [body]
 * @property {Array<string|{name: string}>} [labels]
 * @property {string} [author] - Login of the object's author (PRs only), so a
 *   gate can exempt bot authors.
 * @property {import('./github.js').LinkedIssue[]} [linkedIssues] - Native linked
 *   issues (PRs only), for the transitive clearance check.
 * @property {{sha: string, subject: string}[]} [commits] - The PR's commits
 *   (commit gate only), for the Conventional Commits subject check.
 * @property {{filename: string, patch: string}[]} [files] - The PR's changed
 *   files (commit gate only), for the em-dash-in-diff check.
 * @property {string} [headRef] - The PR head branch name (commit gate only).
 * @property {string} [defaultBranch] - The base repo's default branch name
 *   (commit gate only).
 * @property {import('./config.js').Config} [config] - The parsed
 *   `.repo-contract.json` opt-outs (commit gate only).
 */

/**
 * The object-specific seam the core runs against. One descriptor per gated
 * object (issue, PR); the core reads everything it needs from here.
 * @typedef {object} Gate
 * @property {string} name - Object noun for log lines, e.g. "issue".
 * @property {{PASS: string, WARNING: string, FAILING: string}} labels - The
 *   mutually-exclusive quality labels, worst status wins.
 * @property {Record<string, {color: string, description: string}>} labelMeta -
 *   Color/description per label, so the gate creates them intentionally.
 * @property {string} overrideLabel - The manual escape-hatch label.
 * @property {string} overrideHeading - The `## <heading>` a rationale lives under.
 * @property {string} commentMarker - Hidden marker identifying the bot comment.
 * @property {Presentation} presentation - Scorecard chrome for the renderer.
 * @property {boolean} hardFail - Whether a failing verdict should fail CI (PR),
 *   or stay advisory (issue).
 * @property {string} context - The status-check context this gate's workflow
 *   publishes, from `GATE_CONTEXT`. Paired with `hardFail`, it is what lets the
 *   merge-blocking set be derived rather than hand-listed (ADR 0014, amended).
 * @property {(event: any) => number|undefined} getNumber - The object number
 *   in the triggering event.
 * @property {(gh: GitHub, number: number) => Promise<GatedObject>} getObject -
 *   Fetch the object fresh from the API (the event payload can be stale).
 * @property {(object: GatedObject) => Scorecard} validate - The structure
 *   provider: validate a fetched object into a scorecard.
 * @property {(object: GatedObject) => boolean} [exempt] - Optional predicate;
 *   an exempt object auto-passes (PR bot authors) with no override needed.
 */

/**
 * The outcome of a gate run.
 * @typedef {object} GateResult
 * @property {string} summary - A one-line status string for logging.
 * @property {'pass'|'warn'|'fail'} status - The worst status; a hard-fail gate
 *   fails CI on `fail`. Override and exempt runs resolve to `pass`.
 */

/** @type {Record<'pass'|'warn'|'fail', 'PASS'|'WARNING'|'FAILING'>} */
const STATUS_TO_LABEL_KEY = {
  [STATUS.FAIL]: "FAILING",
  [STATUS.WARN]: "WARNING",
  [STATUS.PASS]: "PASS",
};

/**
 * The quality label a scorecard implies for this gate: worst status wins.
 * @param {Scorecard} scorecard
 * @param {Gate} gate
 * @returns {string} One of the gate's mutually-exclusive labels.
 */
const labelFor = ({ checks }, gate) =>
  gate.labels[STATUS_TO_LABEL_KEY[worstStatus(checks)]];

/**
 * Author must be a bot so a human who pastes the marker isn't adopted.
 * @param {string} marker
 * @returns {(c: Comment) => boolean}
 */
const isGateComment = (marker) => (c) =>
  c.user?.type === "Bot" && c.body?.includes(marker);

/**
 * Drive the object to carry exactly `desiredLabel` (or none). Add before remove:
 * an interrupted run then leaves it over-labeled rather than unlabeled, which is
 * more visible and self-corrects next run.
 * @param {GitHub} gh
 * @param {Gate} gate
 * @param {number} number
 * @param {string[]} currentLabels
 * @param {string|null} desiredLabel - The quality label to keep, or null for none.
 * @returns {Promise<void>}
 */
async function reconcileLabels(gh, gate, number, currentLabels, desiredLabel) {
  const current = new Set(currentLabels);
  const allQualityLabels = [
    gate.labels.FAILING,
    gate.labels.WARNING,
    gate.labels.PASS,
  ];

  if (desiredLabel && !current.has(desiredLabel)) {
    const meta = gate.labelMeta[desiredLabel];
    await gh.ensureLabel(desiredLabel, meta.color, meta.description);
    await gh.addLabels(number, [desiredLabel]);
  }

  const toRemove = allQualityLabels.filter(
    (label) => label !== desiredLabel && current.has(label),
  );
  for (const label of toRemove) await gh.removeLabel(number, label);
}

/**
 * Upsert the scorecard comment. Every outcome carries it, pass and override
 * included: a green checklist confirms the gate ran, and an override still shows
 * the scorecard with a banner acknowledging the bypass.
 * @param {GitHub} gh
 * @param {Gate} gate
 * @param {number} number
 * @param {Scorecard} result
 * @param {{overridden?: boolean}} [options]
 * @returns {Promise<void>}
 */
async function syncComment(gh, gate, number, result, options = {}) {
  const existing = await gh.findComment(
    number,
    isGateComment(gate.commentMarker),
  );
  const bodyText = renderComment(result, {
    ...options,
    presentation: gate.presentation,
  });
  if (!existing) {
    await gh.createComment(number, bodyText);
    return;
  }
  // Rewrite only on change, to avoid comment churn.
  if (existing.body.trim() !== bodyText.trim()) {
    await gh.updateComment(existing.id, bodyText);
  }
}

/**
 * Handle a GitHub-side outage the client could not retry past. Best-effort:
 * upsert a distinct notice on the object (carrying the gate's marker, so a later
 * healthy run replaces it) and fail the run without touching any quality label.
 * The write may itself fail if the API is fully down; that is swallowed, since the
 * red check and its summary already name the cause. Deliberately NOT a quality
 * label: an outage must never read as a rule verdict on the object.
 * @param {GitHub} gh
 * @param {Gate} gate
 * @param {number} number
 * @param {ApiUnavailableError} err
 * @returns {Promise<GateResult>}
 */
async function apiUnavailable(gh, gate, number, err) {
  const bodyText = renderApiUnavailable(err, {
    presentation: gate.presentation,
  });
  try {
    const existing = await gh.findComment(
      number,
      isGateComment(gate.commentMarker),
    );
    if (!existing) {
      await gh.createComment(number, bodyText);
    } else if (existing.body.trim() !== bodyText.trim()) {
      await gh.updateComment(existing.id, bodyText);
    }
  } catch {
    // API still unreachable; the red verdict below stands on its own.
  }
  const status = err.status === null ? "network error" : err.status;
  return {
    summary: `${gate.name} #${number}: GitHub API unavailable (${status})`,
    status: STATUS.FAIL,
  };
}

/**
 * Core gate logic, decoupled from process env so tests can inject a client and
 * event. The `gate` descriptor selects the object; it defaults to the issue gate
 * so the issue callers (CI, sweep) stay unchanged.
 * @param {object} params
 * @param {GitHub} params.gh
 * @param {object} params.event - The webhook event payload.
 * @param {Gate} [params.gate] - The object descriptor; defaults to the issue gate.
 * @returns {Promise<GateResult>} The run's summary and worst status.
 */
export async function run({ gh, event, gate = issueGate }) {
  const number = gate.getNumber(event);
  if (number === undefined) {
    throw new Error(`Event payload has no ${gate.name}.`);
  }

  // Fetch fresh: the event payload's body/labels can be stale. A GitHub-side
  // outage past the retry window is NOT a rule verdict: annotate the object with a
  // distinct notice and fail (never apply a quality label), so the red check names
  // the outage rather than masquerading as a governance failure (docs/adr/0010).
  let object;
  try {
    object = await gate.getObject(gh, number);
  } catch (err) {
    if (err instanceof ApiUnavailableError) {
      return apiUnavailable(gh, gate, number, err);
    }
    throw err;
  }
  const body = object.body || "";
  const currentLabels = (object.labels || []).map((l) =>
    typeof l === "string" ? l : l.name,
  );

  // Exemption: a bot-authored PR auto-passes with no override needed. Reconcile
  // the pass label and post a single-line scorecard, diff-based like every other
  // path so a re-run is a no-op.
  if (gate.exempt?.(object)) {
    const result = { checks: [{ ...EXEMPT_CHECK, status: STATUS.PASS }] };
    await reconcileLabels(gh, gate, number, currentLabels, gate.labels.PASS);
    await syncComment(gh, gate, number, result);
    return {
      summary: `${gate.name} #${number}: exempt (bot author)`,
      status: STATUS.PASS,
    };
  }

  // Manual override: label plus a written rationale bypasses the gate. The
  // quality label is stripped (no machine verdict under override), but the
  // scorecard stays and leads with a banner acknowledging the bypass, so every
  // run still leaves a comment behind.
  if (
    currentLabels.includes(gate.overrideLabel) &&
    hasOverrideRationale(body)
  ) {
    await reconcileLabels(gh, gate, number, currentLabels, null);
    const result = gate.validate(object);
    await syncComment(gh, gate, number, result, { overridden: true });
    return {
      summary: `${gate.name} #${number}: overridden`,
      status: STATUS.PASS,
    };
  }

  const result = gate.validate(object);

  // Override signalled but incomplete: nudge the author, as a warning line.
  if (
    currentLabels.includes(gate.overrideLabel) &&
    !hasOverrideRationale(body)
  ) {
    result.checks.push({
      key: "override",
      label: "Override",
      status: STATUS.WARN,
      message: `\`${gate.overrideLabel}\` is set but there is no \`## ${gate.overrideHeading}\` section; the gate still applies`,
    });
  }

  const desiredLabel = labelFor(result, gate);
  await reconcileLabels(gh, gate, number, currentLabels, desiredLabel);
  await syncComment(gh, gate, number, result);

  const worst = worstStatus(result.checks);
  if (worst === STATUS.FAIL) {
    const fails = result.checks.filter((c) => c.status === STATUS.FAIL).length;
    return {
      summary: `${gate.name} #${number}: failing (${fails} error(s))`,
      status: STATUS.FAIL,
    };
  }
  if (worst === STATUS.WARN) {
    const warns = result.checks.filter((c) => c.status === STATUS.WARN).length;
    return {
      summary: `${gate.name} #${number}: warning (${warns} warning(s))`,
      status: STATUS.WARN,
    };
  }
  return { summary: `${gate.name} #${number}: passing`, status: STATUS.PASS };
}
