import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parse } from "yaml";

import { GATE_CONTEXT } from "./constants.js";
import { issueGate } from "./gates/issue.js";
import { prGate } from "./gates/pr.js";
import { commitGate } from "./gates/commit.js";
import {
  checkProtection,
  describe,
  groupByVerdict,
  installedMergeBlockingContexts,
  installedOnly,
  isDrift,
  readProtection,
  verdictFor,
  MERGE_BLOCKING_CONTEXTS,
} from "./protection.js";

/** @param {string} rel @returns {string} */
const read = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const PR = GATE_CONTEXT["pr-readiness"];
const COMMIT = GATE_CONTEXT["commit-hygiene"];
const INSTALLED = ["issue-quality.yml", "pr-readiness.yml"];
const BOTH = [...INSTALLED, "commit-hygiene.yml"];

/**
 * A stub GitHub client exposing only what readProtection reads, counting its
 * calls so the report's cost in API reads can be asserted.
 * @param {{branch?: string, checks?: object}} opts
 * @returns {any}
 */
const stubGh = ({ branch = "main", checks = {} }) => ({
  reads: { branch: 0, checks: 0 },
  async getDefaultBranch() {
    this.reads.branch += 1;
    return branch;
  },
  async getRequiredStatusChecks() {
    this.reads.checks += 1;
    return { contexts: [], protected: false, readable: true, ...checks };
  },
});

/** @param {any} gh @param {string[]} workflowFiles */
const check = (gh, workflowFiles) => checkProtection({ gh, workflowFiles });

// The job key in the workflow YAML IS the status-check context branch protection
// matches on. The YAML cannot import constants.js, so the two are coupled here:
// renaming a job without renaming the constant would make init's protection report
// look for a context nothing publishes, and report false drift in every repo.
test("each gate workflow's job key matches its GATE_CONTEXT constant", () => {
  for (const [stem, context] of Object.entries(GATE_CONTEXT)) {
    const rel = `templates/workflow/${stem}.yml`;
    const doc = parse(read(rel));
    assert.deepEqual(
      Object.keys(doc.jobs),
      [context],
      `${rel} must declare exactly one job named '${context}'`,
    );
  }
});

// The whole point of the rename (ADR 0013): a required-status-check rule matches
// by context name, so two gates sharing one name are indistinguishable to it.
test("the three gate contexts are distinct", () => {
  const contexts = Object.values(GATE_CONTEXT);
  assert.equal(new Set(contexts).size, contexts.length);
});

// Derived from hardFail, so a gate that becomes blocking is reported without
// anyone remembering to widen a list. The issue gate falls out because it is
// advisory, not because it is named as an exception.
test("the merge-blocking set is every hard-failing gate's context", () => {
  assert.deepEqual(MERGE_BLOCKING_CONTEXTS, [PR, COMMIT]);
  for (const gate of [issueGate, prGate, commitGate]) {
    assert.equal(
      MERGE_BLOCKING_CONTEXTS.includes(gate.context),
      gate.hardFail,
      `${gate.name}: membership must follow hardFail`,
    );
  }
});

// GATE_CONTEXT declaration order, not gate registration order, so line order is
// stable across runs.
test("the merge-blocking set follows GATE_CONTEXT declaration order", () => {
  const declared = Object.values(GATE_CONTEXT).filter((c) =>
    MERGE_BLOCKING_CONTEXTS.includes(c),
  );
  assert.deepEqual(MERGE_BLOCKING_CONTEXTS, declared);
});

test("detects each merge-blocking workflow by filename stem", () => {
  assert.deepEqual(installedMergeBlockingContexts(INSTALLED), [PR]);
  assert.deepEqual(installedMergeBlockingContexts(BOTH), [PR, COMMIT]);
  // A suffixed filename still counts; the advisory gate never does.
  assert.deepEqual(installedMergeBlockingContexts(["pr-readiness-2.yaml"]), [
    PR,
  ]);
  assert.deepEqual(installedMergeBlockingContexts(["issue-quality.yml"]), []);
  assert.deepEqual(installedMergeBlockingContexts([]), []);
  // A stem match that is not a workflow file must not count.
  assert.deepEqual(installedMergeBlockingContexts(["pr-readiness.md"]), []);
});

test("a context with no workflow on disk is not-installed and reads nothing", async () => {
  const gh = stubGh({});
  const results = await check(gh, ["issue-quality.yml"]);
  assert.deepEqual(
    results.map((r) => r.verdict),
    ["not-installed", "not-installed"],
  );
  assert.deepEqual(installedOnly(results), []);
  assert.deepEqual(gh.reads, { branch: 0, checks: 0 });
});

test("reports the gate enforced when its context is required", async () => {
  const results = await check(
    stubGh({ checks: { contexts: ["build", PR], protected: true } }),
    INSTALLED,
  );
  const [pr] = installedOnly(results);
  assert.equal(pr.verdict, "required");
  assert.equal(isDrift(pr), false);
});

test("reports drift when the branch is protected but the gate is not required", async () => {
  const results = await check(
    stubGh({ checks: { contexts: ["build"], protected: true } }),
    INSTALLED,
  );
  const [pr] = installedOnly(results);
  assert.equal(pr.verdict, "not-required");
  assert.equal(isDrift(pr), true);
  assert.deepEqual(pr.required, ["build"]);
});

test("reports drift when the default branch has no protection at all", async () => {
  const [pr] = installedOnly(await check(stubGh({}), INSTALLED));
  assert.equal(pr.verdict, "unprotected");
  assert.equal(isDrift(pr), true);
});

// A 403 is an unknown, not a verdict. Collapsing it into not-required would tell
// every contributor without admin scope that their gate is unenforced.
test("an unreadable answer is not reported as drift", async () => {
  const [pr] = installedOnly(
    await check(stubGh({ checks: { readable: false } }), INSTALLED),
  );
  assert.equal(pr.verdict, "unreadable");
  assert.equal(isDrift(pr), false);
});

// A ruleset alone protects the branch; classic protection may be absent.
test("a ruleset-supplied context counts as required", async () => {
  const [pr] = installedOnly(
    await check(
      stubGh({ checks: { contexts: [PR], protected: true } }),
      INSTALLED,
    ),
  );
  assert.equal(pr.verdict, "required");
});

// The point of the amendment: both gates hard-fail, so both can be wrong about
// blocking, and one can be right while the other is not.
test("two vendored gates get independent verdicts from one pair of reads", async () => {
  const gh = stubGh({ checks: { contexts: [PR], protected: true } });
  const results = installedOnly(await check(gh, BOTH));
  assert.deepEqual(
    results.map((r) => [r.context, r.verdict]),
    [
      [PR, "required"],
      [COMMIT, "not-required"],
    ],
  );
  assert.deepEqual(gh.reads, { branch: 1, checks: 1 });
});

// An orphaned gate workflow runs on every PR and is exactly as unrequired as any
// other, so the predicate is the file, never the manifest.
test("a workflow on disk gets a verdict whatever the manifest records", async () => {
  const results = installedOnly(
    await check(stubGh({ checks: { protected: true } }), [
      "commit-hygiene.yml",
    ]),
  );
  assert.deepEqual(
    results.map((r) => r.context),
    [COMMIT],
  );
});

test("the verdict is pure and the read happens once", async () => {
  const gh = stubGh({ checks: { contexts: [COMMIT], protected: true } });
  const protection = await readProtection(gh);
  assert.deepEqual(protection, {
    branch: "main",
    required: [COMMIT],
    protected: true,
    readable: true,
  });
  assert.equal(verdictFor(COMMIT, protection).verdict, "required");
  assert.equal(verdictFor(PR, protection).verdict, "not-required");
  assert.equal(verdictFor(PR, null).verdict, "not-installed");
  assert.deepEqual(gh.reads, { branch: 1, checks: 1 });
});

// `unprotected` and `unreadable` are facts about the branch, so the contexts
// sharing one collapse into a single line. The verdicts stay per context.
test("contexts sharing a verdict group into one line", async () => {
  for (const checks of [{}, { readable: false }]) {
    const results = installedOnly(await check(stubGh({ checks }), BOTH));
    const groups = groupByVerdict(results);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].contexts, [PR, COMMIT]);
    assert.match(describe(groups[0]), /'main'/);
  }
});

test("contexts with different verdicts stay on their own lines", async () => {
  const groups = groupByVerdict(
    installedOnly(
      await check(
        stubGh({ checks: { contexts: [PR], protected: true } }),
        BOTH,
      ),
    ),
  );
  assert.deepEqual(
    groups.map((g) => [g.verdict, g.contexts]),
    [
      ["required", [PR]],
      ["not-required", [COMMIT]],
    ],
  );
  assert.match(describe(groups[0]), /is a required status check on 'main'/);
  assert.match(describe(groups[1]), /is not among its required status checks/);
});

test("a grouped line names every context it covers", () => {
  const group = {
    verdict: /** @type {const} */ ("unprotected"),
    branch: "main",
    contexts: [PR, COMMIT],
    required: [],
  };
  const line = describe(group);
  assert.ok(line.includes(`'${PR}'`) && line.includes(`'${COMMIT}'`));
  assert.match(line, /checks run on every PR and block nothing/);
});
