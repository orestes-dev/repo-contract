import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sweep, buildQuery } from './sweep.js';
import { LABEL } from './schema.js';

const goodBody = [
  '### Context',
  '',
  'The dashboard refetches everything on every keystroke, which is slow. We want it debounced so typing stays responsive.',
  '',
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

const failingBody = goodBody.replace('### Size', '### Size\n\nL\n');

// A GitHub stub covering both the search entry point and the per-issue writes
// `run()` performs. `issues` maps number -> { body, labels }; `search` is what
// searchIssues returns. `throwOn` forces getIssue to throw for one number so a
// single failing issue can be exercised without derailing the rest.
function fakeGh({ issues, search, throwOn }) {
  const calls = [];
  return {
    calls,
    async searchIssues() {
      return search;
    },
    async getIssue(number) {
      if (number === throwOn) throw new Error('boom');
      return { number, ...issues[number] };
    },
    async ensureLabel() {},
    async addLabels(number, labels) {
      calls.push(['addLabels', number, labels]);
    },
    async removeLabel(number, label) {
      calls.push(['removeLabel', number, label]);
    },
    async findComment() {
      return null;
    },
    async createComment(number) {
      calls.push(['createComment', number]);
    },
    async updateComment() {},
    async deleteComment() {},
  };
}

test('buildQuery scopes to open issues, excludes PRs, and negates every quality label', () => {
  const q = buildQuery();
  assert.ok(q.includes('is:issue'), 'excludes pull requests');
  assert.ok(q.includes('is:open'), 'open issues only');
  for (const label of [LABEL.FAILING, LABEL.WARNING, LABEL.PASS]) {
    assert.ok(q.includes(`-label:"${label}"`), `negates ${label}`);
  }
});

test('sweep labels each matched issue by its validated outcome', async () => {
  const gh = fakeGh({
    issues: {
      1: { body: goodBody, labels: [] },
      2: { body: failingBody, labels: [] },
    },
    search: { totalCount: 2, items: [{ number: 1 }, { number: 2 }] },
  });
  const result = await sweep({ gh });
  assert.equal(result.swept, 2);
  assert.deepEqual(result.failed, []);
  assert.equal(result.capped, false);
  assert.ok(
    gh.calls.some((c) => c[0] === 'addLabels' && c[1] === 1 && c[2].includes(LABEL.PASS)),
  );
  assert.ok(
    gh.calls.some((c) => c[0] === 'addLabels' && c[1] === 2 && c[2].includes(LABEL.FAILING)),
  );
});

test('sweep continues past a failing issue and reports it', async () => {
  const gh = fakeGh({
    issues: { 1: { body: goodBody, labels: [] }, 3: { body: goodBody, labels: [] } },
    search: { totalCount: 3, items: [{ number: 1 }, { number: 2 }, { number: 3 }] },
    throwOn: 2,
  });
  const result = await sweep({ gh });
  assert.equal(result.swept, 2);
  assert.deepEqual(result.failed, [2]);
  assert.ok(
    gh.calls.some((c) => c[0] === 'addLabels' && c[1] === 3),
    'issues after the failure are still processed',
  );
});

test('sweep flags a capped result when more issues match than were fetched', async () => {
  const gh = fakeGh({
    issues: { 1: { body: goodBody, labels: [] } },
    search: { totalCount: 1500, items: [{ number: 1 }] },
  });
  const result = await sweep({ gh });
  assert.equal(result.capped, true);
});

test('sweep passes the running summary to its log callback', async () => {
  const lines = [];
  const gh = fakeGh({
    issues: { 1: { body: goodBody, labels: [] } },
    search: { totalCount: 1, items: [{ number: 1 }] },
  });
  await sweep({ gh, log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => /issue #1: passing/.test(l)));
});
