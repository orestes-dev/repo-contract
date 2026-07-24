---
status: accepted
---

# The `local/` chain is the adoption path; `init` migrates no prior hook tool

repo-contract builds no migration for a consumer's existing hooks: not for a
stale `.husky` from a pre-ADR-0017 install, not for a plain `.git/hooks`, not for
any other hook manager. The single-valued `core.hooksPath` contract (ADR 0020)
already handles every one of them uniformly, as a **foreign** value that blocks
the `git-hooks` scaffold until the operator resolves it. What was missing is not
machinery but a signpost: the block message and the README now name the
`.repo-contract/hooks/local/{pre-commit,commit-msg}` chain as the universal way
displaced hooks keep running. Moving the bodies there stays the consumer's step.

This closes the "revisit when an external consumer exists" that ADR 0017 left
open on its rejection of a husky migration.

## Context

ADR 0017 renamed the vendored hook directory to `.repo-contract/hooks` and
rejected teaching `init` to migrate an existing `.husky/` (deleting files in a
consumer's tree is a power `init` has deliberately never taken) but deferred the
question rather than settling it. ADR 0020 then made `init` stop repointing any
foreign `core.hooksPath` at all, and listed the leftover as a named follow-up.

Two facts collapse that follow-up:

- **repo-contract does not use husky.** ADR 0012 dropped it: the vendored hooks
  are executable POSIX `sh` that git execs directly through a relative
  `core.hooksPath`, with no shim and no install step. There is no husky-shaped
  thing to migrate _to_.
- **ADR 0020 treats every prior tool identically.** A foreign value is foreign
  whether it reads `.husky`, `.githooks`, or an absolute path. Nothing in the
  ownership rule distinguishes them, so nothing downstream should either.

What remains is a **discovery gap**, not a migration gap. `core.hooksPath` is
single-valued, so taking the slot displaces whatever held it. The block message
named the remedies (unset and re-run, or `--overwrite-hooks-path`) but not the
consequence an operator actually fears, so it read as "you lose your other
hooks" when the truth is "here is how to keep them": the `local/` chain the
shipped hooks already call last (`templates/git-hooks/pre-commit`) runs any
bodies moved into it, on every commit, unchanged.

## Decisions

- **No migration is built**, for husky or anything else. ADR 0017's rejection
  becomes final rather than deferred: `init` still deletes nothing and moves
  nothing in a consumer's tree.
- **The block message gains a tool-agnostic clause** pointing at
  `.repo-contract/hooks/local/{pre-commit,commit-msg}`, and the README section a
  blocked operator lands on documents the same path.
- **The clause names no tool.** The remedy is identical for every prior setup, so
  naming one would re-narrow a message that must stay general, and would
  reintroduce, in prose, the husky special case ADR 0020 removed from the code.
- **Moving the bodies stays consumer-owned.** `init` never writes under
  `.repo-contract/hooks/local/`, which is exactly why that chain survives
  `init --force`; the message points at it and writes nothing.

## Considered options

- **Teach `init --overwrite-hooks-path` to copy the displaced directory's hooks
  into `local/`.** Rejected: it is the ADR 0017 migration in a new costume. It
  needs `init` to read, rewrite, and own files it did not author, guess which of a
  foreign directory's entries are hooks at all, and decide what to do when
  `local/` is already populated, all to save one `mv` the operator can do
  deliberately, and all on a path that has no way to be right about a tool it
  cannot identify.
- **Name husky in the message** ("if you were using husky, move…"). Rejected: it
  is the most likely displaced tool today, not the only one, and a consumer whose
  slot is held by `.githooks` or a bare `.git/hooks` would read a message that
  appears not to be about them.
- **Leave the message as-is and document the chain in the README only.**
  Rejected: the block is where the operator is standing when the question forms,
  and it already prints the remedies. A signpost that requires already knowing to
  go looking is the gap, not the fix.

## Consequences

- **A pre-ADR-0017 consumer is never migrated by any command**, now or later.
  The path is the same as for any other displaced tool: resolve the
  `core.hooksPath` block, move the hook bodies into `local/` if you still want
  them, done by hand and once.
- **The block message grows.** It is already the longest line `init` prints, and
  it earns the length: it is the single point where an operator is both stopped
  and told everything needed to proceed.
- **ADR 0017's deferred revisit is closed**, so the leftover ADR 0020 named as a
  follow-up has an answer rather than an owner.
