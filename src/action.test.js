import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { run } from "./action.js";
import { validate } from "./validator.js";
import { renderComment } from "./report.js";
import { LABEL, OVERRIDE_LABEL, OVERRIDE_HEADING } from "./schema.js";
import { goodBody } from "./fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const failingBody = goodBody.replace("### Size", "### Size\n\nL\n");

// A GitHub client stub that records every mutating call. Reads (getIssue,
// findComment) are not recorded; only writes are, so `calls` is exactly the
// set of side effects a run produced.
function fakeGh({ issue, comments = [] }) {
  const calls = [];
  return {
    calls,
    async getIssue() {
      return issue;
    },
    async ensureLabel(name, color, description) {
      calls.push(["ensureLabel", name, color, description]);
    },
    async addLabels(number, labels) {
      calls.push(["addLabels", number, labels]);
    },
    async removeLabel(number, label) {
      calls.push(["removeLabel", number, label]);
    },
    async findComment(_number, predicate) {
      return comments.find(predicate) ?? null;
    },
    async createComment(number, body) {
      calls.push(["createComment", number, body]);
    },
    async updateComment(id, body) {
      calls.push(["updateComment", id, body]);
    },
    async deleteComment(id) {
      calls.push(["deleteComment", id]);
    },
  };
}

const event = { issue: { number: 7 } };

// The load-bearing anti-loop invariant: a run that finds the issue already in
// its correct end state performs ZERO writes, so the label it would apply can
// never re-trigger the workflow into a loop.

test("no writes when a clean issue already carries the pass label and scorecard", async () => {
  const gh = fakeGh({
    issue: { number: 7, body: goodBody, labels: [{ name: LABEL.PASS }] },
    comments: [
      { id: 1, user: { type: "Bot" }, body: renderComment(validate(goodBody)) },
    ],
  });
  await run({ gh, event });
  assert.deepEqual(gh.calls, []);
});

test("a fresh clean issue gets the pass label and a scorecard comment", async () => {
  const gh = fakeGh({
    issue: { number: 7, body: goodBody, labels: [] },
    comments: [],
  });
  const summary = await run({ gh, event });
  assert.match(summary, /passing/);
  assert.ok(
    gh.calls.some((c) => c[0] === "addLabels" && c[2].includes(LABEL.PASS)),
  );
  const created = gh.calls.find((c) => c[0] === "createComment");
  assert.ok(created, "expected a scorecard comment on clean pass");
  assert.ok(created[2].includes("Issue Quality Checklist"));
});

test("no writes when a failing issue already carries the label and comment", async () => {
  const result = validate(failingBody);
  const gh = fakeGh({
    issue: { number: 7, body: failingBody, labels: [{ name: LABEL.FAILING }] },
    comments: [{ id: 1, user: { type: "Bot" }, body: renderComment(result) }],
  });
  await run({ gh, event });
  assert.deepEqual(gh.calls, []);
});

test("a fresh failing issue gets the failing label and a comment", async () => {
  const gh = fakeGh({
    issue: { number: 7, body: failingBody, labels: [] },
    comments: [],
  });
  await run({ gh, event });
  assert.ok(
    gh.calls.some((c) => c[0] === "addLabels" && c[2].includes(LABEL.FAILING)),
  );
  assert.ok(gh.calls.some((c) => c[0] === "createComment"));
});

// The gate identifies its own comment by marker AND bot authorship. A human who
// pastes the marker into their own comment must not have it adopted.

test("a human comment carrying the marker is not updated; a bot comment is created instead", async () => {
  const gh = fakeGh({
    issue: { number: 7, body: failingBody, labels: [{ name: LABEL.FAILING }] },
    comments: [
      {
        id: 1,
        user: { type: "User" },
        body: renderComment(validate(failingBody)),
      },
    ],
  });
  await run({ gh, event });
  assert.ok(!gh.calls.some((c) => c[0] === "updateComment"));
  assert.ok(gh.calls.some((c) => c[0] === "createComment"));
});

test("a human comment carrying the marker is not deleted on a clean pass", async () => {
  const gh = fakeGh({
    issue: { number: 7, body: goodBody, labels: [{ name: LABEL.PASS }] },
    comments: [
      {
        id: 1,
        user: { type: "User" },
        body: renderComment(validate(failingBody)),
      },
    ],
  });
  await run({ gh, event });
  assert.ok(!gh.calls.some((c) => c[0] === "deleteComment"));
});

// Override: label + a written rationale strips every quality label and the
// gate comment, regardless of whether the body would otherwise pass or fail.

test("override with rationale strips quality label and deletes the comment", async () => {
  const body = [
    failingBody,
    "",
    `## ${OVERRIDE_HEADING}`,
    "",
    "Spike, not real work.",
  ].join("\n");
  const gh = fakeGh({
    issue: {
      number: 7,
      body,
      labels: [{ name: OVERRIDE_LABEL }, { name: LABEL.FAILING }],
    },
    comments: [
      {
        id: 1,
        user: { type: "Bot" },
        body: renderComment(validate(failingBody)),
      },
    ],
  });
  const summary = await run({ gh, event });
  assert.match(summary, /overridden/);
  assert.ok(
    gh.calls.some((c) => c[0] === "removeLabel" && c[2] === LABEL.FAILING),
  );
  assert.ok(gh.calls.some((c) => c[0] === "deleteComment" && c[1] === 1));
  assert.ok(!gh.calls.some((c) => c[0] === "addLabels"));
});

test("override with rationale is a no-op once labels and comment are already cleared", async () => {
  const body = [
    goodBody,
    "",
    `## ${OVERRIDE_HEADING}`,
    "",
    "Spike, not real work.",
  ].join("\n");
  const gh = fakeGh({
    issue: { number: 7, body, labels: [{ name: OVERRIDE_LABEL }] },
    comments: [],
  });
  await run({ gh, event });
  assert.deepEqual(gh.calls, []);
});

test("override label without a rationale warns and keeps the gate applied", async () => {
  const gh = fakeGh({
    issue: { number: 7, body: goodBody, labels: [{ name: OVERRIDE_LABEL }] },
    comments: [],
  });
  await run({ gh, event });
  assert.ok(
    gh.calls.some((c) => c[0] === "addLabels" && c[2].includes(LABEL.WARNING)),
  );
  const created = gh.calls.find((c) => c[0] === "createComment");
  assert.ok(created, "expected a comment to be created");
  assert.ok(created[2].includes(OVERRIDE_HEADING));
});

// The workflow `if:` filter hardcodes JS-side strings in YAML (it cannot import
// the constants). Guard each coupling so a rename cannot silently leave the
// trigger filter stale: the override label name, the issue-quality:* prefix the
// self-heal branch matches, and the bot sender login the human check excludes.
const QUALITY_PREFIX = LABEL.FAILING.slice(0, LABEL.FAILING.indexOf(":") + 1);
const GATE_SENDER = "github-actions[bot]";

test("both workflows couple the trigger filter to the schema strings", () => {
  for (const rel of [
    "templates/workflow.yml",
    ".github/workflows/issue-quality.yml",
  ]) {
    const yaml = read(rel);
    assert.ok(
      yaml.includes(`github.event.label.name == '${OVERRIDE_LABEL}'`),
      `${rel} is missing the override-label trigger guard`,
    );
    assert.ok(
      yaml.includes(`startsWith(github.event.label.name, '${QUALITY_PREFIX}')`),
      `${rel} is missing the quality-label self-heal guard`,
    );
    assert.ok(
      yaml.includes(`github.event.sender.login != '${GATE_SENDER}'`),
      `${rel} is missing the human-sender guard`,
    );
  }
});

// The consumer template (`@main`) and the dogfood workflow (`./`) are accepted
// duplication: they legitimately differ on the `uses:` line, comments, and the
// dogfood's extra `contents: read` + checkout step. This drift test guards the
// parts that MUST stay in lock-step so the repo gates itself exactly as it tells
// consumers to.
test("the two workflows agree on their shared trigger, permissions, concurrency, and filter", () => {
  const consumer = parse(read("templates/workflow.yml"));
  const dogfood = parse(read(".github/workflows/issue-quality.yml"));

  // Issue trigger types. (`on` stays a string key under YAML 1.2, not a bool.)
  assert.deepEqual(consumer.on.issues.types, dogfood.on.issues.types);

  // Permissions: both write issues; the dogfood additionally reads contents for
  // `actions/checkout` (the known, tolerated difference).
  assert.equal(consumer.permissions.issues, "write");
  assert.equal(dogfood.permissions.issues, "write");
  assert.equal(dogfood.permissions.contents, "read");
  assert.equal(consumer.permissions.contents, undefined);

  // Concurrency and the job `if:` filter must be byte-identical.
  assert.deepEqual(consumer.concurrency, dogfood.concurrency);
  assert.equal(
    consumer.jobs["quality-gate"].if,
    dogfood.jobs["quality-gate"].if,
  );
});
