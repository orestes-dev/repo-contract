import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  ensureGateLabels,
  reportProtection,
  findOrphans,
  reportOrphans,
  nextSteps,
} from "./init.js";
import { HOOKS_PATH } from "../hook-activation.js";
import { labelsFor, filesFor, contextsFor } from "../scaffolds.js";
import { MERGE_BLOCKING_CONTEXTS } from "../protection.js";
import {
  OVERRIDE_LABEL,
  PR_OVERRIDE_LABEL,
  COMMIT_OVERRIDE_LABEL,
  WONTFIX_LABEL,
  WONTFIX_LABEL_META,
  GATE_CONTEXT,
  SCAFFOLD,
  SCAFFOLD_IDS,
} from "../constants.js";

// The whole package: what an all-in install reconciles, and the baseline every
// per-scaffold assertion below is carved out of.
const ALL_LABELS = labelsFor(SCAFFOLD_IDS);

const PR_CONTEXT = GATE_CONTEXT["pr-readiness"];
const COMMIT_CONTEXT = GATE_CONTEXT["commit-hygiene"];

// A GitHub stub exposing only what readProtection reads: the default branch and
// its required status checks. No network, no ensureLabel. It counts its reads, so
// the report's cost can be asserted as one of each however many contexts it
// covers.
const stubGh = (checks) => ({
  reads: { branch: 0, checks: 0 },
  async getDefaultBranch() {
    this.reads.branch += 1;
    return "main";
  },
  async getRequiredStatusChecks() {
    this.reads.checks += 1;
    return { contexts: [], protected: false, readable: true, ...checks };
  },
});

// A scratch directory carrying a chosen set of workflow files, since the report
// keys off `.github/workflows/` rather than off any manifest.
function withWorkflows(names) {
  const dir = mkdtempSync(join(tmpdir(), "rc-protection-"));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  for (const name of names) {
    writeFileSync(join(dir, ".github", "workflows", name), "whatever bytes");
  }
  return dir;
}

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

// A scratch git repo with a chosen set of scaffold files already on disk, so
// orphan detection can be exercised against a real filesystem and a real
// `core.hooksPath`.
function withRepo(present) {
  const dir = mkdtempSync(join(tmpdir(), "rc-orphan-"));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  for (const { to } of filesFor(present)) {
    const dest = join(dir, to);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, "whatever bytes");
  }
  return dir;
}

// An orphan is a scaffold present on disk that the manifest does not record. It
// is reported and never removed: `init` is additive everywhere else, and
// deleting live workflows or hooks mid-run is destructive. Teardown is
// `uninstall`'s job.
test("findOrphans reports files on disk that the selection does not claim", () => {
  const dir = withRepo([SCAFFOLD.QUALITY_GATES]);
  try {
    const orphans = findOrphans([SCAFFOLD.GIT_HOOKS], dir);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].id, SCAFFOLD.QUALITY_GATES);
    assert.equal(
      orphans[0].files.length,
      filesFor([SCAFFOLD.QUALITY_GATES]).length,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a selected scaffold's files are never orphans", () => {
  const dir = withRepo(SCAFFOLD_IDS);
  try {
    assert.deepEqual(findOrphans(SCAFFOLD_IDS, dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unselected scaffold that is absent from disk is not an orphan", () => {
  const dir = withRepo([]);
  try {
    assert.deepEqual(findOrphans([SCAFFOLD.GIT_HOOKS], dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Detection reaches `core.hooksPath` because the report exists to answer "is this
// still enforcing?" — orphaned hooks that git is still pointed at fire on every
// commit, which is exactly the state an operator needs told.
test("orphaned hooks still pointed at by core.hooksPath report as enforcing", () => {
  const dir = withRepo([SCAFFOLD.GIT_HOOKS]);
  try {
    execFileSync("git", ["-C", dir, "config", "core.hooksPath", HOOKS_PATH], {
      stdio: "ignore",
    });
    const [orphan] = findOrphans([SCAFFOLD.QUALITY_GATES], dir);
    assert.equal(orphan.id, SCAFFOLD.GIT_HOOKS);
    assert.equal(orphan.enforcing, true);

    const lines = [];
    reportOrphans({ orphans: [orphan], log: (l) => lines.push(l) });
    assert.match(lines[0], /^orphan\s+git-hooks/);
    assert.match(lines[1], /still points at/);
    assert.match(lines[1], /repo-contract uninstall git-hooks/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("orphaned hooks that git is not pointed at report as not enforcing", () => {
  const dir = withRepo([SCAFFOLD.GIT_HOOKS]);
  try {
    const [orphan] = findOrphans([SCAFFOLD.QUALITY_GATES], dir);
    assert.equal(orphan.enforcing, false);
    const lines = [];
    reportOrphans({ orphans: [orphan], log: (l) => lines.push(l) });
    assert.equal(lines.length, 1, "no enforcement warning where none applies");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  const dir = withWorkflows(["pr-readiness.yml"]);
  const lines = [];
  try {
    await reportProtection({
      client: stubGh({ contexts: ["build"], protected: true }),
      log: (l) => lines.push(l),
      cwd: dir,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(lines[0].startsWith("warn"), `first line was: ${lines[0]}`);
  // The advisory second line names the context and stays read-only in tone.
  assert.ok(
    lines.some(
      (l) =>
        l.includes(`Requiring '${PR_CONTEXT}'`) &&
        l.includes("will not take for you"),
    ),
  );
});

test("reportProtection reports ok with no remediation when the gate is required", async () => {
  const dir = withWorkflows(["pr-readiness.yml"]);
  const lines = [];
  try {
    await reportProtection({
      client: stubGh({ contexts: [PR_CONTEXT], protected: true }),
      log: (l) => lines.push(l),
      cwd: dir,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith("ok"), `line was: ${lines[0]}`);
});

// Both gates hard-fail, so both can be wrong about blocking, and one can be right
// while the other is not. The five cases are preserved per context rather than
// collapsed into a single run-wide verdict.
test("reportProtection reports one verdict per context from one pair of reads", async () => {
  const dir = withWorkflows(["pr-readiness.yml", "commit-hygiene.yml"]);
  const client = stubGh({ contexts: [PR_CONTEXT], protected: true });
  const lines = [];
  try {
    await reportProtection({ client, log: (l) => lines.push(l), cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const [required, notRequired, remediation] = lines;
  assert.ok(required.startsWith("ok"), `line was: ${required}`);
  assert.ok(required.includes(`'${PR_CONTEXT}'`));
  assert.ok(notRequired.startsWith("warn"), `line was: ${notRequired}`);
  assert.ok(notRequired.includes(`'${COMMIT_CONTEXT}'`));
  assert.ok(remediation.includes(`Requiring '${COMMIT_CONTEXT}'`));
  assert.ok(!remediation.includes(`'${PR_CONTEXT}'`));
  assert.equal(lines.length, 3);
  // Two contexts, still one default-branch read and one protection read.
  assert.deepEqual(client.reads, { branch: 1, checks: 1 });
});

// `unprotected` and `unreadable` are facts about the branch, not about a context,
// so their contexts collapse onto one line and the remediation fires once.
test("reportProtection groups a branch-wide verdict onto one line", async () => {
  for (const checks of [{}, { readable: false }]) {
    const dir = withWorkflows(["pr-readiness.yml", "commit-hygiene.yml"]);
    const lines = [];
    try {
      await reportProtection({
        client: stubGh(checks),
        log: (l) => lines.push(l),
        cwd: dir,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const drift = checks.readable === false ? 0 : 1;
    assert.equal(lines.length, 1 + drift, `lines were: ${lines.join(" | ")}`);
    assert.ok(lines[0].includes(`'${PR_CONTEXT}'`));
    assert.ok(lines[0].includes(`'${COMMIT_CONTEXT}'`));
    if (!drift) continue;
    // One remediation, naming every drifted context: requiring two checks is one
    // visit to one settings page.
    assert.ok(
      lines[1].includes(`Requiring '${PR_CONTEXT}' and '${COMMIT_CONTEXT}'`),
      `remediation was: ${lines[1]}`,
    );
  }
});

// The report keys off the workflow file, never the `scaffolds` manifest: GitHub
// reads `.github/workflows/`, so an orphaned gate runs on every PR and is exactly
// as unrequired as any other. `nextSteps` keys off the selection instead, so it
// stays silent about a scaffold this run did not install. Both are right.
test("an orphaned gate workflow gets a verdict while nextSteps stays silent", async () => {
  const dir = withWorkflows(["pr-readiness.yml", "commit-hygiene.yml"]);
  const lines = [];
  try {
    await reportProtection({
      client: stubGh({ contexts: [], protected: true }),
      log: (l) => lines.push(l),
      cwd: dir,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(lines[0].includes(`'${COMMIT_CONTEXT}'`));

  const prose = nextSteps([SCAFFOLD.QUALITY_GATES], "not-installed");
  assert.ok(prose.includes(`'${PR_CONTEXT}'`));
  assert.ok(
    !prose.includes("commit baseline in the commit-hygiene gate"),
    "nextSteps must not describe a scaffold this run did not install",
  );
});

// The commit-hygiene paragraph owes the operator what the quality-gates one
// already says: the context blocks nothing until it is required.
test("nextSteps tells each installed gate its context blocks nothing until required", () => {
  for (const id of [SCAFFOLD.QUALITY_GATES, SCAFFOLD.COMMIT_HYGIENE]) {
    const prose = nextSteps([id], "not-installed");
    const [context] = contextsFor(id).filter((c) =>
      MERGE_BLOCKING_CONTEXTS.includes(c),
    );
    assert.ok(
      prose.includes(
        `'${context}' context is a required status check on the default branch`,
      ),
      `${id}: prose was: ${prose}`,
    );
  }
});

// Both paragraphs read their context from the scaffold's vendored workflow files,
// so the only place a context string is written down stays `GATE_CONTEXT`.
test("no nextSteps paragraph carries a hardcoded context literal", () => {
  const source = readFileSync(new URL("./init.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export function nextSteps"));
  for (const context of Object.values(GATE_CONTEXT)) {
    assert.ok(
      !body.includes(`'${context}'`),
      `nextSteps must derive '${context}', not restate it`,
    );
  }
});
