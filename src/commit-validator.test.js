import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { run } from "./action.js";
import { validateCommits } from "./commit-validator.js";
import { renderComment, COMMIT_PRESENTATION } from "./report.js";
import {
  COMMIT_LABEL,
  COMMIT_OVERRIDE_LABEL,
  OVERRIDE_HEADING,
  STATUS,
  OPT_OUT,
} from "./constants.js";
import { commitGate } from "./gates/commit.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// A literal em dash, spelled as an escape so this test file never carries the
// character the gate forbids in Markdown diffs.
const EM = "\u2014";

// The empty config a repo with no `.repo-contract.json` behaves as: full
// enforcement, no opt-outs.
const noConfig = { overrides: {} };

// Build a config with a single opt-out entry.
const withOptOut = (key, value, reason = "documented reason") => ({
  overrides: { [key]: { value, reason } },
});

const conventionalCommits = [
  { sha: "aaaaaaa1", subject: "feat(search): debounce the query input" },
  { sha: "bbbbbbb2", subject: "test(search): cover the debounce" },
];

const cleanArgs = {
  commits: conventionalCommits,
  files: [{ filename: "src/search.js", patch: "+const x = 1;" }],
  headRef: "feat/debounce",
  defaultBranch: "main",
  config: noConfig,
};

const byKey = (checks, key) => checks.find((c) => c.key === key);

// --- validateCommits: Conventional Commits subjects ---

test("validateCommits passes when every commit subject is conventional", () => {
  const { checks } = validateCommits(cleanArgs);
  assert.equal(worst(checks), STATUS.PASS);
  assert.equal(byKey(checks, "commit-subjects").status, STATUS.PASS);
});

test("validateCommits fails on a non-conventional commit subject, naming it", () => {
  const { checks } = validateCommits({
    ...cleanArgs,
    commits: [
      conventionalCommits[0],
      { sha: "ccccccc3", subject: "wip: messing about" },
    ],
  });
  const subjects = byKey(checks, "commit-subjects");
  assert.equal(subjects.status, STATUS.FAIL);
  assert.match(subjects.message, /ccccccc/);
  assert.match(subjects.message, /messing about/);
  assert.doesNotMatch(subjects.message, /debounce the query/);
  assert.equal(worst(checks), STATUS.FAIL);
});

test("validateCommits exempts merge, revert, fixup, and squash subjects", () => {
  const { checks } = validateCommits({
    ...cleanArgs,
    commits: [
      { sha: "d1", subject: "Merge branch 'main' into feat/x" },
      { sha: "d2", subject: 'Revert "feat: oops"' },
      { sha: "d3", subject: "fixup! feat: earlier" },
      { sha: "d4", subject: "squash! feat: earlier" },
    ],
  });
  assert.equal(byKey(checks, "commit-subjects").status, STATUS.PASS);
});

test("skipConventionalCommits opt-out passes the subject check and quotes the reason", () => {
  const { checks } = validateCommits({
    ...cleanArgs,
    commits: [{ sha: "e1", subject: "not conventional at all" }],
    config: withOptOut(OPT_OUT.CONVENTIONAL, true, "legacy import branch"),
  });
  const subjects = byKey(checks, "commit-subjects");
  assert.equal(subjects.status, STATUS.PASS);
  assert.match(subjects.message, /legacy import branch/);
});

// --- validateCommits: em dashes in the diff ---

test("validateCommits fails when an em dash is added to a *.md line", () => {
  const { checks } = validateCommits({
    ...cleanArgs,
    files: [
      { filename: "README.md", patch: `+A sentence ${EM} with an em dash.` },
    ],
  });
  const emDash = byKey(checks, "em-dashes");
  assert.equal(emDash.status, STATUS.FAIL);
  assert.match(emDash.message, /max allowed: 0/);
  assert.equal(worst(checks), STATUS.FAIL);
});

test("validateCommits ignores em dashes on non-added lines and in non-markdown files", () => {
  const { checks } = validateCommits({
    ...cleanArgs,
    files: [
      // Context and removed lines are not additions.
      {
        filename: "README.md",
        patch: ` A kept line ${EM} here\n-removed ${EM}`,
      },
      // Non-markdown: not governed by the rule.
      { filename: "src/x.js", patch: `+const s = "${EM}";` },
    ],
  });
  assert.equal(byKey(checks, "em-dashes").status, STATUS.PASS);
});

test("maxAllowedEmDashes budget passes at or below the budget, fails above it", () => {
  const twoDashes = {
    ...cleanArgs,
    files: [{ filename: "README.md", patch: `+first ${EM} and second ${EM}` }],
  };
  const atBudget = validateCommits({
    ...twoDashes,
    config: withOptOut(OPT_OUT.EM_DASH_BUDGET, 2, "generated table"),
  });
  assert.equal(byKey(atBudget.checks, "em-dashes").status, STATUS.PASS);
  assert.match(byKey(atBudget.checks, "em-dashes").message, /generated table/);

  const overBudget = validateCommits({
    ...twoDashes,
    config: withOptOut(OPT_OUT.EM_DASH_BUDGET, 1, "generated table"),
  });
  assert.equal(byKey(overBudget.checks, "em-dashes").status, STATUS.FAIL);
});

test("allowEmDashes opt-out passes the em-dash check entirely and quotes the reason", () => {
  const { checks } = validateCommits({
    ...cleanArgs,
    files: [
      { filename: "README.md", patch: `+lots ${EM}${EM}${EM} of dashes` },
    ],
    config: withOptOut(OPT_OUT.EM_DASH, true, "prose repo, em dashes welcome"),
  });
  const emDash = byKey(checks, "em-dashes");
  assert.equal(emDash.status, STATUS.PASS);
  assert.match(emDash.message, /prose repo/);
});

test("a file with no patch (binary or truncated) does not crash the em-dash check", () => {
  const { checks } = validateCommits({
    ...cleanArgs,
    files: [{ filename: "docs/diagram.md", patch: "" }],
  });
  assert.equal(byKey(checks, "em-dashes").status, STATUS.PASS);
});

// --- validateCommits: default branch ---

test("validateCommits fails when the head branch is the default branch", () => {
  const { checks } = validateCommits({
    ...cleanArgs,
    headRef: "main",
    defaultBranch: "main",
  });
  const branch = byKey(checks, "default-branch");
  assert.equal(branch.status, STATUS.FAIL);
  assert.match(branch.message, /'main'/);
  assert.equal(worst(checks), STATUS.FAIL);
});

test("allowDefaultBranchCommits opt-out passes the default-branch check", () => {
  const { checks } = validateCommits({
    ...cleanArgs,
    headRef: "main",
    defaultBranch: "main",
    config: withOptOut(OPT_OUT.DEFAULT_BRANCH, true, "release automation"),
  });
  const branch = byKey(checks, "default-branch");
  assert.equal(branch.status, STATUS.PASS);
  assert.match(branch.message, /release automation/);
});

test("a missing head or default branch name passes rather than false-failing", () => {
  const { checks } = validateCommits({
    ...cleanArgs,
    headRef: "",
    defaultBranch: "",
  });
  assert.equal(byKey(checks, "default-branch").status, STATUS.PASS);
});

// --- run() over the commit gate: pass / fail / override / bot ---

// A GitHub client stub recording every mutating call. Reads are not recorded.
function fakeGh({ pr, commits, files, comments = [] }) {
  const calls = [];
  return {
    calls,
    async getPullRequest() {
      return pr;
    },
    async getPullRequestCommits() {
      return commits;
    },
    async getPullRequestFiles() {
      return files;
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

const event = { pull_request: { number: 42 } };
const gate = commitGate;

const cleanPr = {
  number: 42,
  body: "## Summary\n\nClean.",
  labels: [],
  author: "octocat",
  headRef: "feat/debounce",
  defaultBranch: "main",
};

test("a clean PR gets the commit-hygiene pass label and a scorecard comment", async () => {
  const gh = fakeGh({
    pr: cleanPr,
    commits: conventionalCommits,
    files: [{ filename: "src/search.js", patch: "+const x = 1;" }],
  });
  const { summary, status } = await run({ gh, event, gate });
  assert.equal(status, STATUS.PASS);
  assert.match(summary, /passing/);
  assert.ok(
    gh.calls.some(
      (c) => c[0] === "addLabels" && c[2].includes(COMMIT_LABEL.PASS),
    ),
  );
  const created = gh.calls.find((c) => c[0] === "createComment");
  assert.ok(created, "expected a scorecard comment");
  assert.ok(created[2].includes("Commit Hygiene Checklist"));
});

test("a PR with a non-conventional commit gets the failing label and status", async () => {
  const gh = fakeGh({
    pr: cleanPr,
    commits: [{ sha: "f1", subject: "wip whatever" }],
    files: [{ filename: "src/x.js", patch: "+x" }],
  });
  const { status } = await run({ gh, event, gate });
  assert.equal(status, STATUS.FAIL);
  assert.ok(
    gh.calls.some(
      (c) => c[0] === "addLabels" && c[2].includes(COMMIT_LABEL.FAILING),
    ),
  );
});

test("override with rationale strips the commit-hygiene label and keeps an annotated scorecard", async () => {
  const body = [
    "## Summary\n\nOverride me.",
    "",
    `## ${OVERRIDE_HEADING}`,
    "",
    "Importing an upstream branch with legacy commit subjects.",
  ].join("\n");
  const failingScorecard = validateCommits({
    commits: [{ sha: "f1", subject: "wip whatever" }],
    files: [],
    headRef: "feat/x",
    defaultBranch: "main",
    config: noConfig,
  });
  const gh = fakeGh({
    pr: {
      ...cleanPr,
      body,
      labels: [{ name: COMMIT_OVERRIDE_LABEL }, { name: COMMIT_LABEL.FAILING }],
    },
    commits: [{ sha: "f1", subject: "wip whatever" }],
    files: [],
    comments: [
      {
        id: 1,
        user: { type: "Bot" },
        body: renderComment(failingScorecard, {
          presentation: COMMIT_PRESENTATION,
        }),
      },
    ],
  });
  const { summary, status } = await run({ gh, event, gate });
  assert.equal(status, STATUS.PASS);
  assert.match(summary, /overridden/);
  assert.ok(
    gh.calls.some(
      (c) => c[0] === "removeLabel" && c[2] === COMMIT_LABEL.FAILING,
    ),
  );
  const updated = gh.calls.find((c) => c[0] === "updateComment");
  assert.ok(updated, "expected the scorecard to be updated, not removed");
  assert.ok(updated[2].includes("Gate overridden"));
  assert.ok(updated[2].includes("Commit Hygiene Checklist"));
});

test("the override label alone, with no rationale section, does not bypass", async () => {
  const gh = fakeGh({
    pr: {
      ...cleanPr,
      body: "## Summary\n\nNo rationale here.",
      labels: [{ name: COMMIT_OVERRIDE_LABEL }],
    },
    commits: [{ sha: "f1", subject: "wip whatever" }],
    files: [],
  });
  const { status } = await run({ gh, event, gate });
  assert.equal(status, STATUS.FAIL);
  // Still labelled failing, and the scorecard nudges about the missing section.
  assert.ok(
    gh.calls.some(
      (c) => c[0] === "addLabels" && c[2].includes(COMMIT_LABEL.FAILING),
    ),
  );
  const created = gh.calls.find((c) => c[0] === "createComment");
  assert.ok(created[2].includes(OVERRIDE_HEADING));
});

test("a rationale section alone, with no override label, does not bypass", async () => {
  const body = [
    "## Summary\n\nRationale but no label.",
    "",
    `## ${OVERRIDE_HEADING}`,
    "",
    "I wrote a reason but forgot the label.",
  ].join("\n");
  const gh = fakeGh({
    pr: { ...cleanPr, body, labels: [] },
    commits: [{ sha: "f1", subject: "wip whatever" }],
    files: [],
  });
  const { status } = await run({ gh, event, gate });
  assert.equal(status, STATUS.FAIL);
  assert.ok(
    gh.calls.some(
      (c) => c[0] === "addLabels" && c[2].includes(COMMIT_LABEL.FAILING),
    ),
  );
});

test("a bot-authored PR auto-passes without an override, even with bad commits", async () => {
  const gh = fakeGh({
    pr: {
      ...cleanPr,
      author: "dependabot[bot]",
      labels: [],
    },
    commits: [{ sha: "f1", subject: "bump lodash from 1 to 2" }],
    files: [{ filename: "README.md", patch: `+em ${EM} dash` }],
  });
  const { summary, status } = await run({ gh, event, gate });
  assert.equal(status, STATUS.PASS);
  assert.match(summary, /exempt/);
  assert.ok(
    gh.calls.some(
      (c) => c[0] === "addLabels" && c[2].includes(COMMIT_LABEL.PASS),
    ),
  );
  assert.ok(
    !gh.calls.some(
      (c) => c[0] === "addLabels" && c[2].includes(COMMIT_LABEL.FAILING),
    ),
  );
  const created = gh.calls.find((c) => c[0] === "createComment");
  assert.ok(created[2].includes("gate exempt"));
});

// --- drift: the commit-hygiene workflows stay coupled to the schema strings ---

const COMMIT_PREFIX = COMMIT_LABEL.FAILING.slice(
  0,
  COMMIT_LABEL.FAILING.indexOf(":") + 1,
);
const GATE_SENDER = "github-actions[bot]";

test("both commit-hygiene workflows couple the trigger filter to the schema strings", () => {
  for (const rel of [
    "templates/workflow/commit-hygiene.yml",
    ".github/workflows/commit-hygiene.yml",
  ]) {
    const yaml = read(rel);
    assert.ok(
      yaml.includes(`github.event.label.name == '${COMMIT_OVERRIDE_LABEL}'`),
      `${rel} is missing the override-label trigger guard`,
    );
    assert.ok(
      yaml.includes(`startsWith(github.event.label.name, '${COMMIT_PREFIX}')`),
      `${rel} is missing the commit-hygiene-label self-heal guard`,
    );
    assert.ok(
      yaml.includes(`github.event.sender.login != '${GATE_SENDER}'`),
      `${rel} is missing the human-sender guard`,
    );
    assert.ok(
      yaml.includes("synchronize"),
      `${rel} must re-run on new pushes (synchronize)`,
    );
  }
});

test("the two commit-hygiene workflows agree on trigger, permissions, concurrency, and filter", () => {
  const consumer = parse(read("templates/workflow/commit-hygiene.yml"));
  const dogfood = parse(read(".github/workflows/commit-hygiene.yml"));

  assert.deepEqual(
    consumer.on.pull_request.types,
    dogfood.on.pull_request.types,
  );
  assert.equal(consumer.permissions["pull-requests"], "write");
  assert.equal(dogfood.permissions["pull-requests"], "write");
  assert.equal(consumer.permissions.contents, "read");
  assert.equal(dogfood.permissions.contents, "read");
  assert.deepEqual(consumer.concurrency, dogfood.concurrency);
  assert.equal(
    consumer.jobs["repo-contract"].if,
    dogfood.jobs["repo-contract"].if,
  );
});

/**
 * Worst status across checks: fail beats warn beats pass.
 * @param {import('./validator.js').Check[]} checks
 * @returns {'pass'|'warn'|'fail'}
 */
function worst(checks) {
  if (checks.some((c) => c.status === STATUS.FAIL)) return STATUS.FAIL;
  if (checks.some((c) => c.status === STATUS.WARN)) return STATUS.WARN;
  return STATUS.PASS;
}
