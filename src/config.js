// Reader for the committed, repo-root `.repo-contract.json` (CONFIG_FILENAME):
// the durable, reviewable home for enforcement opt-outs that used to live in
// per-machine `git config hooks.*` (ADR 0002, orestes/dotfiles#52). Each opt-out
// carries a machine-readable `reason` as a data field, not a comment, so a
// consuming hook can quote it in its failure message. Parsing is `JSON.parse`
// (no added parser dependency) and the file stays `jq`-queryable.
//
// This module is the opt-out lookup the shipped hook wrappers consume; the hooks
// themselves ship separately. Absent config means full enforcement with no
// opt-outs, so a repo that never wrote the file behaves exactly as before.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CONFIG_FILENAME } from "./constants.js";

/**
 * A single enforcement opt-out: the value the hook keys off, plus the required
 * reason it exists, quoted verbatim into the hook's output when it triggers.
 * @typedef {object} Override
 * @property {unknown} value - The opt-out value (e.g. `true`, or an em-dash budget).
 * @property {string} reason - Why this opt-out exists; non-empty, surfaced on trigger.
 */

/**
 * The parsed config. `overrides` maps an opt-out key to its Override. An empty
 * map (the default when the file is absent) means full enforcement.
 * @typedef {object} Config
 * @property {Record<string, Override>} overrides
 */

/** The config a repo with no `.repo-contract.json` behaves as: full enforcement. */
const emptyConfig = () => ({ overrides: {} });

/**
 * Whether `x` is a plain (non-null, non-array) object.
 * @param {unknown} x
 * @returns {x is Record<string, unknown>}
 */
const isObject = (x) =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Validate one opt-out entry, throwing a message that names the offending key so
 * the author knows which entry to fix. A missing or empty `reason` is an error:
 * the whole point of the file is that every bypass carries a durable rationale.
 * @param {string} source - The file the entry came from, for the error message.
 * @param {string} key - The opt-out key.
 * @param {unknown} entry - The raw entry to validate.
 * @returns {Override}
 */
function validateOverride(source, key, entry) {
  if (!isObject(entry)) {
    throw new Error(
      `${source}: overrides.${key} must be an object with "value" and "reason".`,
    );
  }
  if (!("value" in entry)) {
    throw new Error(`${source}: overrides.${key} is missing "value".`);
  }
  const { reason } = entry;
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new Error(
      `${source}: overrides.${key} is missing a non-empty "reason". ` +
        "Every opt-out must record why it exists.",
    );
  }
  return { value: entry.value, reason };
}

/**
 * Parse and validate raw config text into a Config. Separated from file IO so it
 * is testable without touching disk. Throws on invalid JSON, a non-object root,
 * a non-object `overrides`, or any opt-out missing a `value` or a non-empty
 * `reason`. The `source` names the origin in every error message.
 * @param {string} raw - The config file contents.
 * @param {string} [source] - Label for error messages (defaults to the filename).
 * @returns {Config}
 */
export function parseConfig(raw, source = CONFIG_FILENAME) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${source}: invalid JSON: ${message}`, { cause: err });
  }
  if (!isObject(data)) {
    throw new Error(`${source}: must be a JSON object.`);
  }
  const rawOverrides = data.overrides ?? {};
  if (!isObject(rawOverrides)) {
    throw new Error(`${source}: "overrides" must be an object.`);
  }
  /** @type {Record<string, Override>} */
  const overrides = {};
  for (const [key, entry] of Object.entries(rawOverrides)) {
    overrides[key] = validateOverride(source, key, entry);
  }
  return { overrides };
}

/**
 * Load `.repo-contract.json` from `cwd`. An absent file is not an error: it
 * returns the empty config (full enforcement). Any other read error, or an
 * invalid file, propagates.
 * @param {string} [cwd] - Repo root to read from (defaults to `process.cwd()`).
 * @returns {Config}
 */
export function loadConfig(cwd = process.cwd()) {
  const path = resolve(cwd, CONFIG_FILENAME);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return emptyConfig();
    }
    throw err;
  }
  return parseConfig(raw, CONFIG_FILENAME);
}

/**
 * Look up an enforcement opt-out by key. Returns the Override (value + reason)
 * when the repo opted out of that check, or `undefined` for full enforcement of
 * it. A consumer branches on the return: `undefined` enforces; an Override
 * relaxes and quotes `reason` (see {@link formatOverride}).
 * @param {Config} config
 * @param {string} key - The opt-out key (e.g. `maxAllowedEmDashes`).
 * @returns {Override | undefined}
 */
export function getOverride(config, key) {
  return config.overrides[key];
}

/**
 * Render a triggered opt-out for a hook's output, quoting its reason verbatim so
 * the bypass is legible where it takes effect (e.g. the em-dash budget message
 * naming the file that consumed it). Callers embed this in their own wording.
 * @param {string} key - The opt-out key.
 * @param {Override} override
 * @returns {string}
 */
export function formatOverride(key, override) {
  return `${key} opt-out from ${CONFIG_FILENAME} (${JSON.stringify(override.value)}): ${override.reason}`;
}
