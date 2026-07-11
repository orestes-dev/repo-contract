import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validate,
  labelFor,
  parseSections,
  hasOverrideRationale,
  failures,
  warnings,
} from './validator.js';
import { LABEL, FIELD, STATUS } from './schema.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// The check for a given field key, so assertions read against one scorecard line.
const checkFor = (result, key) => result.checks.find((c) => c.key === key);

const good = [
  '### Context',
  '',
  'The dashboard refetches everything on every keystroke, which is slow. We want it debounced so typing stays responsive.',
  '',
  '### Acceptance Criteria',
  '',
  '- [ ] Input is debounced to 300ms',
  '- [ ] No refetch fires until typing pauses',
  '',
  '### Out of Scope',
  '',
  '- Redesigning the search UI',
  '',
  '### Size',
  '',
  'S',
  '',
].join('\n');

test('a complete, well-formed issue passes every check', () => {
  const result = validate(good);
  assert.deepEqual(failures(result.checks), []);
  assert.deepEqual(warnings(result.checks), []);
  assert.ok(result.checks.every((c) => c.status === STATUS.PASS));
  assert.equal(result.size, 'S');
  assert.equal(labelFor(result), LABEL.PASS);
});

test('the scorecard always carries one line per field, pass included', () => {
  const result = validate(good);
  assert.deepEqual(
    result.checks.map((c) => c.key),
    ['context', 'acceptance-criteria', 'out-of-scope', 'size'],
  );
  assert.deepEqual(
    result.checks.map((c) => c.label),
    [FIELD.CONTEXT, FIELD.ACCEPTANCE_CRITERIA, FIELD.OUT_OF_SCOPE, FIELD.SIZE],
  );
});

test('missing context is a hard error', () => {
  const body = [
    '### Acceptance Criteria',
    '',
    '- [ ] Input is debounced to 300ms',
    '',
    '### Out of Scope',
    '',
    '- Redesigning the search UI',
    '',
    '### Size',
    '',
    'S',
  ].join('\n');
  const result = validate(body);
  assert.equal(checkFor(result, 'context').status, STATUS.FAIL);
  assert.equal(labelFor(result), LABEL.FAILING);
});

test('too-short context is a hard error', () => {
  const body = good.replace(
    'The dashboard refetches everything on every keystroke, which is slow. We want it debounced so typing stays responsive.',
    'too short',
  );
  const context = checkFor(validate(body), 'context');
  assert.equal(context.status, STATUS.FAIL);
  assert.match(context.message, /too short/);
});

test('acceptance criteria without a checklist item is a hard error', () => {
  const body = good
    .replace('- [ ] Input is debounced to 300ms', 'Make it fast')
    .replace('- [ ] No refetch fires until typing pauses', 'somehow');
  assert.equal(checkFor(validate(body), 'acceptance-criteria').status, STATUS.FAIL);
});

test('checked items count toward the acceptance-criteria minimum', () => {
  const body = good
    .replace('- [ ] Input is debounced to 300ms', '- [x] Input is debounced to 300ms')
    .replace('- [ ] No refetch fires until typing pauses', 'done');
  assert.equal(checkFor(validate(body), 'acceptance-criteria').status, STATUS.PASS);
});

test('size L blocks with a hard error', () => {
  const body = good.replace('\nS\n', '\nL\n');
  const result = validate(body);
  const size = checkFor(result, 'size');
  assert.equal(size.status, STATUS.FAIL);
  assert.match(size.message, /too big/);
  assert.equal(labelFor(result), LABEL.FAILING);
});

test('an unknown size value is a hard error', () => {
  const body = good.replace('\nS\n', '\nHuge\n');
  const size = checkFor(validate(body), 'size');
  assert.equal(size.status, STATUS.FAIL);
  assert.match(size.message, /must be one of/);
});

test('overlong context is a warning, not an error', () => {
  const filler = 'x'.repeat(1600);
  const body = good.replace(
    'The dashboard refetches everything on every keystroke, which is slow. We want it debounced so typing stays responsive.',
    filler,
  );
  const result = validate(body);
  assert.deepEqual(failures(result.checks), []);
  const context = checkFor(result, 'context');
  assert.equal(context.status, STATUS.WARN);
  assert.match(context.message, /long/);
  assert.equal(labelFor(result), LABEL.WARNING);
});

test('an empty _No response_ field is treated as absent', () => {
  const body = good.replace('- Redesigning the search UI', '_No response_');
  assert.equal(checkFor(validate(body), 'out-of-scope').status, STATUS.FAIL);
});

test('parseSections handles CRLF line endings', () => {
  const sections = parseSections('### Size\r\n\r\nM\r\n');
  assert.equal(sections.Size, 'M');
});

test('a markdown heading inside a field does not split the section', () => {
  const body = [
    '### Context',
    '',
    'Reproduce with this snippet:',
    '',
    '```sh',
    '## configure the thing',
    'run --verbose',
    '```',
    '',
    'That is the whole repro.',
    '',
    '### Acceptance Criteria',
    '',
    '- [ ] Fix the crash',
    '',
    '### Out of Scope',
    '',
    '- Rewrites',
    '',
    '### Size',
    '',
    'S',
  ].join('\n');
  const sections = parseSections(body);
  assert.ok(sections.Context.includes('## configure the thing'));
  assert.ok(sections.Context.includes('That is the whole repro.'));
  assert.equal(sections.Size, 'S');
  assert.deepEqual(failures(validate(body).checks), []);
});

// KNOWN LIMITATION: parseSections is not fence-aware, so a *schema* heading
// (unlike the unknown `## configure` above) inside a code block still splits the
// body. Pinned so a future fence-aware parser flips this deliberately, not by
// accident.
test('a schema heading inside a code block splits the section (known limitation)', () => {
  const body = [
    '### Context',
    '',
    '```md',
    '### Size',
    'swallowed',
    '```',
  ].join('\n');
  const sections = parseSections(body);
  assert.ok(!sections.Context.includes('swallowed'));
  assert.ok(sections.Size.includes('swallowed'));
});

test('checklist items count with * and + bullets and a capital [X]', () => {
  const body = good
    .replace('- [ ] Input is debounced to 300ms', '* [ ] alpha')
    .replace('### Out of Scope', '- [X] beta\n+ [x] gamma\n\n### Out of Scope');
  assert.equal(checkFor(validate(body), 'acceptance-criteria').status, STATUS.PASS);
});

test('hasOverrideRationale detects a non-empty h2 rationale section', () => {
  const body = [good, '', '## Override rationale', '', 'Spike, not real work.'].join('\n');
  assert.equal(hasOverrideRationale(body), true);
});

test('hasOverrideRationale is false when the section is absent', () => {
  assert.equal(hasOverrideRationale(good), false);
});

test('hasOverrideRationale is false when the section is empty', () => {
  const body = [good, '', '## Override rationale', ''].join('\n');
  assert.equal(hasOverrideRationale(body), false);
});

test('a bare `- [ ]` prefill does not count as a checklist item', () => {
  const body = good
    .replace('- [ ] Input is debounced to 300ms', '- [ ]')
    .replace('- [ ] No refetch fires until typing pauses', '');
  const result = validate(body);
  assert.equal(checkFor(result, 'acceptance-criteria').status, STATUS.FAIL);
  assert.equal(labelFor(result), LABEL.FAILING);
});

test('a whitespace-only checklist item does not count', () => {
  const body = good
    .replace('- [ ] Input is debounced to 300ms', '- [ ]   ')
    .replace('- [ ] No refetch fires until typing pauses', '');
  assert.equal(checkFor(validate(body), 'acceptance-criteria').status, STATUS.FAIL);
});

// The FIELD headings the validator parses are the Issue Form's element labels,
// which GitHub renders as `### <label>`. Renaming a form label without updating
// FIELD silently breaks parsing; guard the coupling.
test('every FIELD heading exists as a label in the Issue Form template', () => {
  const raw = read('templates/issue-form.yml');
  for (const heading of Object.values(FIELD)) {
    assert.ok(
      raw.includes(`label: ${heading}`),
      `templates/issue-form.yml is missing "label: ${heading}"`,
    );
  }
});

// The committed dogfood form is the scaffolded template applied to this repo;
// keep the two byte-for-byte identical so the repo gates itself on the same
// schema it ships.
test('the dogfood Issue Form matches the scaffolded template', () => {
  assert.equal(
    read('.github/ISSUE_TEMPLATE/task.yml'),
    read('templates/issue-form.yml'),
    'dogfood form drifted from templates/issue-form.yml',
  );
});
