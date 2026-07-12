import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import {
  validate,
  labelFor,
  parseSections,
  hasOverrideRationale,
  failures,
  warnings,
  checkTitle,
} from "./validator.js";
import { FIELDS, RULES } from "./rules.js";
import { LABEL, STATUS } from "./constants.js";
import { goodBody as good } from "./fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// The code-owned structure the validator runs against.
const fieldById = (id) => FIELDS.find((f) => f.id === id);

// The check for a given field key, so assertions read against one scorecard line.
const checkFor = (result, key) => result.checks.find((c) => c.key === key);

test("a complete, well-formed issue passes every check", () => {
  const result = validate(good);
  assert.deepEqual(failures(result.checks), []);
  assert.deepEqual(warnings(result.checks), []);
  assert.ok(result.checks.every((c) => c.status === STATUS.PASS));
  assert.equal(labelFor(result), LABEL.PASS);
});

test("the scorecard always carries one line per field, pass included", () => {
  const result = validate(good);
  // One check per field, in descriptor order, keyed by field id and labelled
  // with the field's heading, both from the `FIELDS` descriptor in rules.js.
  assert.deepEqual(
    result.checks.map((c) => c.key),
    FIELDS.map((f) => f.id),
  );
  assert.deepEqual(
    result.checks.map((c) => c.label),
    FIELDS.map((f) => f.heading),
  );
});

test("missing context is a hard error", () => {
  const body = [
    "### Acceptance Criteria",
    "",
    "- [ ] Input is debounced to 300ms",
    "",
    "### Out of Scope",
    "",
    "- Redesigning the search UI",
    "",
    "### Size",
    "",
    "S",
  ].join("\n");
  const result = validate(body);
  assert.equal(checkFor(result, "context").status, STATUS.FAIL);
  assert.equal(labelFor(result), LABEL.FAILING);
});

test("too-short context is a hard error", () => {
  const body = good.replace(
    "The dashboard refetches everything on every keystroke, which is slow. We want it debounced so typing stays responsive.",
    "too short",
  );
  const context = checkFor(validate(body), "context");
  assert.equal(context.status, STATUS.FAIL);
  assert.match(context.message, /too short/);
});

test("acceptance criteria without a checklist item is a hard error", () => {
  const body = good
    .replace("- [ ] Input is debounced to 300ms", "Make it fast")
    .replace("- [ ] No refetch fires until typing pauses", "somehow");
  assert.equal(
    checkFor(validate(body), "acceptance-criteria").status,
    STATUS.FAIL,
  );
});

test("checked items count toward the acceptance-criteria minimum", () => {
  const body = good
    .replace(
      "- [ ] Input is debounced to 300ms",
      "- [x] Input is debounced to 300ms",
    )
    .replace("- [ ] No refetch fires until typing pauses", "done");
  assert.equal(
    checkFor(validate(body), "acceptance-criteria").status,
    STATUS.PASS,
  );
});

test("size L blocks with a hard error", () => {
  const body = good.replace("\nS\n", "\nL\n");
  const result = validate(body);
  const size = checkFor(result, "size");
  assert.equal(size.status, STATUS.FAIL);
  assert.match(size.message, /too big/);
  assert.equal(labelFor(result), LABEL.FAILING);
});

test("an unknown size value is a hard error", () => {
  const body = good.replace("\nS\n", "\nHuge\n");
  const size = checkFor(validate(body), "size");
  assert.equal(size.status, STATUS.FAIL);
  assert.match(size.message, /must be one of/);
});

test("overlong context is a warning, not an error", () => {
  const filler = "x".repeat(1600);
  const body = good.replace(
    "The dashboard refetches everything on every keystroke, which is slow. We want it debounced so typing stays responsive.",
    filler,
  );
  const result = validate(body);
  assert.deepEqual(failures(result.checks), []);
  const context = checkFor(result, "context");
  assert.equal(context.status, STATUS.WARN);
  assert.match(context.message, /long/);
  assert.equal(labelFor(result), LABEL.WARNING);
});

test("an empty _No response_ field is treated as absent", () => {
  const body = good.replace("- Redesigning the search UI", "_No response_");
  assert.equal(checkFor(validate(body), "out-of-scope").status, STATUS.FAIL);
});

test("parseSections handles CRLF line endings", () => {
  const sections = parseSections("### Size\r\n\r\nM\r\n");
  assert.equal(sections.Size, "M");
});

test("a markdown heading inside a field does not split the section", () => {
  const body = [
    "### Context",
    "",
    "Reproduce with this snippet:",
    "",
    "```sh",
    "## configure the thing",
    "run --verbose",
    "```",
    "",
    "That is the whole repro.",
    "",
    "### Acceptance Criteria",
    "",
    "- [ ] Fix the crash",
    "",
    "### Out of Scope",
    "",
    "- Rewrites",
    "",
    "### Size",
    "",
    "S",
  ].join("\n");
  const sections = parseSections(body);
  assert.ok(sections.Context.includes("## configure the thing"));
  assert.ok(sections.Context.includes("That is the whole repro."));
  assert.equal(sections.Size, "S");
  assert.deepEqual(failures(validate(body).checks), []);
});

test("a schema heading inside a code block stays in the section (fence-aware)", () => {
  const body = ["### Context", "", "```md", "### Size", "kept", "```"].join(
    "\n",
  );
  const sections = parseSections(body);
  assert.ok(sections.Context.includes("### Size"));
  assert.ok(sections.Context.includes("kept"));
  assert.equal(sections.Size, undefined);
});

test("tilde fences and closed fences are handled", () => {
  const body = [
    "### Context",
    "",
    "~~~",
    "### Size",
    "in tilde fence",
    "~~~",
    "",
    "### Size",
    "",
    "S",
  ].join("\n");
  const sections = parseSections(body);
  assert.ok(sections.Context.includes("in tilde fence"));
  assert.equal(sections.Size, "S");
});

test("a longer closing run and a mismatched fence char do not close the fence", () => {
  const body = [
    "### Context",
    "",
    "````",
    "### Size",
    "~~~",
    "still inside the backtick fence",
    "``````",
    "",
    "### Out of Scope",
    "",
    "after the fence",
  ].join("\n");
  const sections = parseSections(body);
  assert.ok(sections.Context.includes("### Size"));
  assert.ok(sections.Context.includes("still inside the backtick fence"));
  assert.equal(sections.Size, undefined);
  assert.equal(sections["Out of Scope"], "after the fence");
});

test("checklist items count with * and + bullets and a capital [X]", () => {
  const body = good
    .replace("- [ ] Input is debounced to 300ms", "* [ ] alpha")
    .replace("### Out of Scope", "- [X] beta\n+ [x] gamma\n\n### Out of Scope");
  assert.equal(
    checkFor(validate(body), "acceptance-criteria").status,
    STATUS.PASS,
  );
});

test("hasOverrideRationale detects a non-empty h2 rationale section", () => {
  const body = [
    good,
    "",
    "## Override rationale",
    "",
    "Spike, not real work.",
  ].join("\n");
  assert.equal(hasOverrideRationale(body), true);
});

test("hasOverrideRationale is false when the section is absent", () => {
  assert.equal(hasOverrideRationale(good), false);
});

test("hasOverrideRationale is false when the section is empty", () => {
  const body = [good, "", "## Override rationale", ""].join("\n");
  assert.equal(hasOverrideRationale(body), false);
});

test("a bare `- [ ]` prefill does not count as a checklist item", () => {
  const body = good
    .replace("- [ ] Input is debounced to 300ms", "- [ ]")
    .replace("- [ ] No refetch fires until typing pauses", "");
  const result = validate(body);
  assert.equal(checkFor(result, "acceptance-criteria").status, STATUS.FAIL);
  assert.equal(labelFor(result), LABEL.FAILING);
});

test("a whitespace-only checklist item does not count", () => {
  const body = good
    .replace("- [ ] Input is debounced to 300ms", "- [ ]   ")
    .replace("- [ ] No refetch fires until typing pauses", "");
  assert.equal(
    checkFor(validate(body), "acceptance-criteria").status,
    STATUS.FAIL,
  );
});

test("a missing warn-if-empty field is a non-blocking warning", () => {
  const body = good.replace(
    "### Decisions\n\n- Debounce, not throttle: trailing-edge fetch matches user intent.\n\n",
    "",
  );
  const result = validate(body);
  assert.equal(checkFor(result, "decisions").status, STATUS.WARN);
  assert.deepEqual(failures(result.checks), []);
  assert.equal(labelFor(result), LABEL.WARNING);
});

test("a present warn-if-empty field passes", () => {
  assert.equal(checkFor(validate(good), "decisions").status, STATUS.PASS);
  assert.equal(checkFor(validate(good), "affected-files").status, STATUS.PASS);
});

test("a plain optional field is silent when absent", () => {
  // `good` never sets Depends on, so its absence must pass, not warn.
  const dependsOn = checkFor(validate(good), "depends-on");
  assert.equal(dependsOn.status, STATUS.PASS);
  assert.match(dependsOn.message, /optional/);
});

test("checkTitle passes a Conventional Commits title", () => {
  for (const title of [
    "feat: add pagination",
    "fix(search): debounce input",
    "refactor(api)!: drop the legacy field",
  ]) {
    assert.equal(checkTitle(title).status, STATUS.PASS, title);
  }
});

test("checkTitle fails a non-conventional or empty title", () => {
  for (const title of [
    "add pagination",
    "Feat: capitalised",
    "wip: nope",
    "",
  ]) {
    assert.equal(checkTitle(title).status, STATUS.FAIL, JSON.stringify(title));
  }
});

test("validate prepends a title check only when a title is given", () => {
  const withTitle = validate(good, "feat: add pagination");
  assert.equal(withTitle.checks[0].key, "title");
  assert.equal(withTitle.checks[0].status, STATUS.PASS);

  const withoutTitle = validate(good);
  assert.ok(!withoutTitle.checks.some((c) => c.key === "title"));
});

test("a bad title fails the whole issue even when the body is clean", () => {
  const result = validate(good, "no type prefix here");
  assert.equal(checkFor(result, "title").status, STATUS.FAIL);
  assert.equal(labelFor(result), LABEL.FAILING);
});

// RULES and the FIELDS descriptor must be in bijection: every rule maps to a
// real field, and every field has a rule. An orphaned rule (typo'd id, deleted
// field) or an unruled field fails CI here.
test("RULES keys are exactly the FIELDS ids", () => {
  assert.deepEqual(Object.keys(RULES).sort(), FIELDS.map((f) => f.id).sort());
});

// --- drift: task.yml is a rendering of the FIELDS descriptor ---

// Structure lives in code (`FIELDS`); the canonical `templates/form/task.yml` is
// the GitHub-UI rendering of it, read only by GitHub and this test, never at
// runtime. This pins the YAML's input fields (heading, order, required, options)
// to the descriptor so the two cannot drift apart. Its `description` prose is
// deliberately richer than the code and is not compared.
const INPUT_TYPES = new Set(["input", "textarea", "dropdown"]);

test("task.yml headings, order, required, and options match FIELDS", () => {
  const doc = parse(read("templates/form/task.yml"));
  const rendered = doc.body
    .filter((el) => el && INPUT_TYPES.has(el.type))
    .map((el) => ({
      id: el.id,
      heading: el.attributes?.label,
      type: el.type,
      required: el.validations?.required === true,
      options: el.type === "dropdown" ? el.attributes?.options : undefined,
    }));
  const expected = FIELDS.map((f) => ({
    id: f.id,
    heading: f.heading,
    type: f.type,
    required: f.required,
    options: f.options,
  }));
  assert.deepEqual(rendered, expected);
});

// --- dogfood drift: this repo's applied Issue Form equals the bundle ---

// `templates/form/task.yml` is canonical; `init` copies it verbatim into every
// consumer. This repo's own `.github/ISSUE_TEMPLATE/task.yml` is one such applied
// copy (the dogfood), so it must stay byte-identical to the bundle — else what we
// gate ourselves with silently diverges from what `init` ships. The workflows
// legitimately differ (`uses: ./` vs `@main`) and are guarded separately; the
// Issue Form is copied with no edits, so exact equality is the right check.
test("the dogfood .github Issue Form is byte-identical to the templates bundle", () => {
  assert.equal(
    read(".github/ISSUE_TEMPLATE/task.yml"),
    read("templates/form/task.yml"),
  );
});

// --- drift: the issue Author guide is a rendering of the FIELDS descriptor ---

// The issue Author guide is the LLM-facing Markdown rendering of the same
// structure: one `### <heading>` section per field, in descriptor order. Only
// its headings and order are pinned to FIELDS; its prose is deliberately richer
// than the code and the YAML, and is not compared. Match on the `### <heading>`
// at a line start so a heading name mentioned in prose can't satisfy the check.
test("the issue Author guide's section headings and order match FIELDS", () => {
  const guide = read("templates/markdown/issue.md");
  const positions = FIELDS.map((f) => guide.indexOf(`\n### ${f.heading}\n`));
  positions.forEach((pos, i) => {
    assert.ok(
      pos >= 0,
      `the guide is missing the "### ${FIELDS[i].heading}" section`,
    );
    if (i > 0) {
      assert.ok(
        pos > positions[i - 1],
        `"### ${FIELDS[i].heading}" is out of order in the guide`,
      );
    }
  });
});

// The root `.template.issue.md` is this repo's dogfood copy of the canonical
// guide `init` ships; like the Issue Form, it is copied verbatim, so it must
// stay byte-identical to the bundle or dogfooding drifts from what consumers get.
test("the dogfood root Author guide is byte-identical to the templates bundle", () => {
  assert.equal(read(".template.issue.md"), read("templates/markdown/issue.md"));
});

// The README restates the rules as the human-readable bar. That is accepted
// duplication, kept safe by this drift test. The phrasing per rule property is
// prose (can't be derived), but the values come from RULES, so coverage is by
// construction: add a ruled field and its README line becomes required here
// automatically. Only properties the README actually restates are listed; a
// property absent from a rule is skipped (e.g. Acceptance Criteria has no
// length). Size options come from the form, not RULES, so they stay separate.
const README_RULE_PHRASING = {
  minLength: (n) => `≥ ${n} chars`,
  maxLength: (n) => `≤ ${n} chars`,
  minItems: (n) => `≥ ${n} non-empty checklist item${n === 1 ? "" : "s"}`,
  blocking: (sizes) => sizes.map((s) => `\`${s}\``).join(" / "),
};

test("README restates every drift-guarded rule property, and the size options", () => {
  const readme = read("README.md");
  for (const [id, rule] of Object.entries(RULES)) {
    for (const [prop, render] of Object.entries(README_RULE_PHRASING)) {
      if (rule[prop] === undefined) continue;
      const phrase = render(rule[prop]);
      assert.ok(
        readme.includes(phrase),
        `README is missing "${phrase}" for ${id}.${prop}`,
      );
    }
  }
  assert.ok(
    readme.includes(fieldById("size").options.join(" / ")),
    "README size options drifted from the Issue Form",
  );
});
