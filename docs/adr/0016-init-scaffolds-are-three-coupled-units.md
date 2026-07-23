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
committed, `jq`-queryable repo-contract config; `parseConfig` ignores unknown
top-level keys, so it does not disturb the opt-out parsing). It is a **whitelist
of installed scaffolds**, and an **absent key means all-in**, which is exactly
what every consumer that ran the old all-in `init` already has, so their full
install never reads as a partial and never trips drift. The key is written only
for a partial selection; an all-in selection leaves the file untouched (and clears
a stale key), keeping "absent = all-in" the single canonical representation. It is
a plain list, not reason-bearing: a scaffold selection is an install manifest, not
a bypass of an active default-on rule, so nothing is being silently dropped.

`classify()` becomes per-scaffold. For a **selected** scaffold its files classify
as before (`absent` → create, `ok`, `drift` → blocks a plain run, `--force`
overwrites), and only a selected scaffold's drift blocks the atomic read-only run.
For a **deselected** scaffold whose files are still on disk, the state is
**`orphan`**: reported, never created, never blocking.

Selection precedence is **explicit `--only` flag → interactive prompt (TTY) →
recorded selection → all-in**. `--only <ids>` is the scriptable path (there is no
`--skip`; one way to express a selection); a bare `init` in a TTY prompts
(pre-checked to the current selection); a bare `init` non-interactively honors the
record, or installs all-in when there is none (preserving today's behavior).
`--help` enumerates the three ids so a consumer learns the vocabulary without
reading source.

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
  and never repairs it; it never touches `.husky/local`). Removing scaffolded
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

## Consequences

- Partial installs are first-class: a deselected scaffold is neither reinstalled
  nor flagged, and `init` stays idempotent on re-run against a recorded selection.
- Orphans (deselected-but-present files) are reported, never removed; `uninstall`
  is the tool that resolves them. That command, and the `.husky` → `.repo-contract/hooks/`
  directory move (a breaking migration of every consumer's committed hooks,
  `core.hooksPath`, and `.husky/local` chain), are follow-ups, kept out of #74 so
  it stays reviewable.
- `TEMPLATES` + `GATE_LABELS` are replaced by a per-scaffold manifest
  (scaffold → `{ files, labels, activation }`) that both `init` and `uninstall`
  read, which is what makes "touch only that scaffold" precise.
- A new scaffold added upstream auto-installs on re-run only into an absent-key
  (all-in) repo; a repo with an explicit selection stays as chosen until an
  operator opts the new scaffold in.
