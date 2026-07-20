// The issue gate descriptor: the object-specific seam the shared core
// (`../action.js`) runs against. It injects the label namespace, override
// label/heading, comment marker, structure provider (the validator over the
// body + title), presentation, and blocking policy. The issue gate is advisory
// (`hardFail: false`): GitHub cannot block issue creation, so a red check buys
// nothing (see `docs/adr/0001`).

import { validate } from "../validator.js";
import { ISSUE_PRESENTATION } from "../report.js";
import {
  LABEL,
  LABEL_META,
  OVERRIDE_LABEL,
  OVERRIDE_HEADING,
  COMMENT_MARKER,
} from "../constants.js";

/**
 * @typedef {import('../action.js').Gate} Gate
 * @typedef {import('../action.js').GatedObject} GatedObject
 */

/** @type {Gate} */
export const issueGate = {
  name: "issue",
  labels: LABEL,
  labelMeta: LABEL_META,
  overrideLabel: OVERRIDE_LABEL,
  overrideHeading: OVERRIDE_HEADING,
  commentMarker: COMMENT_MARKER,
  presentation: ISSUE_PRESENTATION,
  hardFail: false,
  getNumber: (event) => event.issue?.number,
  getObject: (gh, number) => gh.getIssue(number),
  // Labels ride along so the validator can grade a `wontfix` issue as a
  // Rejection; `gate.validate` already receives the whole object, so this is the
  // only seam change.
  validate: (object) =>
    validate(object.body || "", object.title, object.labels ?? []),
};
