import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseConfig,
  loadConfig,
  getOverride,
  formatOverride,
} from "./config.js";
import { CONFIG_FILENAME } from "./constants.js";

// A scratch repo root with an optional `.repo-contract.json`, auto-cleaned.
function withRepo(contents) {
  const dir = mkdtempSync(join(tmpdir(), "qg-config-"));
  if (contents !== undefined) {
    writeFileSync(join(dir, CONFIG_FILENAME), contents);
  }
  return dir;
}

// The shape the issue and README document, as it lands on disk.
const EXAMPLE = JSON.stringify({
  overrides: {
    maxAllowedEmDashes: {
      value: 34,
      reason: "AGENTS.md is generated and contains 33",
    },
    allowDefaultBranchCommits: {
      value: true,
      reason: "policy: direct commits to main are fine here",
    },
  },
});

test("the documented example parses and preserves values and reasons", () => {
  const config = parseConfig(EXAMPLE);
  assert.deepEqual(config.overrides.maxAllowedEmDashes, {
    value: 34,
    reason: "AGENTS.md is generated and contains 33",
  });
  assert.equal(config.overrides.allowDefaultBranchCommits.value, true);
});

test("the config is plain JSON, so JSON.parse and jq see the same tree", () => {
  // No custom parser: the reader's output equals a raw JSON.parse of the file,
  // which is exactly what `jq` queries.
  const config = parseConfig(EXAMPLE);
  const raw = JSON.parse(EXAMPLE);
  assert.equal(
    getOverride(config, "maxAllowedEmDashes").value,
    raw.overrides.maxAllowedEmDashes.value,
  );
});

test("an absent config means full enforcement with no opt-outs", () => {
  const dir = withRepo(undefined);
  try {
    const config = loadConfig(dir);
    assert.deepEqual(config.overrides, {});
    assert.equal(getOverride(config, "maxAllowedEmDashes"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig reads and validates a committed file", () => {
  const dir = withRepo(EXAMPLE);
  try {
    const config = loadConfig(dir);
    assert.equal(config.overrides.allowDefaultBranchCommits.value, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing reason is an error naming the offending key", () => {
  const raw = JSON.stringify({ overrides: { allowEmDashes: { value: true } } });
  assert.throws(() => parseConfig(raw), /overrides\.allowEmDashes.*reason/s);
});

test("an empty or whitespace-only reason is an error", () => {
  for (const reason of ["", "   "]) {
    const raw = JSON.stringify({
      overrides: { allowEmDashes: { value: true, reason } },
    });
    assert.throws(() => parseConfig(raw), /reason/);
  }
});

test("a non-string reason is an error", () => {
  const raw = JSON.stringify({
    overrides: { allowEmDashes: { value: true, reason: 42 } },
  });
  assert.throws(() => parseConfig(raw), /reason/);
});

test("an opt-out missing its value is an error", () => {
  const raw = JSON.stringify({
    overrides: { allowEmDashes: { reason: "because" } },
  });
  assert.throws(() => parseConfig(raw), /overrides\.allowEmDashes.*value/s);
});

test("a non-object opt-out entry is an error", () => {
  const raw = JSON.stringify({ overrides: { allowEmDashes: true } });
  assert.throws(() => parseConfig(raw), /overrides\.allowEmDashes/);
});

test("a non-object overrides is an error", () => {
  const raw = JSON.stringify({ overrides: [] });
  assert.throws(() => parseConfig(raw), /"overrides" must be an object/);
});

test("a non-object root is an error", () => {
  assert.throws(() => parseConfig("[]"), /must be a JSON object/);
  assert.throws(() => parseConfig("42"), /must be a JSON object/);
});

test("invalid JSON is an error that names the file", () => {
  assert.throws(() => parseConfig("{ not json"), /invalid JSON/);
});

test("overrides defaults to empty when the key is omitted", () => {
  const config = parseConfig(JSON.stringify({}));
  assert.deepEqual(config.overrides, {});
});

test("getOverride returns the override when set and undefined otherwise", () => {
  const config = parseConfig(EXAMPLE);
  assert.equal(getOverride(config, "maxAllowedEmDashes").value, 34);
  assert.equal(getOverride(config, "neverConfigured"), undefined);
});

test("formatOverride quotes the reason verbatim for a hook to surface", () => {
  const config = parseConfig(EXAMPLE);
  const line = formatOverride(
    "maxAllowedEmDashes",
    getOverride(config, "maxAllowedEmDashes"),
  );
  assert.ok(line.includes("AGENTS.md is generated and contains 33"));
  assert.ok(line.includes("maxAllowedEmDashes"));
  assert.ok(line.includes(CONFIG_FILENAME));
});
