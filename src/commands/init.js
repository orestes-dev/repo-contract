// `init`: scaffold the Issue Form + PR Form, the issue and PR Author guides,
// their thin workflows, and the vendored repo-contract git hooks into the current
// repo, activate those hooks by pointing `core.hooksPath` at them, upgrade
// drifted copies in place under `--force`, and print the Suggested rule to
// stdout (written to no file).

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GitHub } from "../github.js";
import {
  LABEL_META,
  PR_LABEL_META,
  COMMIT_LABEL_META,
  OVERRIDE_LABEL_META,
  WONTFIX_LABEL_META,
} from "../constants.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

// The fixed label schema `init` materializes and reconciles: the three gate
// triples, the three override labels, and `wontfix` (the Rejection selector),
// each with code-owned metadata (`constants.js`). `wontfix` carries GitHub's own
// default metadata, so reconciling it is a no-op in a repo that never recoloured
// it. Flattened to `{ name, color, description }` so the label step is one loop,
// mirroring the file loop above it.
export const GATE_LABELS = [
  LABEL_META,
  PR_LABEL_META,
  COMMIT_LABEL_META,
  OVERRIDE_LABEL_META,
  WONTFIX_LABEL_META,
].flatMap((meta) =>
  Object.entries(meta).map(([name, { color, description }]) => ({
    name,
    color,
    description,
  })),
);

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
// and read their opt-outs from the committed `.repo-contract.json` via jq.
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
    // policy). Vendored as a committed hook so it enforces where `~/.dotfiles`
    // is absent (CI, containers, fresh worktrees); jq/git/sh only, no
    // node_modules, so it runs before `yarn install` (ADR 0002, ADR 0012). Git
    // executes it directly via `core.hooksPath`, which is why it is written
    // executable.
    from: join(ROOT, "templates", "husky", "commit-msg"),
    to: join(".husky", "commit-msg"),
    exec: true,
  },
  {
    // Repo-contract pre-commit hook (no default-branch commits, em-dash policy
    // in staged Markdown). Same vendoring rationale as commit-msg. Repo-specific
    // checks belong in .husky/local/pre-commit, which `init` never writes.
    from: join(ROOT, "templates", "husky", "pre-commit"),
    to: join(".husky", "pre-commit"),
    exec: true,
  },
];

// A destination is `absent`, byte-identical (`ok`), or `drift` (stale upstream
// or locally customized — indistinguishable without a version marker we don't
// carry, so `--force` treats both the same and git holds the receipts).
const ABSENT = "absent";
const OK = "ok";
const DRIFT = "drift";

// Activation (ADR 0012). Vendoring a hook file only guarantees it can *run*;
// git runs it only once `core.hooksPath` points at the directory holding it.
// `init` sets that itself so a checkout that never ran a package-manager install
// (fresh clone, linked worktree, container) still enforces the baseline.
//
// The value is deliberately RELATIVE. `core.hooksPath` lives in the shared
// `.git/config`, so an absolute path pins every linked worktree to one fixed
// checkout's hooks; git resolves a relative one against the worktree root, so
// each worktree runs the hooks committed on its own branch (githooks(5): git
// chdirs to the worktree root before invoking a hook).
//
// `.husky` (not husky's generated `.husky/_` shim) is the target: the vendored
// hooks are executable POSIX sh, so git can exec them directly with no shim, no
// `node_modules`, and no install step. The directory keeps its conventional
// name; husky itself is no longer required to activate them.
export const HOOKS_PATH = ".husky";

// Git skips a hook that is not executable, emitting only a hint. Vendored hooks
// are written 0755 so activation cannot fail that quietly.
const HOOK_MODE = 0o755;

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

      npx github:orestes-dev/repo-contract --help`;

/**
 * Classify each template's destination against the bundled source by exact
 * byte comparison. Verbatim copies make equality an exact drift signal.
 * @returns {{to: string, dest: string, desired: string, exec: boolean, state: string}[]}
 */
function classify() {
  return TEMPLATES.map(({ from, to, exec = false }) => {
    const dest = resolve(process.cwd(), to);
    const desired = readFileSync(from, "utf8");
    if (!existsSync(dest)) return { to, dest, desired, exec, state: ABSENT };
    const current = readFileSync(dest, "utf8");
    return {
      to,
      dest,
      desired,
      exec,
      state: current === desired ? OK : DRIFT,
    };
  });
}

/**
 * Read `core.hooksPath` as it applies to this checkout, or `""` when unset.
 * `git config --get` exits 1 on a missing key, which is not an error here.
 * @param {string} cwd
 * @returns {string}
 */
function readHooksPath(cwd) {
  try {
    return execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Point `core.hooksPath` at the vendored hook directory, so the files `init`
 * just wrote actually run (ADR 0012). Sets the relative `.husky`, and repairs
 * any other value, including husky's `.husky/_` shim and any absolute path that
 * would make every linked worktree run one fixed checkout's hooks.
 *
 * Reports the outcome as one line, the way the file and label loops do. Outside
 * a git repository there is nothing to configure: say so loudly (the hooks are
 * inert until someone sets it) and leave the exit code alone, since scaffolding
 * into a directory before `git init` is legitimate. A `git config` that fails
 * where a repository *does* exist is fatal: silently leaving enforcement off is
 * the exact failure mode this step exists to remove.
 * @param {object} params
 * @param {string} [params.cwd]
 * @param {(line: string) => void} params.log
 * @returns {string} `skipped`, `ok`, `created`, or `repaired`.
 */
export function ensureHooksPath({ cwd = process.cwd(), log }) {
  if (!existsSync(resolve(cwd, ".git"))) {
    log(
      `skip     core.hooksPath (no git repository here). The vendored hooks will\n` +
        `         not run until you set it: git config core.hooksPath ${HOOKS_PATH}`,
    );
    return "skipped";
  }

  const current = readHooksPath(cwd);
  if (current === HOOKS_PATH) {
    log(`ok       core.hooksPath=${HOOKS_PATH}`);
    return "ok";
  }

  try {
    execFileSync("git", ["config", "core.hooksPath", HOOKS_PATH], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    console.error(
      `\nerror: could not set core.hooksPath to ${HOOKS_PATH} (${error instanceof Error ? error.message : String(error)}).\n` +
        "The vendored hooks are on disk but git will not run them, so the commit " +
        "baseline is NOT enforced in this checkout. Fix the git config, or run " +
        `\`git config core.hooksPath ${HOOKS_PATH}\` by hand, and re-run init.`,
    );
    process.exit(1);
  }

  if (current === "") {
    log(`create   core.hooksPath=${HOOKS_PATH}`);
    return "created";
  }
  const why = isAbsolute(current)
    ? "absolute, so every linked worktree ran this one checkout's hooks"
    : "did not point at the vendored hooks";
  log(`repair   core.hooksPath=${HOOKS_PATH} (was '${current}': ${why})`);
  return "repaired";
}

/**
 * Run a `gh` CLI command, returning trimmed stdout or `null` on any failure
 * (gh absent, not authenticated, not in a repo). Unlike `sweep`'s `gh`, this
 * never exits: the label step degrades to skipped so `init` stays usable with no
 * credentials or repo context.
 * @param {string[]} args - Arguments passed to `gh`.
 * @returns {string|null} Trimmed stdout, or null if the command failed.
 */
function ghOrNull(args) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Discover credentials and repo context the way `sweep` does, but softly: return
 * a `GitHub` client, or `null` when either the token or the repo is unavailable
 * (so the label step reports skipped rather than failing the run). The token
 * comes from `GITHUB_TOKEN` when set, else `gh auth token`.
 * @returns {GitHub|null}
 */
function resolveLabelClient() {
  const token = process.env.GITHUB_TOKEN || ghOrNull(["auth", "token"]);
  const repoJson = ghOrNull(["repo", "view", "--json", "owner,name"]);
  if (!token || !repoJson) return null;
  const { owner, name } = JSON.parse(repoJson);
  return new GitHub({
    token,
    apiUrl: process.env.GITHUB_API_URL,
    owner: owner.login,
    repo: name,
  });
}

/**
 * Create or repair every label in the fixed schema, reporting per label the same
 * way the file loop reports per file (created / repaired / ok). With no client
 * (no credentials or repo context), report a single skipped line and return: the
 * file scaffolding above has already succeeded and the exit code is unchanged.
 * @param {object} params
 * @param {GitHub|null} params.client - The API client, or null to skip.
 * @param {(line: string) => void} params.log
 * @returns {Promise<void>}
 */
export async function ensureGateLabels({ client, log }) {
  if (!client) {
    log("skip     labels (no GitHub credentials or repo context)");
    return;
  }
  for (const { name, color, description } of GATE_LABELS) {
    const state = await client.ensureLabel(name, color, description);
    log(`${state.padEnd(9)}${name}`);
  }
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
 *
 * After the files, activate them: each vendored hook is written executable and
 * `core.hooksPath` is set to the relative `.husky`, repairing any other value
 * (ADR 0012). That is what makes a checkout which never ran a package-manager
 * install enforce the baseline, and what keeps a linked worktree on the hooks
 * committed to its own branch.
 *
 * Then reconcile the fixed label schema (the three gate triples, the three
 * override labels, and `wontfix`): create any missing label, repair any whose
 * color/description drifted. This needs credentials and repo context, discovered
 * the way `sweep` does (`gh auth token`, `gh repo view`); with neither the label
 * step is reported as skipped and the file scaffolding still stands.
 * @param {string[]} [argv] - Remaining CLI args; `--force` upgrades in place.
 * @returns {Promise<void>}
 */
export async function init(argv = []) {
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

  for (const { to, dest, desired, exec, state } of entries) {
    if (state !== OK) {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, desired);
    }
    // Mode is not part of the byte comparison, so re-assert it even on `ok`:
    // git silently skips (hints about) a hook it cannot execute, and a copy
    // that lost its executable bit would disable enforcement without a word.
    if (exec) chmodSync(dest, HOOK_MODE);
    console.log(
      `${state === OK ? "ok    " : state === ABSENT ? "create" : "update"} ${to}`,
    );
  }

  console.log("\nActivation:");
  const activation = ensureHooksPath({ log: (line) => console.log(line) });

  console.log("\nLabels:");
  await ensureGateLabels({
    client: resolveLabelClient(),
    log: (line) => console.log(line),
  });

  // The hook paragraph reports what actually happened: claiming the hooks are
  // live where activation was skipped would restate the bug this step fixes.
  const hooksNote =
    activation === "skipped"
      ? `The git hooks are NOT active: there is no git repository here yet. Run \`git init\` and ` +
        `then \`git config core.hooksPath ${HOOKS_PATH}\` (or re-run this command).\n`
      : `The git hooks are live in this checkout now (core.hooksPath=${HOOKS_PATH}, a relative value, ` +
        "so each linked worktree runs the hooks committed on its own branch).\n";

  console.log(
    `\nDone. Commit these files to opt this repo into the issue quality and PR readiness gates.\n` +
      hooksNote +
      "core.hooksPath is per-clone git config, never committed: run this command once in every " +
      "fresh clone or worktree, or the hooks sit on disk unread. CI keeps the un-bypassable copy " +
      "of the same rules in the commit-hygiene gate.\n" +
      "The issue gate only labels issues going forward. To backfill labels + scorecards " +
      "onto the existing open backlog, run: repo-contract sweep",
  );

  console.log(`\n${SUGGESTED_RULE}`);
}
