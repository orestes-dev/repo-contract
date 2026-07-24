import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SCAFFOLDS, contextsFor } from "./scaffolds.js";
import { GATE_CONTEXT, SCAFFOLD } from "./constants.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// --- drift: the Dogfood instance equals the canonical bundle, with no exception ---

// `init` writes every `SCAFFOLDS[].files` entry into a consumer verbatim, and this
// repo's own installed copies are one such install (the Dogfood instance). So the
// claim `src/scaffolds.js` makes in prose, "every destination is a byte-for-byte
// copy of its source", is asserted here once for the whole manifest rather than
// per file: a new scaffold file is drift-checked the moment it joins the table,
// with no test to remember to write (ADR 0003, ADR 0018).
for (const { id, files } of SCAFFOLDS) {
  for (const { from, to } of files) {
    test(`${id}: ${to} is byte-identical to its templates source`, () => {
      // Checked before reading, so a destination that was never installed (or
      // was deleted) reports what is missing instead of a bare ENOENT from the
      // read below.
      assert.ok(
        existsSync(join(ROOT, to)),
        `the ${id} scaffold installs ${to}, which does not exist in this repo`,
      );
      assert.equal(
        readFileSync(join(ROOT, to), "utf8"),
        readFileSync(from, "utf8"),
        `${to} has drifted from its source ${relative(ROOT, from)}`,
      );
    });
  }
}

// --- contexts: read from the vendored workflow files, never restated ---

// A scaffold's contexts are a consequence of the workflows it vendors, which is
// what `GATE_CONTEXT`'s filename-stem keying is for. Listing them per scaffold
// would be one more place to forget when a gate is added or renamed.
test("each scaffold's contexts are exactly those of the workflows it vendors", () => {
  for (const { id, files } of SCAFFOLDS) {
    const stems = files
      .filter((f) => dirname(f.to) === join(".github", "workflows"))
      .map((f) => basename(f.to, extname(f.to)));
    assert.deepEqual(
      contextsFor(id),
      stems.map((stem) => GATE_CONTEXT[stem]),
      `${id} must publish one context per vendored workflow`,
    );
  }
});

// The coupling the report and `nextSteps` both rest on: `quality-gates` carries
// the advisory issue context alongside the merge-blocking PR one, and
// `git-hooks` vendors no workflow at all.
test("contextsFor spans both gates of quality-gates and none of git-hooks", () => {
  assert.deepEqual(contextsFor(SCAFFOLD.QUALITY_GATES), [
    GATE_CONTEXT["issue-quality"],
    GATE_CONTEXT["pr-readiness"],
  ]);
  assert.deepEqual(contextsFor(SCAFFOLD.COMMIT_HYGIENE), [
    GATE_CONTEXT["commit-hygiene"],
  ]);
  assert.deepEqual(contextsFor(SCAFFOLD.GIT_HOOKS), []);
});
