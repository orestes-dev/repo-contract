// The PR gate descriptor: the second object-specific seam the shared core
// (`../action.js`) runs against. It injects the PR label namespace, override
// label/heading, comment marker, structure provider (the PR validator over the
// body + title), presentation, and blocking policy. The PR gate hard-fails CI
// (`hardFail: true`): a PR's merge check _can_ block the unwanted state, so a
// red check is worth something (see `docs/adr/0001`). Bot-authored PRs are
// exempt, since no human is present to apply an override.

import { validatePr } from "../pr-validator.js";
import { PR_PRESENTATION } from "../report.js";
import {
  PR_LABEL,
  PR_LABEL_META,
  PR_OVERRIDE_LABEL,
  OVERRIDE_HEADING,
  PR_COMMENT_MARKER,
  GATE_CONTEXT,
} from "../constants.js";

/**
 * @typedef {import('../action.js').Gate} Gate
 * @typedef {import('../action.js').GatedObject} GatedObject
 */

// A bot actor's login ends in this suffix, e.g. `dependabot[bot]`.
const BOT_SUFFIX = "[bot]";

/** @type {Gate} */
export const prGate = {
  name: "pr",
  labels: PR_LABEL,
  labelMeta: PR_LABEL_META,
  overrideLabel: PR_OVERRIDE_LABEL,
  overrideHeading: OVERRIDE_HEADING,
  commentMarker: PR_COMMENT_MARKER,
  presentation: PR_PRESENTATION,
  hardFail: true,
  context: GATE_CONTEXT["pr-readiness"],
  exempt: (object) => (object.author ?? "").endsWith(BOT_SUFFIX),
  getNumber: (event) => event.pull_request?.number ?? event.number,
  getObject: async (gh, number) => {
    const pr = await gh.getPullRequest(number);
    const linkedIssues = await gh.getLinkedIssues(number);
    return { ...pr, linkedIssues };
  },
  validate: (object) =>
    validatePr(object.body || "", object.title, object.linkedIssues),
};
