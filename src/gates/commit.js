// The commit gate descriptor: the third object-specific seam the shared core
// (`../action.js`) runs against. It injects the commit-hygiene label namespace,
// override label/heading, comment marker, structure provider (the commit
// validator over the PR's commits + diff), presentation, and blocking policy.
// Like the PR gate it hard-fails CI (`hardFail: true`): a PR's merge check can
// block the unwanted state, so a red check is worth something. Bot-authored PRs
// are exempt, since no human is present to apply an override.
//
// The namespace (`commit-hygiene:*` / `override:commit-hygiene`) is distinct from
// both issue-quality and pr-readiness so one override never waives unrelated
// checks (ADR 0002, orestes/dotfiles#52).

import { validateCommits } from "../commit-validator.js";
import { loadConfig } from "../config.js";
import { COMMIT_PRESENTATION } from "../report.js";
import {
  COMMIT_LABEL,
  COMMIT_LABEL_META,
  COMMIT_OVERRIDE_LABEL,
  OVERRIDE_HEADING,
  COMMIT_COMMENT_MARKER,
  GATE_CONTEXT,
} from "../constants.js";

/**
 * @typedef {import('../action.js').Gate} Gate
 * @typedef {import('../action.js').GatedObject} GatedObject
 */

// A bot actor's login ends in this suffix, e.g. `dependabot[bot]`.
const BOT_SUFFIX = "[bot]";

/** @type {Gate} */
export const commitGate = {
  name: "commit",
  labels: COMMIT_LABEL,
  labelMeta: COMMIT_LABEL_META,
  overrideLabel: COMMIT_OVERRIDE_LABEL,
  overrideHeading: OVERRIDE_HEADING,
  commentMarker: COMMIT_COMMENT_MARKER,
  presentation: COMMIT_PRESENTATION,
  hardFail: true,
  context: GATE_CONTEXT["commit-hygiene"],
  exempt: (object) => (object.author ?? "").endsWith(BOT_SUFFIX),
  getNumber: (event) => event.pull_request?.number ?? event.number,
  getObject: async (gh, number) => {
    const pr = await gh.getPullRequest(number);
    const commits = await gh.getPullRequestCommits(number);
    const files = await gh.getPullRequestFiles(number);
    // The opt-outs are read from the consumer's checkout (`.repo-contract.json`
    // at the workspace root), the same file the local hooks consume.
    const config = loadConfig();
    return { ...pr, commits, files, config };
  },
  validate: (object) =>
    validateCommits({
      commits: object.commits,
      files: object.files,
      headRef: object.headRef,
      defaultBranch: object.defaultBranch,
      config: object.config,
    }),
};
