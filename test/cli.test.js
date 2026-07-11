import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'cli.js');

// Run `cli.js init` with cwd set to `dir` and return the captured result.
function runInit(dir) {
  return spawnSync(process.execPath, [CLI, 'init'], {
    cwd: dir,
    encoding: 'utf8',
  });
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'iqg-init-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('init warns and still scaffolds when cwd is not a git root', () => {
  withTempDir((dir) => {
    const { status, stderr } = runInit(dir);
    assert.equal(status, 0);
    assert.match(stderr, /no \.git in the current directory/);
    assert.ok(existsSync(join(dir, '.github', 'ISSUE_TEMPLATE', 'task.yml')));
    assert.ok(existsSync(join(dir, '.github', 'workflows', 'issue-quality.yml')));
  });
});

test('init does not warn when a .git entry is present', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.git'));
    const { status, stderr } = runInit(dir);
    assert.equal(status, 0);
    assert.doesNotMatch(stderr, /no \.git/);
  });
});
