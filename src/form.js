// Derive the issue STRUCTURE from the Issue Form at runtime: each field's id,
// label, required, type, options. `yaml` is used only here; the issue body
// itself is still parsed with plain string ops.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/**
 * One input field derived from the Issue Form, joined to a RULES entry on `id`.
 * @typedef {object} Field
 * @property {string} id - The form element id, stable across heading renames.
 * @property {string} label - The rendered `### <label>` heading.
 * @property {'input'|'textarea'|'dropdown'} type
 * @property {boolean} required
 * @property {string[]|undefined} options - Dropdown choices; undefined otherwise.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

// This action's own canonical form. The composite action runs from its own
// checkout, so structure is read from here, not the consumer's UI-only copy.
const FORM_PATH = resolve(HERE, "..", ".github", "ISSUE_TEMPLATE", "task.yml");

// Input types a submitter fills in; a `markdown` block is intro prose, not structure.
const INPUT_TYPES = new Set(["input", "textarea", "dropdown"]);

/**
 * Throw if any two fields share the same value for `key`.
 * @param {Field[]} fields
 * @param {'id'|'label'} key
 * @returns {void}
 * @throws {Error} On the first duplicate found.
 */
function assertUnique(fields, key) {
  const seen = new Set();
  for (const field of fields) {
    const value = field[key];
    if (seen.has(value))
      throw new Error(`Issue Form has duplicate ${key} "${value}".`);
    seen.add(value);
  }
}

/**
 * Parse an Issue Form into an ordered field list. Throw on an unusable form:
 * degrading to "no fields" would pass every issue unchecked.
 * @param {string} yamlText - Raw Issue Form YAML.
 * @returns {Field[]} The input fields, in form order.
 * @throws {Error} When the form has no body, no input fields, a field missing
 *   an id or label, or a duplicated field id or label.
 */
export function parseForm(yamlText) {
  const doc = parse(yamlText);
  if (!doc || !Array.isArray(doc.body)) {
    throw new Error("Issue Form has no `body` list.");
  }

  const fields = doc.body
    .filter((el) => el && INPUT_TYPES.has(el.type))
    .map((el) => {
      const label = el.attributes?.label;
      if (!el.id)
        throw new Error(`Issue Form has a ${el.type} field with no id.`);
      if (!label) throw new Error(`Issue Form field "${el.id}" has no label.`);
      return {
        id: el.id,
        label,
        type: el.type,
        required: el.validations?.required === true,
        options:
          el.type === "dropdown" ? (el.attributes?.options ?? []) : undefined,
      };
    });

  if (fields.length === 0) throw new Error("Issue Form has no input fields.");

  // Ids join to RULES and labels key section parsing; a duplicate of either
  // silently collides two fields onto one rule or one section. Fail loud.
  assertUnique(fields, "id");
  assertUnique(fields, "label");

  return fields;
}

/**
 * Parse this action's own canonical Issue Form.
 * @returns {Field[]}
 */
export function loadForm() {
  return parseForm(readFileSync(FORM_PATH, "utf8"));
}
