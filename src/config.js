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

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { CONFIG_FILENAME, SCAFFOLD_IDS, SCAFFOLDS_KEY } from "./constants.js";

/**
 * A single enforcement opt-out: the value the hook keys off, plus the required
 * reason it exists, quoted verbatim into the hook's output when it triggers.
 * @typedef {object} Override
 * @property {unknown} value - The opt-out value (e.g. `true`, or an em-dash budget).
 * @property {string} reason - Why this opt-out exists; non-empty, surfaced on trigger.
 */

/**
 * The parsed config. `overrides` maps an opt-out key to its Override; an empty
 * map (the default when the file is absent) means full enforcement. `scaffolds`
 * is the install manifest: an authoritative whitelist of installed scaffolds,
 * empty when the key is absent, which means NONE installed rather than all-in
 * (ADR 0016).
 * @typedef {object} Config
 * @property {Record<string, Override>} overrides
 * @property {string[]} scaffolds
 */

/**
 * The config a repo with no `.repo-contract.json` behaves as: full enforcement,
 * nothing recorded as installed.
 */
const emptyConfig = () => ({ overrides: {}, scaffolds: [] });

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
 * Validate the `scaffolds` install manifest, throwing on anything that is not a
 * duplicate-free, non-empty list of known scaffold ids. Every surface that reads
 * the file validates it, so a hand-edited typo red-fails loudly — including the
 * commit-hygiene gate. That is deliberate (ADR 0016): read as "not installed", an
 * unrecognized id would let a later `init --only` drop a live scaffold without the
 * never-deselect refusal ever firing.
 *
 * An absent key is the empty manifest (none installed). A literal `[]` is an
 * error rather than a synonym for it, so "nothing installed" keeps exactly one
 * representation on disk; `uninstall`ing the last scaffold removes the key.
 * @param {string} source - The file the manifest came from, for the error message.
 * @param {unknown} raw - The raw value of the `scaffolds` key.
 * @returns {string[]}
 */
function validateScaffolds(source, raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `${source}: "${SCAFFOLDS_KEY}" must be an array of scaffold ids (${SCAFFOLD_IDS.join(", ")}).`,
    );
  }
  if (raw.length === 0) {
    throw new Error(
      `${source}: "${SCAFFOLDS_KEY}" is empty. Remove the key entirely to record ` +
        "that no scaffold is installed; an empty array is not a second way to say it.",
    );
  }
  const seen = new Set();
  for (const id of raw) {
    if (typeof id !== "string" || !SCAFFOLD_IDS.includes(id)) {
      throw new Error(
        `${source}: "${SCAFFOLDS_KEY}" contains an unknown scaffold ${JSON.stringify(id)}. ` +
          `Known scaffolds: ${SCAFFOLD_IDS.join(", ")}.`,
      );
    }
    if (seen.has(id)) {
      throw new Error(
        `${source}: "${SCAFFOLDS_KEY}" lists ${JSON.stringify(id)} more than once.`,
      );
    }
    seen.add(id);
  }
  return sortScaffolds(raw);
}

/**
 * Order a selection the way `SCAFFOLD_IDS` does, so the manifest on disk reads
 * the same regardless of the order a `--only` flag or a prompt produced it in and
 * a re-run never rewrites the file just to reshuffle it.
 * @param {string[]} ids
 * @returns {string[]}
 */
export function sortScaffolds(ids) {
  return SCAFFOLD_IDS.filter((id) => ids.includes(id));
}

/**
 * Parse and validate raw config text into a Config. Separated from file IO so it
 * is testable without touching disk. Throws on invalid JSON, a non-object root,
 * a non-object `overrides`, any opt-out missing a `value` or a non-empty
 * `reason`, or a `scaffolds` manifest that is not a duplicate-free, non-empty
 * list of known ids. The `source` names the origin in every error message.
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
  return {
    overrides,
    scaffolds: validateScaffolds(source, data[SCAFFOLDS_KEY]),
  };
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
 * Rewrite the `scaffolds` manifest in `.repo-contract.json`, creating the file
 * when it is absent and leaving every other key (notably `overrides`) exactly as
 * it was. The manifest is authoritative and rewritten on every `init` run, not
 * merged into, which is what keeps it a record of what is installed rather than
 * an accumulating wish list.
 *
 * Writing an empty selection is a programming error, not a config the file can
 * hold: `[]` is never a valid manifest, so callers refuse an empty selection
 * before reaching here (ADR 0016).
 * @param {string[]} ids - The scaffolds now installed; must be non-empty.
 * @param {string} [cwd] - Repo root to write to (defaults to `process.cwd()`).
 * @returns {void}
 */
export function writeScaffolds(ids, cwd = process.cwd()) {
  if (ids.length === 0) {
    throw new Error(
      `Refusing to write an empty "${SCAFFOLDS_KEY}" to ${CONFIG_FILENAME}.`,
    );
  }
  const path = resolve(cwd, CONFIG_FILENAME);
  let data = {};
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
      throw err;
    }
  }
  // Two-space indent and a trailing newline: the shape Prettier and `jq` both
  // emit, so a consumer that formats its repo sees no diff churn from `init`.
  writeFileSync(
    path,
    `${JSON.stringify({ ...data, [SCAFFOLDS_KEY]: sortScaffolds(ids) }, null, 2)}\n`,
  );
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
