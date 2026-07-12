// `init`: scaffold the Issue Form + thin workflow into the current repo, and
// upgrade drifted copies in place under `--force`.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const TEMPLATES = [
  {
    // Consumer's copy is UI-only; the gate reads structure from its own checkout.
    from: join(ROOT, ".github", "ISSUE_TEMPLATE", "task.yml"),
    to: join(".github", "ISSUE_TEMPLATE", "task.yml"),
  },
  {
    from: join(ROOT, "templates", "workflow.yml"),
    to: join(".github", "workflows", "issue-quality.yml"),
  },
];

// A destination is `absent`, byte-identical (`ok`), or `drift` (stale upstream
// or locally customized — indistinguishable without a version marker we don't
// carry, so `--force` treats both the same and git holds the receipts).
const ABSENT = "absent";
const OK = "ok";
const DRIFT = "drift";

/**
 * Classify each template's destination against the bundled source by exact
 * byte comparison. Verbatim copies make equality an exact drift signal.
 * @returns {{to: string, dest: string, desired: string, state: string}[]}
 */
function classify() {
  return TEMPLATES.map(({ from, to }) => {
    const dest = resolve(process.cwd(), to);
    const desired = readFileSync(from, "utf8");
    if (!existsSync(dest)) return { to, dest, desired, state: ABSENT };
    const current = readFileSync(dest, "utf8");
    return { to, dest, desired, state: current === desired ? OK : DRIFT };
  });
}

/**
 * Copy the Issue Form and workflow into the current working directory.
 *
 * Absent files are created. Byte-identical files are left untouched (`init` is
 * idempotent). A drifted file — stale or locally customized — makes a plain run
 * a write-nothing report that exits 1; re-run with `--force` to overwrite only
 * the files that differ. Warns (but proceeds) when not at a repo root.
 * @param {string[]} [argv] - Remaining CLI args; `--force` upgrades in place.
 * @returns {void}
 */
export function init(argv = []) {
  const force = argv.includes("--force");

  // Soft guard: `.github/` is only read at the repo root. Warn but proceed;
  // scaffolding into a fresh dir before `git init` is legitimate.
  if (!existsSync(resolve(process.cwd(), ".git"))) {
    console.warn(
      "warning: no .git in the current directory. GitHub only reads .github/ " +
        "from the repository root; run this there or the workflow will not run.",
    );
  }

  const entries = classify();
  const drifted = entries.filter((e) => e.state === DRIFT);

  // Atomic: any drift makes a plain run read-only. Report the full picture and
  // exit 1 rather than half-migrate the repo, so the exit code is unambiguous.
  if (!force && drifted.length > 0) {
    /** @type {Record<string, string>} */
    const reportLabel = { [ABSENT]: "missing", [OK]: "ok", [DRIFT]: "stale" };
    for (const { to, state } of entries) {
      console.log(`${reportLabel[state].padEnd(7)}${to}`);
    }
    console.error(
      `\n${drifted.length} file(s) differ from the current templates. Nothing was written.\n` +
        "Re-run with --force to overwrite them. These files are committed to git, " +
        "so `git diff` afterwards shows exactly what changed and lets you restore any " +
        "local edits the upgrade clobbered.",
    );
    process.exit(1);
  }

  for (const { to, dest, desired, state } of entries) {
    if (state === OK) {
      console.log(`ok     ${to}`);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, desired);
    console.log(`${state === ABSENT ? "create" : "update"} ${to}`);
  }

  console.log(
    "\nDone. Commit both files to opt this repo into the issue quality gate.\n" +
      "The gate only labels issues going forward. To backfill labels + scorecards " +
      "onto the existing open backlog, run: issue-quality-gate sweep",
  );
}
