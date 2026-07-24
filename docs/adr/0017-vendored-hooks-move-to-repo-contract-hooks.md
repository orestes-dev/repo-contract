# The vendored hooks move to `.repo-contract/hooks/`

> **Superseded in part by ADR 0020.** The repair-forward behavior this ADR
> relies on (`ensureHooksPath` repointing `core.hooksPath` "at whatever the
> current value is," and the absolute-value repair inherited from ADR 0012) is
> replaced: `init` now sets `core.hooksPath` only when locally unset and leaves
> any foreign value alone. The directory move and the collision-safe name below
> stand.
>
> **Revisit closed by [ADR 0021](0021-the-local-chain-is-the-adoption-path.md).**
> The `.husky/` migration rejected below stays rejected, for every prior hook
> tool and not just husky: the `local/` chain is the adoption path, signposted
> from the foreign-value block.

The vendored git hooks, their consumer-owned extension point, and the
`core.hooksPath` value all move from `.husky` to `.repo-contract/hooks`. The
canonical bundle moves with them, from `templates/husky/` to
`templates/git-hooks/`. What the hooks enforce, their `sh`+`jq` dependency
budget (ADR 0015), and the relative-path activation logic (ADR 0012) are
unchanged.

`.husky` was husky's directory, and husky is gone: ADR 0012 made `init` set
`core.hooksPath` itself and git exec the committed files directly, with no shim
and no install step. The name survived that change for continuity, and now names
nothing. Worse, it is a **collision risk**. repo-contract vendors into arbitrary
consumer repositories, and `.husky` is a name a consumer may already own,
exactly as a generic `.githooks` would be. A vendoring tool that writes
byte-for-byte-owned files, reports anything else there as drift, and repairs it
with `--force`, must not claim a name someone else may be using: the drift
report would be about a file repo-contract never had any business owning.

`.repo-contract/hooks/` is collision-proof by namespacing, self-documenting
about who owns the files, and consistent with `.repo-contract.json` and the
`git-hooks` scaffold id (ADR 0016).

## Decisions

- **The extension point moves too**, from `.husky/local/<name>` to
  `.repo-contract/hooks/local/<name>`. Leaving it behind would keep the vendored
  hooks reading a `.husky` path at runtime, which is the collision the move
  exists to remove. `init` still never writes under `local/`, so a consumer's
  tier-3 chain survives `init --force` (ADR 0012).
- **The template source directory is `templates/git-hooks/`**, matching the
  `git-hooks` scaffold id rather than the destination path, and reserving room
  for a future `templates/claude-hooks/` beside it.
- **`init` carries no migration.** It targets the new path only, and never
  deletes or relocates a consumer's files. `ensureHooksPath()` already repoints
  `core.hooksPath` at whatever the current value is, which is the one repair a
  moved directory needs; the stale `.husky/` files simply stop being invoked.
  At a consumer base of one this is sufficient, and it keeps `init` additive
  rather than special-casing a teardown it would carry forever. This repo is
  hand-migrated in the same change that makes the move.

## Considered options

- **`.githooks/`.** Rejected: shorter and conventional, but conventional is
  precisely the problem. It is the most likely name for a consumer's own hooks
  directory, so it trades one collision risk for a larger one.
- **Keep `.husky/`.** Rejected: it is the status quo's only merit. The name
  misdescribes the mechanism (no husky), and the collision risk is live the
  moment a second consumer exists.
- **Make `init` migrate an existing `.husky/`** (delete the vendored copies,
  move `local/` across). Rejected for now: it means `init` deleting files in a
  consumer's tree, a power it has deliberately never taken, to serve a consumer
  base of one that a hand pass fixes once. Revisit when an external consumer
  exists, or fold it into `uninstall`.

## Relationship to ADR 0012

ADR 0012 is **superseded in part**: only its choice of directory (`.husky`, and
the repair of husky's `.husky/_` shim path) is replaced. Its actual decision,
that `init` performs activation itself and that the `core.hooksPath` value is
relative so each linked worktree runs the hooks committed on its own branch,
stands unchanged and is inherited here by reference. `init` still repairs an
absolute value; the set of values it repairs now includes a legacy `.husky` or
`.husky/_`.

## Consequences

- **This is a breaking, consumer-facing change.** A consumer that ran an earlier
  `init` keeps a stale `.husky/` in its tree, uninvoked once `init` repoints
  `core.hooksPath`, and must delete it and move its own `local/` chain by hand.
  Until it does, its tier-3 checks stop running: a visible, single-step failure,
  not a silent one, and the commit-hygiene gate still mirrors the tier-2 rules
  on CI regardless.
- **A checkout that never re-runs `init` keeps working** off the old path until
  something repoints `core.hooksPath`. The old files are still executable and
  still correct; they are simply no longer the ones repo-contract owns.
- **This repo's dogfood instance moves in the same change**: `.husky/` is
  deleted (including the stale generated `_/` shim), `.husky/local/pre-commit`
  becomes `.repo-contract/hooks/local/pre-commit`, and the `prepare` script
  points at the new path.
