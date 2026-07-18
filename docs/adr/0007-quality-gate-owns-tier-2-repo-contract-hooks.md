# quality-gate owns the tier-2 repo-contract git hooks

quality-gate is a safety package consumed across the org, so the commit-time
rules every consumer must obey belong here, not in one contributor's personal
dotfiles. Those rules are the **tier-2 repo-contract**: Conventional Commits,
the em-dash ban, and no commits on the default branch. They encode a contract
that binds CI and contributors who have no `~/.dotfiles` checkout, which is
exactly the audience a globally configured `core.hooksPath` cannot reach.
The tiered model that assigns these rules to a consumed package originates in
dotfiles ADR 0002 ("Tiered git-hook enforcement with legible bypass"); this ADR
records the ownership from quality-gate's side and the mechanisms that make it
real.

Ownership means three things, all already in the code:

- **`init` vendors the hooks.** `init(argv)` in `src/commands/init.js` copies a
  fixed template set verbatim into the consumer repo. Two of those are husky
  hooks dropped into `.husky/`: `templates/husky/commit-msg` and
  `templates/husky/pre-commit`. The `commit-msg` hook enforces Conventional
  Commits (subject regex over the known types) and the em-dash ban in the
  message. The `pre-commit` hook refuses commits on the default branch (resolved
  via `origin/HEAD`, then `init.defaultBranch`, then `main`) and bans em dashes
  in staged Markdown added lines. Both are POSIX `sh` depending only on
  `sh`/`git`/`jq`, never on `node_modules`, so they run before `yarn install`
  and in worktrees or containers that never installed. Hooks ship all-in with no
  per-feature selection; repo-specific checks chain through `.husky/local/`,
  which `init` never writes.
- **Drift is byte-exact.** Because the copies are verbatim, exact equality is the
  drift signal. `classify()` in `src/commands/init.js` compares each vendored
  destination against its bundled source and returns `ABSENT`, `OK`, or `DRIFT`.
  Without `--force`, any drift makes the run read-only: it prints a
  missing/ok/stale report and exits non-zero. With `--force`, the write loop
  overwrites every non-OK destination. There is no version marker; `--force`
  cannot distinguish stale-upstream from local customization and relies on the
  git diff to make the change reviewable.
- **Opt-outs are reason-bearing data.** The hooks read a committed
  `.quality-gate.json`, parsed by `loadConfig` / `parseConfig` in `src/config.js`.
  Each `overrides.<key>` entry is `{ value, reason }`, and `validateOverride`
  rejects an override whose `reason` is missing or empty: every opt-out must
  record why it exists. `formatOverride` quotes that reason verbatim into the
  hook or gate output, so the escape is self-documenting at the point it fires.
  The opt-out keys are `allowDefaultBranchCommits`, `skipConventionalCommits`,
  `allowEmDashes`, and the `maxAllowedEmDashes` budget.

The local hooks have an un-silenceable CI backstop in their own namespace:
`src/gates/commit.js`, shipped as `templates/workflow/commit-hygiene.yml`, writes
the `commit-hygiene:{failing,warning,pass}` label and honors the same opt-out
axes plus an `override:commit-hygiene` label. This is why `--no-verify` is not a
sanctioned escape: bypass is available, but only through a legible config entry
or a labeled override, never an invisible flag.

## Considered options

- **Leave the ownership implicit in the code.** Rejected: a reader of
  `docs/adr/` cannot discover why quality-gate ships git hooks, why drift is
  byte-exact, or why opt-out reasons are a data field. The mechanisms are load
  bearing and deserve a recorded rationale here, not only upstream.
- **Restate dotfiles ADR 0002 in full.** Rejected: the audience-split reasoning
  (which rules are tier-2 versus tier-1 agent-hygiene versus tier-3 project
  checks) is a dotfiles concern and lives there. This ADR cross-references it as
  the origin and records only what quality-gate owns and enforces.
- **Track drift with a bumped version marker instead of byte comparison.**
  Rejected: byte-exact equality on verbatim copies needs no marker to maintain
  and cannot fall out of sync with the files it describes. It is the mechanism
  already in `classify()`.
- **Carry opt-out reasons as comments rather than data fields.** Rejected: a
  program cannot surface a comment. The reason must be queryable so
  `formatOverride` can quote it when the hook or gate fires.

## Consequences

- quality-gate is the single home for the tier-2 baseline: `init` distributes it,
  `classify()` verifies it, `commit-hygiene.yml` mirrors it on CI, and the release
  cadence propagates changes. A repo wanting the hooks pulls in the package.
- A consumer's local hook set can drift from the bundle, but only visibly:
  `classify()` reports it and `init --force` repairs it, with the git diff as the
  audit trail. There is no silent divergence.
- Every opt-out is a reviewable `.quality-gate.json` entry carrying its own
  reason, and `--no-verify` is retired as the sanctioned escape in favor of that
  entry or an `override:commit-hygiene` label.
- This ADR and dotfiles ADR 0002 must stay consistent: a change to which rules
  are tier-2, to the config filename, or to the `commit-hygiene:*` namespace
  touches both, and the two should be reconciled in the same change.
