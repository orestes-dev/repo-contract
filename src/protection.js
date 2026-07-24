// Detect whether a vendored gate workflow is actually merge-blocking.
//
// Vendoring a workflow buys the check RUNNING, never the check BLOCKING. What
// blocks a merge is a required-status-check rule on the default branch, which
// lives in repository settings that no repo can commit. That is the same split
// ADR 0012 drew for hooks (a vendored hook file is execution; `core.hooksPath` is
// activation), applied to gates: `init` ships the enforcing half's *carrier* and
// cannot ship the enforcement itself.
//
// So the unversioned half drifts silently, and the tool that exists to kill that
// failure mode could not see it. This module reports the gap. It never repairs it
// (ADR 0014): detection is what was missing, and `init` is a routine command that
// must not carry admin scope over five default branches.
//
// It covers EVERY hard-failing gate, not `pr-readiness` alone: an unrequired
// `commit-hygiene` context blocks exactly as little as an unrequired
// `pr-readiness` one. Which contexts those are is derived from the gate
// descriptors' `hardFail` policy below, so a gate that becomes blocking is
// reported without anyone remembering to widen a list.

import { basename, extname } from "node:path";

import { GATE_CONTEXT } from "./constants.js";
import { issueGate } from "./gates/issue.js";
import { prGate } from "./gates/pr.js";
import { commitGate } from "./gates/commit.js";

/** @typedef {import('./github.js').GitHub} GitHub */
/** @typedef {import('./action.js').Gate} Gate */

/** Every gate descriptor, the input the merge-blocking set is derived from. */
/** @type {Gate[]} */
const GATES = [issueGate, prGate, commitGate];

// The contexts whose gate hard-fails CI, and which a required-status-check rule
// is therefore expected to name. Derived from `hardFail`, never hand-listed: the
// blocking policy already exists on the descriptor, and restating it is the one
// duplication that goes stale silently in the direction that hurts. The issue
// gate falls out of the set rather than being special-cased: it is advisory,
// because issues have no merge to block.
//
// Ordered by `GATE_CONTEXT` declaration order rather than by gate registration,
// so the report's line order is stable across runs and matches the constant a
// reader is looking at.
export const MERGE_BLOCKING_CONTEXTS = Object.values(GATE_CONTEXT).filter(
  (context) => GATES.some((gate) => gate.context === context && gate.hardFail),
);

// The workflow filename stem of each context, the inverse of `GATE_CONTEXT`. The
// two are equal today, so this exists to keep the file predicate honest about
// which side of the mapping it is on rather than to translate anything.
const STEM_BY_CONTEXT = new Map(
  Object.entries(GATE_CONTEXT).map(([stem, context]) => [context, stem]),
);

const WORKFLOW_EXTENSIONS = [".yml", ".yaml"];

/**
 * The merge-blocking contexts whose workflow file is present in
 * `.github/workflows/`.
 *
 * The predicate is the FILE, not the `scaffolds` manifest. The manifest's
 * authority (ADR 0016) covers what repo-contract owns and reconciles; GitHub has
 * only ever read `.github/workflows/`, so the file is what makes a check run and
 * therefore what makes an unrequired context a live gap. Keying off it is also
 * what lets an Orphan gate, on disk and absent from the manifest, get a verdict
 * like any other.
 *
 * Matches the `<stem>*.yml` shape `init` writes, so a repo that suffixed a
 * filename (`pr-readiness-2.yml`) still counts.
 * @param {string[]} workflowFiles - Basenames found in `.github/workflows/`.
 * @returns {string[]} Contexts, in `MERGE_BLOCKING_CONTEXTS` order.
 */
export function installedMergeBlockingContexts(workflowFiles) {
  const stems = workflowFiles
    .filter((f) => WORKFLOW_EXTENSIONS.includes(extname(f)))
    .map((f) => basename(f, extname(f)));
  return MERGE_BLOCKING_CONTEXTS.filter((context) => {
    const stem = /** @type {string} */ (STEM_BY_CONTEXT.get(context));
    return stems.some((s) => s.startsWith(stem));
  });
}

/**
 * The verdicts a context can reach, worst first. A caller maps these onto
 * presentation; none of them changes `init`'s exit code.
 * @typedef {'not-installed'|'unreadable'|'unprotected'|'not-required'|'required'} ProtectionVerdict
 */

/**
 * The default branch's enforcement posture, read once per run. A fact about the
 * branch, shared by every context evaluated against it.
 * @typedef {object} Protection
 * @property {string} branch - The default branch inspected.
 * @property {string[]} required - Contexts currently required on it.
 * @property {boolean} protected - Whether it has protection or a ruleset at all.
 * @property {boolean} readable - Whether the read was permitted (a 403 is not a
 *   verdict).
 */

/**
 * One context's verdict against that posture.
 * @typedef {object} ProtectionResult
 * @property {ProtectionVerdict} verdict
 * @property {string} branch - The default branch inspected ("" when not reached).
 * @property {string} context - The status-check context the gate publishes.
 * @property {string[]} required - Contexts currently required on the branch.
 */

/**
 * Read the default branch's enforcement posture. The only I/O in this module, and
 * every call it makes is a GET: no verdict below triggers a write.
 *
 * Split out of the verdict so N contexts cost one default-branch read and one
 * protection read, rather than N of each.
 * @param {GitHub} gh
 * @returns {Promise<Protection>}
 */
export async function readProtection(gh) {
  const branch = await gh.getDefaultBranch();
  const {
    contexts,
    protected: isProtected,
    readable,
  } = await gh.getRequiredStatusChecks(branch);
  return { branch, required: contexts, protected: isProtected, readable };
}

/**
 * Decide one context's verdict. Pure: given a posture, no I/O and no ordering
 * dependence, so the whole report is one read plus a map.
 *
 * The verdicts are deliberately five, not a boolean, because the ways this can be
 * wrong are not interchangeable. `unreadable` in particular must never collapse
 * into `not-required`: the tool would then report a confident, false "your gate is
 * not enforced" to anyone running it without admin scope.
 * @param {string} context
 * @param {Protection|null} protection - Null when no workflow publishing this
 *   context is vendored here, which is `not-installed`: there is no gate to be
 *   wrong about, so the branch is never even read.
 * @returns {ProtectionResult}
 */
export function verdictFor(context, protection) {
  if (!protection)
    return { verdict: "not-installed", branch: "", context, required: [] };
  const { branch, required, readable } = protection;
  if (!readable)
    return { verdict: "unreadable", branch, context, required: [] };
  if (!protection.protected)
    return { verdict: "unprotected", branch, context, required: [] };
  if (!required.includes(context))
    return { verdict: "not-required", branch, context, required };
  return { verdict: "required", branch, context, required };
}

/**
 * Every merge-blocking context, with its verdict, from a single pair of reads.
 * A context with no workflow on disk is `not-installed` and costs no I/O; when
 * none is installed, nothing is read at all, since there is no gap to report
 * where there is no gate.
 *
 * The `not-installed` results are returned rather than dropped so a caller can
 * see the whole set, but a report shows only what is installed: naming a gate the
 * operator declined would advertise the package rather than describe this repo.
 * @param {object} params
 * @param {GitHub} params.gh
 * @param {string[]} params.workflowFiles - Basenames in `.github/workflows/`.
 * @returns {Promise<ProtectionResult[]>} In `MERGE_BLOCKING_CONTEXTS` order.
 */
export async function checkProtection({ gh, workflowFiles }) {
  const installed = installedMergeBlockingContexts(workflowFiles);
  const protection = installed.length > 0 ? await readProtection(gh) : null;
  return MERGE_BLOCKING_CONTEXTS.map((context) =>
    verdictFor(context, installed.includes(context) ? protection : null),
  );
}

/**
 * The results a report prints: every context whose workflow is actually on disk.
 * @param {ProtectionResult[]} results
 * @returns {ProtectionResult[]}
 */
export function installedOnly(results) {
  return results.filter((r) => r.verdict !== "not-installed");
}

// Verdicts that mean "the gate is not actually enforcing". `unreadable` is
// excluded on purpose: it is an unknown, and reporting an unknown as drift would
// make the check cry wolf in exactly the repos an operator cannot fix from here.
const DRIFT_VERDICTS = new Set(["unprotected", "not-required"]);

/**
 * Whether a verdict represents enforcement drift the operator should act on.
 * Typed against the verdict alone so it reads a single result or a group.
 * @param {{verdict: ProtectionVerdict}} result
 * @returns {boolean}
 */
export function isDrift(result) {
  return DRIFT_VERDICTS.has(result.verdict);
}

/**
 * Contexts sharing one verdict, collapsed for presentation.
 * @typedef {object} ProtectionGroup
 * @property {ProtectionVerdict} verdict
 * @property {string} branch
 * @property {string[]} contexts
 * @property {string[]} required
 */

/**
 * Group results by verdict, first appearance first (so `MERGE_BLOCKING_CONTEXTS`
 * order governs). The collapsing lives here, in presentation, and never in the
 * verdict model: `unprotected` and `unreadable` are facts about the branch that
 * every context shares, and printing them once per context would read as several
 * findings where there is one.
 * @param {ProtectionResult[]} results
 * @returns {ProtectionGroup[]}
 */
export function groupByVerdict(results) {
  /** @type {Map<ProtectionVerdict, ProtectionGroup>} */
  const groups = new Map();
  for (const { verdict, branch, context, required } of results) {
    const group = groups.get(verdict);
    if (group) {
      group.contexts.push(context);
      continue;
    }
    groups.set(verdict, { verdict, branch, contexts: [context], required });
  }
  return [...groups.values()];
}

/** @param {string[]} contexts @returns {string} */
const quoted = (contexts) => contexts.map((c) => `'${c}'`).join(" and ");

/**
 * The one-line explanation for a group, ready to print.
 * @param {ProtectionGroup} group
 * @returns {string}
 */
export function describe({ verdict, branch, contexts, required }) {
  const names = quoted(contexts);
  const plural = contexts.length > 1;
  switch (verdict) {
    case "not-installed":
      return (
        `no workflow publishing ${names} in .github/workflows/, so there is ` +
        `nothing to require. Run \`init\` first.`
      );
    case "unreadable":
      return (
        `cannot read branch protection for '${branch}' (403), so whether ` +
        `${names} ${plural ? "are" : "is"} required is unknown. This is a ` +
        "permissions answer, not a verdict: the rule may well be in place. " +
        "Re-run with a token carrying admin scope on the repository."
      );
    case "unprotected":
      return (
        `'${branch}' has no branch protection and no ruleset. The ${names} ` +
        `${plural ? "checks run" : "check runs"} on every PR and ` +
        `${plural ? "block" : "blocks"} nothing: any PR can merge while a gate ` +
        "is red, or before it has reported at all."
      );
    case "not-required":
      return (
        `'${branch}' is protected, but ${names} ` +
        `${plural ? "are" : "is"} not among its required status checks ` +
        `(${required.join(", ") || "none"}). ` +
        `${plural ? "Those gates run" : "The gate runs"} and ` +
        `${plural ? "report" : "reports"}, and merge proceeds regardless of ` +
        `what ${plural ? "they report" : "it reports"}.`
      );
    default:
      return plural
        ? `${names} are required status checks on '${branch}'.`
        : `${names} is a required status check on '${branch}'.`;
  }
}
