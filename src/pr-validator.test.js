import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { run } from "./action.js";
import { validatePr, PR_SECTIONS, DIVERGENCE_FLAG } from "./pr-validator.js";
import { renderComment, PR_PRESENTATION } from "./report.js";
import {
  PR_LABEL,
  PR_OVERRIDE_LABEL,
  OVERRIDE_HEADING,
  STATUS,
} from "./constants.js";
import { prGate } from "./gates/pr.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// A well-formed PR body: both required sections present and non-empty.
const goodBody = [
  "## Summary",
  "",
  "Debounce the search input so typing stays responsive.",
  "",
  "## Verification",
  "",
  "`yarn test` green; manually typed in the search box and watched the network tab.",
  "",
].join("\n");

// Drops the required Verification section.
const missingVerification = ["## Summary", "", "Debounce the search.", ""].join(
  "\n",
);

const goodTitle = "feat: debounce the search input";

// A GitHub client stub that records every mutating call. Reads (getPullRequest,
// findComment) are not recorded; only writes are.
function fakeGh({ pr, comments = [] }) {
  const calls = [];
  return {
    calls,
    async getPullRequest() {
      return pr;
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
const gate = prGate;

// --- validatePr unit checks ---

test("validatePr passes a body with both required sections and a good title", () => {
  const { checks } = validatePr(goodBody, goodTitle);
  assert.equal(worst(checks), STATUS.PASS);
});

test("validatePr fails when a required section is missing", () => {
  const { checks } = validatePr(missingVerification, goodTitle);
  const verification = checks.find((c) => c.label === "Verification");
  assert.equal(verification.status, STATUS.FAIL);
  assert.equal(worst(checks), STATUS.FAIL);
});

test("validatePr fails a non-Conventional-Commits title", () => {
  const { checks } = validatePr(goodBody, "just some words");
  const title = checks.find((c) => c.key === "title");
  assert.equal(title.status, STATUS.FAIL);
});

test("validatePr passes Divergence when the flag is unchecked", () => {
  const { checks } = validatePr(goodBody, goodTitle);
  const divergence = checks.find((c) => c.label === "Divergence");
  assert.equal(divergence.status, STATUS.PASS);
  assert.equal(worst(checks), STATUS.PASS);
});

// A Divergence section with the flag checked but no rationale beyond it.
const flaggedNoRationale = [
  goodBody,
  "## Divergence",
  "",
  `- [x] ${DIVERGENCE_FLAG}`,
  "",
  "<!-- explain the divergence here -->",
  "",
].join("\n");

// The same, with a written rationale under the checked flag.
const flaggedWithRationale = [
  goodBody,
  "## Divergence",
  "",
  `- [x] ${DIVERGENCE_FLAG}`,
  "",
  "Dropped the caching layer the issue asked for; profiling showed it was noise.",
  "",
].join("\n");

// The flag left unchecked, with the template guidance still in place.
const flagUnchecked = [
  goodBody,
  "## Divergence",
  "",
  `- [ ] ${DIVERGENCE_FLAG}`,
  "",
  "<!-- explain the divergence here -->",
  "",
].join("\n");

test("validatePr fails when the Divergence flag is checked but no rationale is written", () => {
  const { checks } = validatePr(flaggedNoRationale, goodTitle);
  const divergence = checks.find((c) => c.label === "Divergence");
  assert.equal(divergence.status, STATUS.FAIL);
  assert.equal(worst(checks), STATUS.FAIL);
});

test("validatePr passes when the Divergence flag is checked and a rationale is written", () => {
  const { checks } = validatePr(flaggedWithRationale, goodTitle);
  const divergence = checks.find((c) => c.label === "Divergence");
  assert.equal(divergence.status, STATUS.PASS);
  assert.equal(worst(checks), STATUS.PASS);
});

test("validatePr passes an unchecked Divergence flag with only guidance left", () => {
  const { checks } = validatePr(flagUnchecked, goodTitle);
  const divergence = checks.find((c) => c.label === "Divergence");
  assert.equal(divergence.status, STATUS.PASS);
  assert.equal(worst(checks), STATUS.PASS);
});

// --- run() over the PR gate: pass / fail / override / bot ---

test("a clean PR gets the pass label and a scorecard comment", async () => {
  const gh = fakeGh({
    pr: {
      number: 42,
      title: goodTitle,
      body: goodBody,
      labels: [],
      author: "octocat",
    },
    comments: [],
  });
  const { summary, status } = await run({ gh, event, gate });
  assert.equal(status, STATUS.PASS);
  assert.match(summary, /passing/);
  assert.ok(
    gh.calls.some((c) => c[0] === "addLabels" && c[2].includes(PR_LABEL.PASS)),
  );
  const created = gh.calls.find((c) => c[0] === "createComment");
  assert.ok(created, "expected a scorecard comment");
  assert.ok(created[2].includes("PR Quality Checklist"));
});

test("a PR missing a required section gets the failing label and status", async () => {
  const gh = fakeGh({
    pr: {
      number: 42,
      title: goodTitle,
      body: missingVerification,
      labels: [],
      author: "octocat",
    },
    comments: [],
  });
  const { status } = await run({ gh, event, gate });
  assert.equal(status, STATUS.FAIL);
  assert.ok(
    gh.calls.some(
      (c) => c[0] === "addLabels" && c[2].includes(PR_LABEL.FAILING),
    ),
  );
});

test("override with rationale strips the quality label and keeps an annotated scorecard", async () => {
  const body = [
    missingVerification,
    "",
    `## ${OVERRIDE_HEADING}`,
    "",
    "Trivial docs fix, sections do not apply.",
  ].join("\n");
  const gh = fakeGh({
    pr: {
      number: 42,
      title: goodTitle,
      body,
      labels: [{ name: PR_OVERRIDE_LABEL }, { name: PR_LABEL.FAILING }],
      author: "octocat",
    },
    comments: [
      {
        id: 1,
        user: { type: "Bot" },
        body: renderComment(validatePr(missingVerification, goodTitle), {
          presentation: PR_PRESENTATION,
        }),
      },
    ],
  });
  const { summary, status } = await run({ gh, event, gate });
  assert.equal(status, STATUS.PASS);
  assert.match(summary, /overridden/);
  assert.ok(
    gh.calls.some((c) => c[0] === "removeLabel" && c[2] === PR_LABEL.FAILING),
  );
  const updated = gh.calls.find((c) => c[0] === "updateComment");
  assert.ok(updated, "expected the scorecard to be updated, not removed");
  assert.ok(updated[2].includes("Gate overridden"));
  assert.ok(updated[2].includes("PR Quality Checklist"));
});

test("a bot-authored PR auto-passes without an override, even with a bad body", async () => {
  const gh = fakeGh({
    pr: {
      number: 42,
      title: "chore: bump deps",
      body: missingVerification,
      labels: [],
      author: "dependabot[bot]",
    },
    comments: [],
  });
  const { summary, status } = await run({ gh, event, gate });
  assert.equal(status, STATUS.PASS);
  assert.match(summary, /exempt/);
  assert.ok(
    gh.calls.some((c) => c[0] === "addLabels" && c[2].includes(PR_LABEL.PASS)),
  );
  assert.ok(
    !gh.calls.some(
      (c) => c[0] === "addLabels" && c[2].includes(PR_LABEL.FAILING),
    ),
  );
  const created = gh.calls.find((c) => c[0] === "createComment");
  assert.ok(created, "expected a scorecard comment for the exempt PR");
  assert.ok(created[2].includes("gate exempt"));
});

// --- drift: the Markdown template is pinned to the PR_SECTIONS descriptor ---

// PR structure is defined in code (`PR_SECTIONS`); the Markdown template is a
// rendering of it. This test pins the template's headings, their order, and the
// per-section required flag (surfaced as the word "Required." in the guidance)
// to the descriptor, so the two cannot drift apart.
test("PULL_REQUEST_TEMPLATE.md headings and required flags match PR_SECTIONS", () => {
  const template = read(".github/PULL_REQUEST_TEMPLATE.md");
  const headings = PR_SECTIONS.map((s) => `## ${s.heading}`);
  const positions = headings.map((h) => template.indexOf(h));
  positions.forEach((pos, i) => {
    assert.ok(pos >= 0, `template is missing the ${headings[i]} heading`);
    if (i > 0) {
      assert.ok(
        pos > positions[i - 1],
        `${headings[i]} is out of order in the template`,
      );
    }
  });

  const sections = splitByHeadings(template, PR_SECTIONS);
  for (const s of PR_SECTIONS) {
    assert.equal(
      sections[s.heading].includes("Required."),
      s.required,
      `${s.heading} required flag drifted from the template guidance`,
    );
    if (s.flag) {
      assert.ok(
        sections[s.heading].includes(`- [ ] ${s.flag}`),
        `${s.heading} flag checkbox drifted from the template`,
      );
    }
  }
});

// --- drift: the PR workflows stay coupled to the schema strings and each other ---

const PR_QUALITY_PREFIX = PR_LABEL.FAILING.slice(
  0,
  PR_LABEL.FAILING.indexOf(":") + 1,
);
const GATE_SENDER = "github-actions[bot]";

test("both PR workflows couple the trigger filter to the schema strings", () => {
  for (const rel of [
    "templates/pr-workflow.yml",
    ".github/workflows/pr-quality.yml",
  ]) {
    const yaml = read(rel);
    assert.ok(
      yaml.includes(`github.event.label.name == '${PR_OVERRIDE_LABEL}'`),
      `${rel} is missing the override-label trigger guard`,
    );
    assert.ok(
      yaml.includes(
        `startsWith(github.event.label.name, '${PR_QUALITY_PREFIX}')`,
      ),
      `${rel} is missing the quality-label self-heal guard`,
    );
    assert.ok(
      yaml.includes(`github.event.sender.login != '${GATE_SENDER}'`),
      `${rel} is missing the human-sender guard`,
    );
  }
});

test("the two PR workflows agree on trigger, permissions, concurrency, and filter", () => {
  const consumer = parse(read("templates/pr-workflow.yml"));
  const dogfood = parse(read(".github/workflows/pr-quality.yml"));

  assert.deepEqual(
    consumer.on.pull_request.types,
    dogfood.on.pull_request.types,
  );

  // Both write PRs and read contents; the reusable action's checkout and the
  // dogfood's `uses: ./` both need contents: read.
  assert.equal(consumer.permissions["pull-requests"], "write");
  assert.equal(dogfood.permissions["pull-requests"], "write");
  assert.equal(consumer.permissions.contents, "read");
  assert.equal(dogfood.permissions.contents, "read");

  assert.deepEqual(consumer.concurrency, dogfood.concurrency);
  assert.equal(
    consumer.jobs["quality-gate"].if,
    dogfood.jobs["quality-gate"].if,
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

/**
 * Split a markdown body into a { heading: content } map on the descriptor's
 * section headings, so the drift test can inspect each section's guidance.
 * @param {string} text
 * @param {import('./pr-validator.js').PrSection[]} descriptor
 * @returns {Record<string, string>}
 */
function splitByHeadings(text, descriptor) {
  const headings = descriptor.map((s) => s.heading);
  const sections = {};
  let current = null;
  let buffer = [];
  const flush = () => {
    if (current !== null) sections[current] = buffer.join("\n");
  };
  for (const line of text.split("\n")) {
    const matched = headings.find((h) => line.trim() === `## ${h}`);
    if (matched !== undefined) {
      flush();
      current = matched;
      buffer = [];
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  flush();
  return sections;
}
