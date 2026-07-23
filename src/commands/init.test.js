import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { ensureGateLabels, reportProtection } from "./init.js";
import { labelsFor, filesFor } from "../scaffolds.js";
import {
  OVERRIDE_LABEL,
  PR_OVERRIDE_LABEL,
  COMMIT_OVERRIDE_LABEL,
  WONTFIX_LABEL,
  WONTFIX_LABEL_META,
  GATE_CONTEXT,
  MERGE_BLOCKING_GATE,
  SCAFFOLD,
  SCAFFOLD_IDS,
} from "../constants.js";

// The whole package: what an all-in install reconciles, and the baseline every
// per-scaffold assertion below is carved out of.
const ALL_LABELS = labelsFor(SCAFFOLD_IDS);

// The repo root, where `.github/workflows/pr-readiness.yml` actually lives, so
// `reportProtection` sees the merge-blocking workflow as vendored and proceeds to
// the (stubbed) protection read instead of short-circuiting to not-installed.
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// A GitHub stub exposing only what checkProtection reads: the default branch and
// its required status checks. No network, no ensureLabel.
const stubGh = (checks) => ({
  getDefaultBranch: async () => "main",
  getRequiredStatusChecks: async () => ({
    contexts: [],
    protected: false,
    readable: true,
    ...checks,
  }),
});

// An all-in install still reconciles the whole schema: the three gate triples,
// the three override labels, and `wontfix`.
test("an all-in selection covers the full label schema, overrides included", () => {
  assert.equal(ALL_LABELS.length, 13);
  const names = ALL_LABELS.map((l) => l.name);
  for (const override of [
    OVERRIDE_LABEL,
    PR_OVERRIDE_LABEL,
    COMMIT_OVERRIDE_LABEL,
  ]) {
    assert.ok(names.includes(override), `missing ${override}`);
  }
  for (const { color, description } of ALL_LABELS) {
    assert.match(color, /^[0-9a-f]{6}$/, "each label carries a hex color");
    assert.ok(description.length > 0, "each label carries a description");
  }
});

// Labels follow the selection, which is the point of the per-scaffold manifest:
// nothing appears in a repo's label list for a gate it did not install.
test("each scaffold claims exactly its own labels", () => {
  const quality = labelsFor([SCAFFOLD.QUALITY_GATES]).map((l) => l.name);
  const commit = labelsFor([SCAFFOLD.COMMIT_HYGIENE]).map((l) => l.name);

  assert.ok(quality.includes(OVERRIDE_LABEL));
  assert.ok(quality.includes(PR_OVERRIDE_LABEL));
  assert.ok(
    quality.includes(WONTFIX_LABEL),
    "the Rejection selector is the issue gate's",
  );
  assert.ok(!quality.includes(COMMIT_OVERRIDE_LABEL));

  assert.ok(commit.includes(COMMIT_OVERRIDE_LABEL));
  assert.ok(
    commit.every(
      (name) =>
        name.startsWith("commit-hygiene") || name === COMMIT_OVERRIDE_LABEL,
    ),
  );

  // The hooks run locally against a committed config; nothing on the remote.
  assert.deepEqual(labelsFor([SCAFFOLD.GIT_HOOKS]), []);

  // Together the three partition the schema, with no overlap and nothing left over.
  assert.equal(quality.length + commit.length, ALL_LABELS.length);
});

// Every file belongs to exactly one scaffold, which is what makes "touch only
// that scaffold" precise for `init` and for the follow-up `uninstall`.
test("the three scaffolds partition the vendored files", () => {
  const all = filesFor(SCAFFOLD_IDS).map((f) => f.to);
  const perScaffold = SCAFFOLD_IDS.flatMap((id) =>
    filesFor([id]).map((f) => f.to),
  );
  assert.deepEqual([...all].sort(), [...perScaffold].sort());
  assert.equal(new Set(all).size, all.length, "no file is claimed twice");
});

// A client stub whose ensureLabel returns a scripted per-name verdict, so the
// reporting can be asserted without a network.
function fakeClient(verdicts) {
  const calls = [];
  return {
    calls,
    async ensureLabel(name, color, description) {
      calls.push({ name, color, description });
      return verdicts[name] ?? "ok";
    },
  };
}

test("ensureGateLabels reports created / repaired / ok per label", async () => {
  const client = fakeClient({
    [OVERRIDE_LABEL]: "created",
    [PR_OVERRIDE_LABEL]: "repaired",
  });
  const lines = [];
  await ensureGateLabels({
    client,
    log: (l) => lines.push(l),
    ids: SCAFFOLD_IDS,
  });

  assert.equal(client.calls.length, ALL_LABELS.length);
  assert.ok(
    lines.some((l) => l.startsWith("created") && l.includes(OVERRIDE_LABEL)),
  );
  assert.ok(
    lines.some(
      (l) => l.startsWith("repaired") && l.includes(PR_OVERRIDE_LABEL),
    ),
  );
  assert.ok(lines.some((l) => l.startsWith("ok")));
});

// The Rejection selector is materialized like the override labels: a gate run
// never applies it, so nothing would create it on demand. Its metadata is
// GitHub's own default, so reconciling it in a repo that never recoloured the
// label is a no-op.
test("the schema carries wontfix with GitHub's default metadata", () => {
  const wontfix = ALL_LABELS.find((l) => l.name === WONTFIX_LABEL);
  assert.ok(wontfix, "wontfix is part of the fixed schema");
  assert.equal(wontfix.color, "ffffff");
  assert.equal(wontfix.description, "This will not be worked on");
  assert.deepEqual(WONTFIX_LABEL_META[WONTFIX_LABEL], {
    color: wontfix.color,
    description: wontfix.description,
  });
});

test("ensureGateLabels reconciles wontfix alongside the gate labels", async () => {
  const client = fakeClient({ [WONTFIX_LABEL]: "created" });
  const lines = [];
  await ensureGateLabels({
    client,
    log: (l) => lines.push(l),
    ids: SCAFFOLD_IDS,
  });

  const call = client.calls.find((c) => c.name === WONTFIX_LABEL);
  assert.deepEqual(call, {
    name: WONTFIX_LABEL,
    color: "ffffff",
    description: "This will not be worked on",
  });
  assert.ok(
    lines.some((l) => l.startsWith("created") && l.includes(WONTFIX_LABEL)),
  );
});

test("ensureGateLabels skips (no write) when there are no credentials", async () => {
  const lines = [];
  await ensureGateLabels({
    client: null,
    log: (l) => lines.push(l),
    ids: SCAFFOLD_IDS,
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^skip\s+labels \(no GitHub credentials/);
});

// A hooks-only install needs nothing on the remote, so the step reports why it
// wrote nothing rather than silently looping zero times.
test("ensureGateLabels skips when the selection needs no labels", async () => {
  const client = fakeClient({});
  const lines = [];
  await ensureGateLabels({
    client,
    log: (l) => lines.push(l),
    ids: [SCAFFOLD.GIT_HOOKS],
  });
  assert.equal(client.calls.length, 0);
  assert.match(
    lines[0],
    /^skip\s+labels \(the installed scaffolds need none\)/,
  );
});

test("reportProtection skips (no read) when there are no credentials", async () => {
  const lines = [];
  await reportProtection({ client: null, log: (l) => lines.push(l) });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^skip\s+protection \(no GitHub credentials/);
});

test("reportProtection warns and prints the remediation on drift", async () => {
  const lines = [];
  await reportProtection({
    client: stubGh({ contexts: ["build"], protected: true }),
    log: (l) => lines.push(l),
    cwd: REPO_ROOT,
  });
  assert.ok(lines[0].startsWith("warn"), `first line was: ${lines[0]}`);
  // The advisory second line names the context and stays read-only in tone.
  assert.ok(
    lines.some(
      (l) =>
        l.includes(`Requiring '${GATE_CONTEXT[MERGE_BLOCKING_GATE]}'`) &&
        l.includes("will not take for you"),
    ),
  );
});

test("reportProtection reports ok with no remediation when the gate is required", async () => {
  const lines = [];
  await reportProtection({
    client: stubGh({
      contexts: [GATE_CONTEXT[MERGE_BLOCKING_GATE]],
      protected: true,
    }),
    log: (l) => lines.push(l),
    cwd: REPO_ROOT,
  });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith("ok"), `line was: ${lines[0]}`);
});
