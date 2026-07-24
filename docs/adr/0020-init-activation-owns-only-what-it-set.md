---
status: accepted
---

# `init` activation owns only the `core.hooksPath` it set

`init` sets `core.hooksPath` to the relative `.repo-contract/hooks` only when
this repo's _local_ git config leaves it unset. Any other local value is
**foreign** (repo-contract did not write it), and `init` leaves it alone rather
than repointing it. Because a vendored hook on disk that cannot be activated is
inert, a foreign value makes `init` refuse to write the `git-hooks` scaffold at
all, reporting loudly, rather than laying files down it cannot turn on. An
operator can opt in explicitly, per invocation, to have repo-contract take the
value over.

## Context

`ensureHooksPath` read the _effective_ `core.hooksPath` (local over global over
system) and, whenever it was not `.repo-contract/hooks`, overwrote it and
reported `repair`. That one branch fired for three unrelated pre-existing states
and treated them identically:

- **local unset**: writing the value is legitimate prevent-forward.
- **a stale `.husky`** from a pre-ADR-0017 install: a value repo-contract's own
  past self wrote.
- **an operator's own local `core.hooksPath`** (their directory, or a deliberate
  absolute path): a value repo-contract never set and does not own.

The last two are the problem: `init` normalized a past install forward and
silently clobbered a value it did not own. That conflicts with the global
_"prevent forward; remediate separately"_ principle, and ADR 0017 leaned on the
repair-forward explicitly (`init` "carries no migration … `ensureHooksPath`
already repoints … whatever the current value is").

PR #139 (`uninstall`) made the conflict concrete. Its `releaseHooksPath` reads
the _local_ value and unsets it only where it still holds `.repo-contract/hooks`,
keeping anything else. So the two halves disagreed: `uninstall` touched only what
repo-contract set; `init` clobbered everything. This ADR makes `init` symmetric
with that reference, and supersedes ADR 0017's repair-forward clause and the
absolute-value repair inherited from ADR 0012.

## Decisions

- **Ownership is a single equality: `local === .repo-contract/hooks`.** `init`
  reads this repo's _local_ `core.hooksPath` (never the merged effective value).
  Unset → set it. Equal → leave it. **Anything else is foreign** and is never
  repointed on a routine run. This is the exact test `releaseHooksPath` already
  applies on the way out.

- **A `.husky` value is a leftover to name, not ours to repoint.** The value a
  pre-ADR-0017 repo-contract wrote is byte-identical to the value an operator
  running husky today would have; the two are indistinguishable, and ADR 0017
  already declared `.husky` a name repo-contract must not claim. So it is foreign
  like any other. The stale-`.husky` migration is left as its own decision (a
  follow-up issue), not folded into the ownership test.

- **A foreign value blocks the `git-hooks` scaffold, and only that scaffold.**
  Detected in the pre-flight, before any write, the way drift is. A vendored hook
  written but not activated is inert, so `init` writes none of the `git-hooks`
  files in that case and reports the block loudly, naming the remedy. The other
  scaffolds (workflows, templates) are useful committed regardless of local git
  config, so this gate does not touch them.

- **An explicit, per-invocation opt-in overwrites a foreign value.** A TTY prompt
  asks; the `--overwrite-hooks-path` flag answers it headlessly, so interactive
  and non-interactive sessions reach the same outcome. On overwrite, `init`
  prints the displaced value, because a local `core.hooksPath` is not committed
  and has no reflog to recover it from.

- **The doctrine, stated once, is symmetric.** Both `init` and `uninstall` leave
  a foreign value untouched by default. `init` alone offers the opt-in to adopt
  one, justified because it has a reason to want the value (to activate) while
  `uninstall` has none to delete one (a foreign value already means repo-contract
  is not active, so there is nothing to hand back). No change to `uninstall`.

## Considered options

- **Warn and continue: write the files, leave the foreign value, report inert.**
  Rejected: it produces exactly the pointless state the gate exists to prevent
  (`git-hooks` files on disk that git will never run), and buries the reason in a
  post-write line. Gating the write up front keeps `init` from laying down what
  it cannot turn on.

- **Overload `--force` to overwrite the foreign value.** Rejected. `--force`
  overwrites drifted _committed_ files, and its safety rests on git holding the
  receipts (`git diff` shows what changed, and can restore it). A local
  `core.hooksPath` is not committed, so overwriting it is unrecoverable. Reusing
  `--force` would silently destroy an operator's unrecoverable value on a routine
  drift refresh, a blast-radius expansion under an unrelated intent. A dedicated
  `--overwrite-hooks-path` keeps the two forces distinct.

- **Keep a recognized-legacy set (`\.husky`, `.husky/_`) that `init` repoints.**
  Rejected: it is repair-forward under another name, and it cannot tell a
  repo-contract leftover from an operator's own husky.

- **Keep auto-relativising an absolute value (the ADR 0012 / 0017 behavior).**
  Rejected: repo-contract only ever _writes_ the relative form, so it never
  authored an absolute value; every absolute value is therefore foreign, and
  repointing it is the same clobber this ADR removes. `init` still reports the
  worktree-pinning hazard, but leaves the value for the operator to resolve.

## Consequences

- **A pre-ADR-0017 consumer's `.husky` is no longer migrated forward by `init`.**
  This was already the effective outcome once `init` repointed `core.hooksPath`
  (the stale files stopped being invoked); now `init` does not touch the value at
  all, so the consumer resolves it deliberately. Handling that leftover is a
  separate, named follow-up.

- **A foreign `core.hooksPath` blocks installing `git-hooks` until resolved.** The
  operator unsets it and re-runs, or passes `--overwrite-hooks-path` / answers the
  prompt. This is a loud, single-step block, not a silent one, and the
  **Commit hygiene** CI gate mirrors the tier-2 rules regardless.

- **`init` and `uninstall` now read and write `core.hooksPath` through one shared
  ownership rule.** The asymmetry PR #139 exposed is closed.
