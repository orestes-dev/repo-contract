// `init`: scaffold the Issue Form + PR Form, the issue and PR Author guides,
// their thin workflows, and the vendored repo-contract git hooks into the current
// repo, upgrade drifted copies in place under `--force`, and print the Suggested
// rule to stdout (written to no file).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

// `templates/` is the canonical bundle for the Forms, workflows, and repo-contract
// git hooks; this repo's `.github/` copies, root `.template.*.md` guides, and
// `.husky/` hooks are a dogfood instance drift-checked to match it (ADR 0003,
// ADR 0002). Every destination is a verbatim byte-for-byte copy of its source,
// which is what makes exact equality a precise drift signal. The canonical
// Markdown PR Form is `templates/markdown/pr.md`; `init` writes it byte-for-byte
// to both the GitHub-rendered `.github/PULL_REQUEST_TEMPLATE.md` and the
// agent-facing root `.template.pr.md`. Because the two are identical bytes, PR
// authoring guidance stays in HTML comments so it never prints into the posted
// PR body (ADR 0003). The git hooks are shipped all-in (no per-feature selection)
// and read their opt-outs from the committed `.quality-gate.json` via jq.
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
    // Markdown PR Form, GitHub rendering: GitHub posts it as the PR body.
    from: join(ROOT, "templates", "markdown", "pr.md"),
    to: join(".github", "PULL_REQUEST_TEMPLATE.md"),
  },
  {
    // PR Author guide: the same bytes at the consumer root under a non-reserved
    // name GitHub ignores, the path the Suggested rule points agents at.
    from: join(ROOT, "templates", "markdown", "pr.md"),
    to: ".template.pr.md",
  },
  {
    from: join(ROOT, "templates", "workflow", "pr-readiness.yml"),
    to: join(".github", "workflows", "pr-readiness.yml"),
  },
  {
    // Commit hygiene gate: the CI mirror of the repo-contract baseline. No new
    // Form or guide; it reads the PR's commits and diff, not a body the author
    // fills in.
    from: join(ROOT, "templates", "workflow", "commit-hygiene.yml"),
    to: join(".github", "workflows", "commit-hygiene.yml"),
  },
  {
    // Repo-contract commit-msg hook (Conventional Commits subject, em-dash
    // policy). Vendored as a committed husky hook so it enforces where
    // `~/.dotfiles` is absent (CI, containers, fresh worktrees); jq/git/sh only,
    // no node_modules, so it runs before `yarn install` (ADR 0002).
    from: join(ROOT, "templates", "husky", "commit-msg"),
    to: join(".husky", "commit-msg"),
  },
  {
    // Repo-contract pre-commit hook (no default-branch commits, em-dash policy
    // in staged Markdown). Same vendoring rationale as commit-msg. Repo-specific
    // checks belong in .husky/local/pre-commit, which `init` never writes.
    from: join(ROOT, "templates", "husky", "pre-commit"),
    to: join(".husky", "pre-commit"),
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
// it anywhere, so it cannot clobber a file it does not own.
//
// Deliberately names no subcommand, flag, or exit code: a pasted copy is beyond
// this repo's reach forever after, so anything it pins about the CLI surface
// rots silently the next time that surface moves. Name only what `init` itself
// writes and drift-checks (the Author guides) plus the package, which is the
// discovery entrypoint. `--help` is generated from the live CLI and cannot go
// stale.
const SUGGESTED_RULE = `Suggested rule (paste into AGENTS.md, CLAUDE.md, or your editor rules; init
prints this and writes it nowhere):

  When opening an issue in this repo, follow the issue Author guide
  (.template.issue.md) to fill every section. When opening a pull request,
  follow the PR Author guide (.template.pr.md) the same way.

  Pre-flight validate the drafted body before \`gh issue create\` /
  \`gh pr create\`, and fix any hard errors before creating the object. Run the
  CLI's help to discover the command for each:

      npx github:orestes-dev/quality-gate --help`;

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
 * Copy the Issue Form, PR Form, their workflows, and the repo-contract git hooks
 * into the current working directory, then print the Suggested rule to stdout.
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
    "\nDone. Commit these files to opt this repo into the issue quality and PR readiness gates.\n" +
      "The issue gate only labels issues going forward. To backfill labels + scorecards " +
      "onto the existing open backlog, run: quality-gate sweep",
  );

  console.log(`\n${SUGGESTED_RULE}`);
}
