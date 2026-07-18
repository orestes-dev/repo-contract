# Rename the product from `quality-gate` to `repo-contract`

The repo began as a structural gate for GitHub issues, then grew a PR gate, a
commit-hygiene CI mirror, vendored husky hooks, byte-comparison drift detection,
`init` scaffolding, and the `.quality-gate.json` opt-out config. "quality-gate"
names only the CI-gate half. The larger half is now distributing one canonical
repo contract and enforcing it in two places (local hooks plus CI backstop),
with the drift checker keeping the two byte-identical. The artifact a consumer
adopts, carries config for, is checked by, and stays synced to is the
**contract**, not the gate. The name is renamed to match what the thing is.

This is one concern, not two: a single canonical contract with defense in depth.
Splitting the CI gates from the hook distribution was rejected because both sides
are downstream of one source of truth, and a split would either duplicate that
truth or introduce a versioned cross-repo dependency, recreating across repos the
drift problem the single repo solves within itself.

## What changes vs. what is frozen

Guiding principle: strings other systems key off **at runtime** are frozen;
**identity** and reference strings change.

Change (product identity):

- The GitHub repo slug `orestes-dev/quality-gate` becomes `orestes-dev/repo-contract`.
- Every `uses:` reference and `npx github:` invocation moves to the new slug. The
  GitHub rename creates a redirect, but no reference relies on it: all are updated
  in the same sweep so the old slug resolves nowhere live.
- `package.json` `name`, the `action.yml` `name`, and the CLI usage banner become
  `repo-contract`.
- `CONFIG_FILENAME` moves from `.quality-gate.json` to `.repo-contract.json`, a
  hard cut with no fallback reader. The config names what it holds (a repository's
  contract config), not the tool that consumes it, and is renamed for the same
  reason the repo is.
- The Actions job id, and therefore the emitted check context, moves from
  `quality-gate` to `repo-contract`. Verified as not a required status check in
  any consumer (`orestes-dev/food` requires `pr-governance` and `ci-ok`,
  `orestes-dev/second-brain` requires `build`, this repo requires none), so the
  rename breaks no branch protection.

Frozen (runtime-coupled, and named for the specific gate rather than the product):

- Label namespaces `issue-quality:*`, `pr-readiness:*`, `commit-hygiene:*` and the
  override labels `override:*`.
- Workflow filenames `issue-quality.yml`, `pr-readiness.yml`, `commit-hygiene.yml`.
- Gate display names ("Issue Quality Gate", "PR Readiness Gate", "Commit Hygiene
  Gate"), scorecard headings, and the CLI scorecard labels.
- Comment markers `<!-- issue-quality-gate -->`, `<!-- pr-readiness-gate -->`,
  `<!-- commit-hygiene-gate -->`. Keeping them avoids orphaning existing scorecard
  comments, and each names its gate, not the product.

## Considered options

Keeping "quality-gate" was rejected: the docs already reach for "repo-contract"
and "commit-contract" for the baseline, so the repo name fought its own prose.

A config filename tracking the repo name (`.repo-contract.json` chosen anyway) or
one named purely for content (`.contract.json`) were both considered. The bare
`.contract.json` was rejected for colliding with API-contract and Pact tooling in
repos that do such work; `.repo-contract.json` disambiguates while still naming
the concept, so it survives a future repo rename on its own reading.

Splitting the repo was rejected (see above).

## Consequences

- **Supersedes ADR 0005's product-rename rejection.** ADR 0005 rejected renaming
  the whole product because the Action hosted an issue gate that genuinely checks
  issue quality. That reasoning is outweighed now that the product spans hooks,
  drift, and scaffolding, for which "quality-gate" was never accurate.
- **Consumers migrate in lockstep, no redirect, no fallback.** Each consumer
  updates its `uses:` slug and renames `.quality-gate.json` to `.repo-contract.json`
  in one commit; the reader accepts only the new filename. Because the owner
  controls every consumer, this is a coordinated sweep rather than a deprecation
  window.
- **The check context changes.** New runs report `repo-contract` instead of
  `quality-gate`. Historical check runs on merged PRs are unaffected and cannot be
  renamed; no branch protection requires the old context, so nothing deadlocks.
- **Existing scorecard comments are untouched**, since the comment markers are
  frozen.
