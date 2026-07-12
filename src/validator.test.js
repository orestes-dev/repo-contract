import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validate,
  labelFor,
  parseSections,
  hasOverrideRationale,
  failures,
  warnings,
  checkTitle,
} from "./validator.js";
import { RULES } from "./rules.js";
import { LABEL, STATUS } from "./constants.js";
import { loadForm } from "./form.js";
import { goodBody as good } from "./fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// The template-derived structure the validator runs against.
const FIELDS = loadForm();
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
  // One check per input field, in form order, keyed by field id and labelled
  // with the field's heading, both derived from the Issue Form.
  assert.deepEqual(
    result.checks.map((c) => c.key),
    FIELDS.map((f) => f.id),
  );
  assert.deepEqual(
    result.checks.map((c) => c.label),
    FIELDS.map((f) => f.label),
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

// KNOWN LIMITATION: parseSections is not fence-aware, so a *schema* heading
// (unlike the unknown `## configure` above) inside a code block still splits the
// body. Pinned so a future fence-aware parser flips this deliberately, not by
// accident.
test("a schema heading inside a code block splits the section (known limitation)", () => {
  const body = [
    "### Context",
    "",
    "```md",
    "### Size",
    "swallowed",
    "```",
  ].join("\n");
  const sections = parseSections(body);
  assert.ok(!sections.Context.includes("swallowed"));
  assert.ok(sections.Size.includes("swallowed"));
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

// RULES and the input fields (Issue Form) must be in bijection:
// every rule maps to a real field, and every field has a rule. An orphaned rule
// (typo'd id, deleted field) or an unruled field fails CI here.
test("RULES keys are exactly the Issue Form input-field ids", () => {
  assert.deepEqual(Object.keys(RULES).sort(), FIELDS.map((f) => f.id).sort());
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
