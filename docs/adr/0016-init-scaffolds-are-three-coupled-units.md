# `init` installs three coupled scaffolds, not per-check or per-gate units; partial installs are recorded, never torn down

`init` grew an interactive, surface-level opt-in (#74): an operator chooses which
of repo-contract's features to scaffold, rather than always getting all of them.
The re-scope from #116 / ADR 0015 already settled that selection is
**surface-level, not per-check** (check relaxation stays with `.repo-contract.json`
overrides, which leave a reasoned, mirror-honored bypass; silently dropping a
check conflicts with that reason-bearing model). What it left open was the
decomposition itself: what the independently-installable units are, how they
depend on each other, and how `classify()` / drift account for a repo that
deliberately installed only some of them.

We resolved it to **three scaffolds with no dependency edge between them**, a
**recorded selection** that makes a partial install first-class, and an
**additive `init`** whose teardown counterpart is a separate `uninstall` command.

## The decomposition

The test for whether two things are separate scaffolds is: **is there a coherent
reason to want one without the other?** Applied to the four candidates (#74's
issue gate, PR gate, commit-hygiene gate, local hooks):

- **The issue and PR gates fail the test, so they are one scaffold** (`quality-gates`).
  They are the two composable halves of one flow: the issue is the spec before
  pickup, the PR is the report of how the spec was met. "Strict issues, loose PRs"
  is incoherent. Crucially, the PR gate's transitive linked-issue check reads the
  issue gate's `issue-quality:*` labels, so installing the PR gate _without_ the
  issue gate breaks every PR that closes an issue. Coupling them into one scaffold
  **dissolves that dependency** instead of managing it: the linked-issue check
  always has issue-gate labels present, so no conditional-workflow logic and no
  "you picked the PR gate without the issue gate" warning is ever needed.
- **The commit-hygiene gate and the local hooks pass the test, so they stay
  separate** (`commit-hygiene`, `git-hooks`). They enforce the _same_ baseline
  (Conventional Commits, em-dash policy, no default-branch commits) but on
  different **execution surfaces**: the gate is the un-silenceable CI mirror, the
  hooks are bypassable fast local feedback, and different audiences want one
  without the other (an OSS maintainer wants CI enforcement without forcing
  contributor hooks; a solo dev wants the reverse).
- **The commit-hygiene gate and the quality gates pass the test**: commit-message
  and diff hygiene is a different concern, at a different authoring moment, than
  issue/PR body structure.

The result is three scaffolds with **zero dependency edges**, so any subset
installs coherently. A scaffold is not a **Gate**: `quality-gates` bundles two
gates, `commit-hygiene` one, `git-hooks` none.

Scaffold ids reuse the scaffold's **most-recognizable public handle**, coining a
name only where the identity is diffuse: `commit-hygiene` matches the
`commit-hygiene:*` labels and status-check context an operator already sees;
`git-hooks` names the mechanism (and leaves room for a future, distinct
`claude-hooks` scaffold rather than pre-claiming `local-hooks`); `quality-gates`
is coined, because the two gates it bundles have distinct handles
(`issue-quality`, `pr-readiness`) with no shared label to reuse.

## The recorded selection

Selection is recorded as a `scaffolds` array in `.repo-contract.json` (the one
committed, `jq`-queryable repo-contract config; the key sits alongside `overrides`
without disturbing the opt-out parsing). It is an **authoritative whitelist of
installed scaffolds**, rewritten on every `init` run rather than only for a partial
selection. It is a plain list, not reason-bearing: a scaffold selection is an
install manifest, not a bypass of an active default-on rule, so nothing is being
silently dropped.

**An absent key means none installed**, not all-in. The alternative (absent = all-in,
so every pre-manifest consumer reads as a full install and needs no migration) buys
backward compatibility by making one value mean two things, and it is the reading
that would have to be unwound the first time a genuinely empty repo appears. We took
the loud version instead and accepted its cost: every repo scaffolded before the
manifest existed needs one `init` run to record what it already has, done manually
rather than inferred. In that migration window a `--only` narrower than what is on
disk is not refused (the record it checks is empty) and produces **orphans**, which
is the accepted footgun of this choice.

The array is **never empty**. A run that would install nothing is an error on both
paths: the interactive prompt refuses an empty submission and `--only` with an empty
set exits non-zero. `uninstall`ing the last scaffold removes the key rather than
writing `[]`, so "nothing installed" has exactly one representation. Every id must
name a known scaffold: `parseConfig` validates membership and throws on anything
else, which does mean a hand-edited typo red-fails any surface reading the file,
including the commit-hygiene gate. That is deliberate, because the quiet failure is
worse: an unrecognized id read as "not installed" lets a later selection drop a
live scaffold without the refusal firing.

**`init` only ever adds.** A selection that would drop an installed scaffold is
refused, not recorded: `init --only quality-gates` in a repo whose manifest lists
`git-hooks` exits non-zero, names what it would drop, and points at
`uninstall git-hooks`. The consumer's two exits are widening the `--only` set or
uninstalling first, and both are stated in the error. Deselection has exactly one
home, which is what keeps the manifest and the filesystem from disagreeing by way
of a command whose job is to install.

`classify()` becomes per-scaffold. For a **selected** scaffold its files classify
as before (`absent` → create, `ok`, `drift` → blocks a plain run, `--force`
overwrites), and only a selected scaffold's drift blocks the atomic read-only run.
A file present on disk but absent from the manifest is an **orphan**: reported,
never created, never removed, never blocking. Orphan detection reaches the
filesystem and `core.hooksPath`, not the remote. That reach is chosen so the report
can answer "is this still enforcing?": an orphaned `git-hooks` whose `core.hooksPath`
still points at it fires on every commit, while an orphaned scaffold's labels sit
harmlessly on the remote, cost credentials to read, and are `uninstall`'s to name.

Selection precedence is **explicit `--only` flag → interactive prompt (TTY) →
recorded selection → all-in**. `--only <ids>` is the scriptable path (there is no
`--skip`; one way to express a selection); a bare `init` non-interactively honors
the record, or installs all-in when the key is absent, preserving today's behavior
for scripted runs. `--help` enumerates the three ids so a consumer learns the
vocabulary without reading source.

The TTY prompt **offers only the scaffolds that are not yet installed**, listing the
installed ones above as fixed context. Since `init` cannot deselect, a multiselect
pre-checked to the current record would present unchecking as an available move and
then refuse it; offering only absent scaffolds makes deselection unrepresentable
rather than merely rejected. It also removes a prompt from the most common
invocation: in a fully-installed repo there is nothing left to offer, so a re-run or
an `init --force` upgrade proceeds without stopping for input. The prompt is a
JS-native library (`@clack/prompts`) on the CLI surface only, pinned exactly, since
`npx`-from-git resolves it with no lockfile (ADR 0015).

## Considered options

- **Four independently-selectable units with a managed PR→issue dependency.**
  Rejected. Keeping the issue and PR gates separate forces either a broken
  partial install (a PR gate with no issue-gate labels fails every PR closing an
  issue) or a conditional linked-issue check in the workflow that runs only when
  the issue gate is present: new runtime coupling and workflow complexity. The
  dependency is a symptom that the seam was in the wrong place; coupling removes
  the seam.
- **Tear down a deselected scaffold from within `init` (`--force` removes it).**
  Rejected as out of character and unsafe. `init` is additive and
  report-never-destroy everywhere else (it reports the **Gate activation** gap
  and never repairs it; it never touches the `.repo-contract/hooks/local` chain).
  Removing scaffolded
  workflows, templates, or hooks mid-flight, and deleting labels that are applied
  to live issues and PRs, is destructive. Teardown belongs in an explicit,
  separately-invoked `uninstall` command (a follow-up), which removes exactly one
  scaffold's footprint via its manifest, unsets `core.hooksPath` when it still
  holds the managed value (handing activation back to any global tier-1 hooks),
  and leaves remote label deletion out by default.
- **A separate manifest file for the selection.** Rejected: it splits
  repo-contract's committed config across two files for no gain, since
  `.repo-contract.json` already parses cleanly around an added key.
- **Reason-bearing deselection** (mirroring the `overrides` `reason`). Rejected
  for this axis: a scaffold that was never installed is not a relaxed rule, so
  there is no active enforcement to justify; the git history of the manifest and
  the list itself already make the choice legible.
- **Let `init` deselect, recording the exclusion and reporting the orphans.** The
  first form of this decision, rejected on the second pass. It gives `init` two
  jobs whose failure modes differ: installing is idempotent and safe to run
  half-attentively across a fleet, while deselecting silently leaves a scaffold
  enforcing under a manifest that denies it. Refusing costs the operator one extra
  command (`uninstall`) in the rare case and buys the guarantee that no `init` run
  can ever open a gap between the record and reality.
- **Absent key means all-in.** Rejected with the above: it keeps every existing
  consumer migration-free, at the price of one value meaning both "nothing
  installed" and "everything installed" depending on what is on disk. Manual
  migration is the accepted cost of the single meaning.

## Consequences

- Partial installs are first-class: an unselected scaffold is neither reinstalled
  nor flagged, and `init` stays idempotent on re-run against a recorded selection.
- Orphans (present-but-unrecorded files) are reported, never removed; `uninstall`
  is the tool that resolves them, and is a follow-up kept out of #74 so it stays
  reviewable.
- Every repo scaffolded before the manifest existed reads as "nothing installed"
  until someone runs `init` there once. Until then its `--only` runs are unguarded
  by the never-deselect refusal.
- `TEMPLATES` + `GATE_LABELS` are replaced by a per-scaffold manifest
  (scaffold → `{ files, labels, activation }`) that both `init` and `uninstall`
  read, which is what makes "touch only that scaffold" precise.
- A new scaffold added upstream auto-installs on re-run only into an absent-key
  repo, where a bare non-interactive `init` still falls through to all-in; a repo
  with a recorded selection stays as chosen, and the TTY prompt offers the new
  scaffold as one more not-yet-installed option until an operator takes it.
