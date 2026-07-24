// `init`: install a selected subset of repo-contract's three scaffolds into the
// current repo — the quality gates (both Forms, both Author guides, both
// workflows), the commit-hygiene gate, and the vendored git hooks — activate the
// hooks by pointing `core.hooksPath` at them where they were selected, upgrade
// drifted copies in place under `--force`, record what is now installed in
// `.repo-contract.json`, and print the Suggested rule to stdout (written to no
// file).
//
// The selection comes from `selection.js` (`--only` -> prompt -> record ->
// all-in) and the per-scaffold manifest from `scaffolds.js`. `init` only ever
// adds: teardown is the separate `uninstall` command's job (ADR 0016).

import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

import { GitHub } from "../github.js";
import { checkProtection, isDrift } from "../protection.js";
import { CONFIG_FILENAME, SCAFFOLD, SCAFFOLD_IDS } from "../constants.js";
import { filesFor, labelsFor, scaffold } from "../scaffolds.js";
import { loadConfig, writeScaffolds } from "../config.js";
import { resolveSelection } from "../selection.js";
import {
  canPrompt,
  promptForScaffolds,
  promptForOverwriteHooksPath,
} from "../prompt.js";
import {
  HOOKS_PATH,
  readHooksPath,
  foreignHooksPath,
  ensureHooksPath,
} from "../hook-activation.js";

// The opt-in flag that lets `init` adopt a foreign local `core.hooksPath`
// (ADR 0020). Deliberately distinct from `--force`: `--force` overwrites
// drifted *committed* files, whose safety rests on git holding the receipts,
// while a local `core.hooksPath` is uncommitted and unrecoverable, so adopting
// one is a separate, explicitly-named force.
const OVERWRITE_HOOKS_FLAG = "--overwrite-hooks-path";

// A destination is `absent`, byte-identical (`ok`), or `drift` (stale upstream
// or locally customized — indistinguishable without a version marker we don't
// carry, so `--force` treats both the same and git holds the receipts).
const ABSENT = "absent";
const OK = "ok";
const DRIFT = "drift";

// Git skips a hook that is not executable, emitting only a hint. Vendored hooks
// are written 0755 so activation cannot fail that quietly. HOOKS_PATH and the
// `core.hooksPath` reader/writer now live in `../hook-activation.js`, shared with
// `uninstall` rather than reached across command modules.
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
 * Classify a selection's destinations against their bundled sources by exact byte
 * comparison. Verbatim copies make equality an exact drift signal.
 *
 * Per-scaffold, so an unselected scaffold's files are neither classified nor
 * reported here: they are neither installed nor missing, and only a *selected*
 * scaffold's drift blocks the atomic read-only run (ADR 0016). Files on disk that
 * no selected scaffold claims are orphans, found by {@link findOrphans}.
 * @param {string[]} ids - The scaffolds being installed.
 * @returns {{to: string, dest: string, desired: string, exec: boolean, state: string}[]}
 */
function classify(ids) {
  return filesFor(ids).map(({ from, to, exec = false }) => {
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
 * Create or repair every label the selection needs, reporting per label the same
 * way the file loop reports per file (created / repaired / ok). With no client
 * (no credentials or repo context), report a single skipped line and return: the
 * file scaffolding above has already succeeded and the exit code is unchanged.
 *
 * The schema follows the selection, not the package: a repo that installed only
 * `git-hooks` gets no labels at all, and one that skipped `commit-hygiene` never
 * sees its triple appear in the repo's label list. An unselected scaffold's
 * labels are left alone rather than deleted; removal is `uninstall`'s to do.
 * @param {object} params
 * @param {GitHub|null} params.client - The API client, or null to skip.
 * @param {(line: string) => void} params.log
 * @param {string[]} params.ids - The scaffolds being installed.
 * @returns {Promise<void>}
 */
export async function ensureGateLabels({ client, log, ids }) {
  if (!client) {
    log("skip     labels (no GitHub credentials or repo context)");
    return;
  }
  const wanted = labelsFor(ids);
  if (wanted.length === 0) {
    log("skip     labels (the installed scaffolds need none)");
    return;
  }
  for (const { name, color, description } of wanted) {
    const state = await client.ensureLabel(name, color, description);
    log(`${state.padEnd(9)}${name}`);
  }
}

// Basenames in the repo's `.github/workflows/`, or an empty list when the
// directory is absent. Read after the file loop has written the vendored
// workflows, so the merge-blocking gate's file is present if this run installed it.
const WORKFLOW_DIR = join(".github", "workflows");

/**
 * List the workflow basenames `checkProtection` matches the PR gate against.
 * @param {string} cwd
 * @returns {string[]}
 */
function listWorkflowFiles(cwd) {
  try {
    return readdirSync(resolve(cwd, WORKFLOW_DIR));
  } catch {
    return [];
  }
}

/**
 * Report, as one advisory line, whether the merge-blocking PR gate is actually a
 * required status check on the default branch. This is the detection half of the
 * enforcement split (ADR 0014): vendoring the workflow makes the check run, and
 * only a required-status-check rule (a per-repo setting nothing here can commit)
 * makes it block. `init` reports the gap and deliberately never repairs it, so a
 * routine, half-attentive `init` across a fleet cannot require a currently-red
 * check and wedge every open PR at once.
 *
 * Never changes `init`'s exit code: missing enforcement is a repository-settings
 * fact, not an `init` failure, and the read may lack admin scope (reported
 * honestly as unreadable). With no client, report skipped like the label step.
 * @param {object} params
 * @param {GitHub|null} params.client - The API client, or null to skip.
 * @param {(line: string) => void} params.log
 * @param {string} [params.cwd]
 * @returns {Promise<void>}
 */
export async function reportProtection({ client, log, cwd = process.cwd() }) {
  if (!client) {
    log("skip     protection (no GitHub credentials or repo context)");
    return;
  }
  const result = await checkProtection({
    gh: client,
    workflowFiles: listWorkflowFiles(cwd),
  });
  log(`${(isDrift(result) ? "warn" : "ok").padEnd(9)}${result.message}`);
  if (isDrift(result)) {
    log(
      `         Requiring '${result.context}' on '${result.branch}' is a one-time admin act ` +
        "init will not take for you: do it once the gate is green on the PRs you care about.",
    );
  }
}

/**
 * Find the scaffolds this repo has on disk but does not record as installed.
 *
 * An orphan is the residue of a narrowed selection, or of a repo scaffolded
 * before the manifest existed. It is reported and never touched: `init` is
 * additive everywhere else (it reports the gate-activation gap and never repairs
 * it, it never writes `.repo-contract/hooks/local`), and deleting workflows or
 * hooks mid-run is destructive. Teardown is `uninstall`'s job.
 *
 * Detection reaches the filesystem and `core.hooksPath`, deliberately not the
 * remote. The report exists to answer "is this still enforcing?": an orphaned
 * `git-hooks` still pointed at by `core.hooksPath` fires on every commit, while
 * an orphaned scaffold's labels sit inert on the remote and cost credentials to
 * read.
 * @param {string[]} ids - The scaffolds being installed.
 * @param {string} [cwd]
 * @returns {{id: string, files: string[], enforcing: boolean}[]}
 */
export function findOrphans(ids, cwd = process.cwd()) {
  return SCAFFOLD_IDS.filter((id) => !ids.includes(id))
    .map((id) => {
      const { files, activatesHooks } = scaffold(id);
      return {
        id,
        files: files
          .map((f) => f.to)
          .filter((to) => existsSync(resolve(cwd, to))),
        enforcing: activatesHooks && readHooksPath(cwd) === HOOKS_PATH,
      };
    })
    .filter((o) => o.files.length > 0 || o.enforcing);
}

/**
 * Report each orphan as one line, plus a second line for one that is still
 * actively enforcing, which is the case an operator most needs to see.
 * @param {object} params
 * @param {{id: string, files: string[], enforcing: boolean}[]} params.orphans
 * @param {(line: string) => void} params.log
 * @returns {void}
 */
export function reportOrphans({ orphans, log }) {
  for (const { id, files, enforcing } of orphans) {
    log(
      `orphan   ${id} (${files.length} file(s) on disk, not in the manifest: ${files.join(", ")})`,
    );
    if (enforcing) {
      log(
        `         core.hooksPath still points at ${HOOKS_PATH}, so these hooks run on every ` +
          `commit despite not being recorded. Remove them with: repo-contract uninstall ${id}`,
      );
    }
  }
}

/**
 * Copy a selected subset of the scaffolds into the current working directory,
 * record what is now installed, and print the Suggested rule to stdout.
 *
 * Which scaffolds is resolved by `--only <ids>` -> interactive prompt (TTY) ->
 * the recorded manifest -> all-in (`selection.js`). `init` only ever adds: a
 * selection that would drop an installed scaffold is refused and pointed at
 * `uninstall`, so a command whose job is to install can never open a gap between
 * the manifest and what is enforcing.
 *
 * Within the selection, absent files are created. Byte-identical files are left
 * untouched (`init` is idempotent). A drifted file — stale or locally customized —
 * makes a plain run a write-nothing report that exits 1; re-run with `--force` to
 * overwrite only the files that differ. Only a *selected* scaffold's drift blocks
 * that run. Warns (but proceeds) when not at a repo root. The Suggested rule is
 * printed on success and written to no file.
 *
 * Files belonging to an unselected scaffold are orphans: reported, never written,
 * never removed, never blocking (see {@link findOrphans}).
 *
 * After the files, activate them, if the selection includes the hooks: each
 * vendored hook is written executable and `core.hooksPath` is set to the relative
 * `.repo-contract/hooks` where this repo's local config leaves it unset (ADR 0012,
 * ADR 0017, ADR 0020). That is what makes a checkout which never ran a
 * package-manager install enforce the baseline, and what keeps a linked worktree
 * on the hooks committed to its own branch. A *foreign* local `core.hooksPath`
 * (one repo-contract did not set) is not repointed: because a hook that cannot be
 * activated is inert, a foreign value blocks the `git-hooks` scaffold **only** —
 * detected in the pre-flight, none of its files written — while the other
 * scaffolds install unaffected, and the run reports the block and exits non-zero.
 * `--overwrite-hooks-path` (or the TTY prompt) adopts the foreign value, printing
 * the one it displaced.
 *
 * Then reconcile the label schema the selection needs: create any missing label,
 * repair any whose color/description drifted. This needs credentials and repo
 * context, discovered the way `sweep` does (`gh auth token`, `gh repo view`);
 * with neither the label step is reported as skipped and the file scaffolding
 * still stands.
 *
 * Then report (never repair) whether the merge-blocking PR gate is actually a
 * required status check on the default branch. Vendoring the workflow makes the
 * check run; only a required-status-check rule (a per-repo setting nothing here
 * can commit) makes it block, and that gap is otherwise silent (ADR 0014). The
 * report is advisory and never affects the exit code.
 *
 * Finally, write the selection to `.repo-contract.json`. The manifest is written
 * last, after everything it claims has actually landed, so it never records an
 * install that a mid-run failure prevented.
 * @param {string[]} [argv] - Remaining CLI args; `--force` upgrades in place,
 *   `--only <ids>` selects scaffolds explicitly, `--overwrite-hooks-path` adopts
 *   a foreign local `core.hooksPath`.
 * @returns {Promise<void>}
 */
export async function init(argv = []) {
  const force = argv.includes("--force");
  const cwd = process.cwd();

  // Soft guard: `.github/` is only read at the repo root. Warn but proceed;
  // scaffolding into a fresh dir before `git init` is legitimate.
  if (!existsSync(resolve(cwd, ".git"))) {
    console.warn(
      "warning: no .git in the current directory. GitHub only reads .github/ " +
        "from the repository root; run this there or the workflow will not run.",
    );
  }

  // Resolve the selection before touching anything: a refusal or a cancelled
  // prompt must leave the repo exactly as it was.
  const recorded = loadConfig(cwd).scaffolds;
  const { ids, source } = await resolveSelection({
    argv,
    recorded,
    interactive: canPrompt(),
    prompt: promptForScaffolds,
  });
  console.log(`Installing ${ids.join(", ")} (selected by: ${source})\n`);

  // Hook-activation ownership, resolved in the pre-flight beside the drift gate
  // (ADR 0020). A foreign local `core.hooksPath` blocks the `git-hooks` scaffold
  // only: none of its files are written and it is not recorded, while the other
  // scaffolds install unaffected. The `--overwrite-hooks-path` flag, or a TTY
  // prompt, adopts the foreign value instead; with no opt-in and no terminal to
  // ask, the block stands.
  const wantsHooks = ids.includes(SCAFFOLD.GIT_HOOKS);
  const foreign = wantsHooks ? foreignHooksPath(cwd) : "";
  let overwriteHooks = argv.includes(OVERWRITE_HOOKS_FLAG);
  if (foreign && !overwriteHooks && canPrompt()) {
    overwriteHooks = await promptForOverwriteHooksPath(foreign);
  }
  const hooksBlocked = foreign !== "" && !overwriteHooks;
  // Everything downstream (files, activation, labels, orphans, manifest, next
  // steps) operates on the scaffolds actually installed, so a blocked `git-hooks`
  // is neither written nor recorded as installed.
  const fileIds = hooksBlocked
    ? ids.filter((id) => id !== SCAFFOLD.GIT_HOOKS)
    : ids;

  const entries = classify(fileIds);
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

  // Activation follows the manifest: only a scaffold that declares it claims
  // `core.hooksPath`, so a repo that did not install the hooks never has its git
  // config repointed at a directory it does not own. When `git-hooks` was
  // selected, `ensureHooksPath` runs even under a block: with no opt-in it prints
  // the loud block report (the files were already withheld above) and returns
  // `blocked`; with the opt-in it adopts the foreign value.
  console.log("\nActivation:");
  let activation = "not-installed";
  if (wantsHooks) {
    activation = ensureHooksPath({
      log: (line) => console.log(line),
      overwrite: overwriteHooks,
    });
  } else {
    console.log(
      `skip     core.hooksPath (${SCAFFOLD.GIT_HOOKS} is not installed)`,
    );
  }

  const client = resolveLabelClient();

  console.log("\nLabels:");
  await ensureGateLabels({
    client,
    log: (line) => console.log(line),
    ids: fileIds,
  });

  // Protection only concerns the PR gate, so it is only worth reading where that
  // gate was installed. checkProtection would report it as not-installed anyway;
  // skipping avoids spending an API call to say so.
  if (fileIds.includes(SCAFFOLD.QUALITY_GATES)) {
    console.log("\nProtection:");
    await reportProtection({ client, log: (line) => console.log(line), cwd });
  }

  const orphans = findOrphans(fileIds, cwd);
  if (orphans.length > 0) {
    console.log("\nNot installed, but present on disk:");
    reportOrphans({ orphans, log: (line) => console.log(line) });
  }

  // The manifest goes last, once everything it claims has landed, so it never
  // records an install a mid-run failure prevented. A block leaves it untouched
  // entirely: recording `git-hooks` as dropped would defeat both remedies the
  // block prints, since a bare re-run (or one after `git config --local --unset`)
  // reads the recorded selection and would never re-select the scaffold. Leaving
  // the manifest as it was keeps a fresh repo's re-run all-in and a prior
  // manifest's re-run faithful, so the hooks are retried either way. The
  // already-written other scaffolds are re-selected and recorded on that re-run.
  if (!hooksBlocked) {
    writeScaffolds(fileIds, cwd);
    console.log(`\nRecorded in ${CONFIG_FILENAME}: ${fileIds.join(", ")}`);
  }

  console.log(`\nDone. ${nextSteps(fileIds, activation)}`);

  // The rule points agents at the Author guides, which only exist where
  // `quality-gates` was installed. Printing it regardless would hand the operator
  // a rule naming two files their repo does not have.
  if (fileIds.includes(SCAFFOLD.QUALITY_GATES)) {
    console.log(`\n${SUGGESTED_RULE}`);
  }

  // A foreign `core.hooksPath` refused the `git-hooks` scaffold. The other
  // scaffolds installed, but the requested hooks did not, so exit non-zero — the
  // loud, single-step block the drift gate is modelled on (ADR 0020).
  if (hooksBlocked) process.exit(1);
}

/**
 * The closing paragraph, assembled from the scaffolds that were actually
 * installed. Telling an operator to require the `pr-readiness` context, or that
 * the hooks are live, when they installed neither would be the same class of
 * mistake the activation report exists to prevent: prose that describes the
 * package rather than this repo.
 * @param {string[]} ids - The scaffolds installed.
 * @param {string} activation - The outcome of the `core.hooksPath` step.
 * @returns {string}
 */
function nextSteps(ids, activation) {
  const parts = [
    `Commit these files to opt this repo into: ${ids.join(", ")}.`,
  ];

  if (ids.includes(SCAFFOLD.GIT_HOOKS)) {
    // Reports what actually happened: claiming the hooks are live where
    // activation was skipped would restate the bug that step exists to fix.
    parts.push(
      activation === "skipped"
        ? `The git hooks are NOT active: there is no git repository here yet. Run \`git init\` and ` +
            `then \`git config core.hooksPath ${HOOKS_PATH}\` (or re-run this command).`
        : `The git hooks are live in this checkout now (core.hooksPath=${HOOKS_PATH}, a relative value, ` +
            "so each linked worktree runs the hooks committed on its own branch).",
      "core.hooksPath is per-clone git config, never committed: run this command once in every " +
        "fresh clone or worktree, or the hooks sit on disk unread.",
    );
  }

  if (ids.includes(SCAFFOLD.COMMIT_HYGIENE)) {
    parts.push(
      "CI keeps the un-bypassable copy of the commit baseline in the commit-hygiene gate.",
    );
  }

  if (ids.includes(SCAFFOLD.QUALITY_GATES)) {
    parts.push(
      "The issue gate only labels issues going forward. To backfill labels + scorecards " +
        "onto the existing open backlog, run: repo-contract sweep",
      "The PR gate blocks merge only once its 'pr-readiness' context is a required status " +
        "check on the default branch (see the Protection line above); vendoring the workflow " +
        "makes it run, not block, and requiring the context stays a deliberate admin act.",
    );
  }

  const missing = SCAFFOLD_IDS.filter((id) => !ids.includes(id));
  if (missing.length > 0) {
    parts.push(
      `Not installed: ${missing.map((id) => `${id} (${scaffold(id).summary})`).join("; ")}. ` +
        `Add one later by re-running init and choosing it, or with --only ${[...ids, missing[0]].join(",")}.`,
    );
  }

  return parts.join("\n");
}
