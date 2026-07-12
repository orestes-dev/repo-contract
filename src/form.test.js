import { test } from "node:test";
import assert from "node:assert/strict";

import { parseForm, loadForm } from "./form.js";

// A minimal well-formed Issue Form: one field of each input type, so the parser
// exercises label/required/options extraction on the happy path.
const goodForm = `
name: Task
body:
  - type: markdown
    attributes:
      value: intro prose, not a field
  - type: textarea
    id: context
    attributes:
      label: Context
    validations:
      required: true
  - type: dropdown
    id: size
    attributes:
      label: Size
      options:
        - S
        - M
`;

test("parseForm returns input fields in form order, skipping markdown blocks", () => {
  const fields = parseForm(goodForm);
  assert.deepEqual(
    fields.map((f) => f.id),
    ["context", "size"],
  );
  const [context, size] = fields;
  assert.deepEqual(context, {
    id: "context",
    label: "Context",
    type: "textarea",
    required: true,
    options: undefined,
  });
  assert.deepEqual(size, {
    id: "size",
    label: "Size",
    type: "dropdown",
    required: false,
    options: ["S", "M"],
  });
});

test("parseForm throws when the document has no body list", () => {
  assert.throws(() => parseForm("name: Task"), /no `body` list/);
  assert.throws(() => parseForm(""), /no `body` list/);
  assert.throws(() => parseForm("body: not-a-list"), /no `body` list/);
});

test("parseForm throws when the body has no input fields", () => {
  const form = `
body:
  - type: markdown
    attributes:
      value: prose only
`;
  assert.throws(() => parseForm(form), /no input fields/);
});

test("parseForm throws on an input field with no id", () => {
  const form = `
body:
  - type: textarea
    attributes:
      label: Context
`;
  assert.throws(() => parseForm(form), /textarea field with no id/);
});

test("parseForm throws on an input field with no label", () => {
  const form = `
body:
  - type: textarea
    id: context
`;
  assert.throws(() => parseForm(form), /"context" has no label/);
});

test("parseForm throws on a duplicate field id", () => {
  const form = `
body:
  - type: textarea
    id: context
    attributes:
      label: Context
  - type: textarea
    id: context
    attributes:
      label: More context
`;
  assert.throws(() => parseForm(form), /duplicate id "context"/);
});

test("parseForm throws on a duplicate field label", () => {
  const form = `
body:
  - type: textarea
    id: context
    attributes:
      label: Context
  - type: textarea
    id: context-2
    attributes:
      label: Context
`;
  assert.throws(() => parseForm(form), /duplicate label "Context"/);
});

test("loadForm parses this action's own canonical Issue Form", () => {
  const fields = loadForm();
  assert.deepEqual(
    fields.map((f) => f.id),
    [
      "context",
      "acceptance-criteria",
      "out-of-scope",
      "decisions",
      "affected-files",
      "depends-on",
      "size",
    ],
  );
});
