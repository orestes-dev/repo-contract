// `init`: scaffold the Issue Form + PR Form, the issue Author guide, and their
// thin workflows into the current repo, upgrade drifted copies in place under
// `--force`, and print the Suggested rule to stdout (written to no file).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

// `templates/` is the canonical bundle for the Issue Form and both workflows;
// this repo's `.github/` copies are a dogfood instance drift-checked to match it
// (ADR 0003). The Markdown PR Form is still sourced from `.github/` until its
// Author-guide slice folds it into the bundle too.
const TEMPLATES = [
  {
    // Consumer's copy is UI-only; the gate reads structure from its own checkout.
    from: join(ROOT, "templates", "form", "task.yml"),
    to: join(".github", "ISSUE_TEMPLATE", "task.yml"),
  },
  {
    // Issue Author guide: the LLM-facing companion to the Issue Form, dropped at
    // the consumer root under a non-reserved name GitHub ignores.
    from: join(ROOT, "templates", "markdown", "issue.md"),
    to: ".template.issue.md",
  },
  {
    from: join(ROOT, "templates", "workflow", "issue-quality.yml"),
    to: join(".github", "workflows", "issue-quality.yml"),
  },
  {
    // Markdown PR Form: both the GitHub rendering and the agent-facing one.
    from: join(ROOT, ".github", "PULL_REQUEST_TEMPLATE.md"),
    to: join(".github", "PULL_REQUEST_TEMPLATE.md"),
  },
  {
    from: join(ROOT, "templates", "workflow", "pr-quality.yml"),
    to: join(".github", "workflows", "pr-quality.yml"),
  },
];

// A destination is `absent`, byte-identical (`ok`), or `drift` (stale upstream
// or locally customized — indistinguishable without a version marker we don't
// carry, so `--force` treats both the same and git holds the receipts).
const ABSENT = "absent";
const OK = "ok";
const DRIFT = "drift";

// Agent-guidance snippet printed to stdout for the operator to paste into their
// own agent-rules file (AGENTS.md, CLAUDE.md, editor rules). `init` never writes
// it anywhere, so it cannot clobber a file it does not own. It names both Forms
// and the matching pre-flight command that catches hard errors before the object
// exists on GitHub.
const SUGGESTED_RULE = `Suggested rule (paste into AGENTS.md, CLAUDE.md, or your editor rules; init
prints this and writes it nowhere):

  When opening an issue in this repo, follow the issue Author guide
  (.template.issue.md) to fill every section, then pre-flight validate the
  drafted body before \`gh issue create\`:

      npx github:orestes-dev/quality-gate validate <body-file> --title "<title>"

  When opening a pull request, fill every required section of the PR Form
  (.github/PULL_REQUEST_TEMPLATE.md) — Summary, Verification, Divergence — then
  pre-flight validate the drafted body before \`gh pr create\`:

      npx github:orestes-dev/quality-gate validate-pr <body-file> --title "<title>"

  Fix any hard errors (the command exits 1) before creating the object.`;

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
 * Copy the Issue Form, PR Form, and their workflows into the current working
 * directory, then print the Suggested rule to stdout.
 *
 * Absent files are created. Byte-identical files are left untouched (`init` is
 * idempotent). A drifted file — stale or locally customized — makes a plain run
 * a write-nothing report that exits 1; re-run with `--force` to overwrite only
 * the files that differ. Warns (but proceeds) when not at a repo root. The
 * Suggested rule is printed on success and written to no file.
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
    "\nDone. Commit these files to opt this repo into the issue and PR quality gates.\n" +
      "The issue gate only labels issues going forward. To backfill labels + scorecards " +
      "onto the existing open backlog, run: quality-gate sweep",
  );

  console.log(`\n${SUGGESTED_RULE}`);
}
