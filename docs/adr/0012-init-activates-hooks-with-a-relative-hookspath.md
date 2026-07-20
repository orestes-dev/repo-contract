# `init` activates the vendored hooks with a relative `core.hooksPath`

Vendoring a hook file guarantees only that it _can_ run. Git runs it only when
`core.hooksPath` points at the directory holding it and the file is executable.
Until now `init` wrote `.husky/commit-msg` and `.husky/pre-commit` and stopped
there, delegating activation to husky's `prepare` script at package-manager
install time. Two audiences the hooks explicitly claim to cover never reach that
step: a fresh clone or linked worktree that commits before provisioning, and a
repo with no `package.json` at all. In both, git found nothing to run and the
commit landed with the baseline unenforced and nothing printed. The claim that a
committed hook "runs where `~/.dotfiles` is absent" was true about execution and
false about activation (issue #79; observed at orestes-dev/atlas-infra#24,
orestes/dotfiles#59, and repo-contract#75).

`init` now performs activation itself, in three parts:

- **It sets `core.hooksPath`.** After writing the files, `ensureHooksPath()` in
  `src/commands/init.js` sets the value, reporting `create` / `repair` / `ok` the
  way the file and label loops report. Where a repository exists and the config
  cannot be written, `init` exits non-zero with an explicit "the baseline is NOT
  enforced in this checkout" message: the whole point of the change is that
  inactive hooks stop being silent. Outside a repository it reports the step as
  skipped, prints the one command that activates them later, and leaves the exit
  code alone, since scaffolding a directory before `git init` is legitimate.
- **The value is relative (`.husky`), and an absolute one is repaired.**
  `core.hooksPath` lives in the shared `.git/config`, which every linked worktree
  reads. An absolute path therefore pins all of them to one fixed checkout's
  hooks, so a worktree on another branch silently ran a different branch's rules.
  Git resolves a relative value against the worktree root (it chdirs there before
  invoking a hook), so `.husky` makes each worktree run the hooks committed on
  its own branch.
- **It targets `.husky`, not husky's `.husky/_` shim, and writes the hooks
  executable.** The vendored hooks are executable POSIX `sh`, so git can exec
  them directly: no shim, no `node_modules`, no install step. The shim is
  gitignored and generated, which is exactly why it is missing in the failing
  cases. Mode is not part of the byte comparison that detects drift, so `init`
  re-asserts `0755` on every run, including on an `ok` file: git skips a
  non-executable hook with only a hint.

Husky is consequently no longer required to run the repo-contract hooks, and this
repo drops the dependency to prove it. The directory keeps its conventional
`.husky/` name (consumers, docs, and the `.husky/local/` chain all point there),
and a consumer that still runs husky keeps working: husky's shim delegates to the
same `.husky/<hook>` files. `init` will move such a repo's `core.hooksPath` off
`.husky/_` on its next run, which is the intended repair rather than a conflict.
Because husky's shim used to put `node_modules/.bin` on `PATH`, both hooks now do
that themselves before chaining to the tier-3 `.husky/local/` extension.

## What this does and does not guarantee

`core.hooksPath` is per-clone git config and is not committable: git deliberately
offers no way for a repository to activate its own hooks on clone, since that
would let a clone execute code unbidden. So the honest guarantee is:

- **One activation step per checkout**, `npx github:orestes-dev/repo-contract init`
  (or a bare `git config core.hooksPath .husky`), with no install, no
  `node_modules`, and no husky needed. That step is now legible and repeatable
  rather than a side effect of a package manager.
- **After it, every linked worktree of that clone is covered**, on the hooks
  committed to its own branch, with no further action.
- **A checkout where nobody ran it stays unenforced locally.** Nothing local can
  fix that. The un-bypassable backstop is the CI mirror: the commit-hygiene gate
  (`src/gates/commit.js`, `templates/workflow/commit-hygiene.yml`) checks the same
  rules over a PR's commits and diff, and hard-fails merge. Local hooks are the
  fast feedback; CI is the guarantee.

This supersedes the reading of "runs everywhere" that ADR 0007 and dotfiles ADR
0002 invited. Both should be read as: the hook _file_ travels with the repo and
depends on nothing but `sh`, `git`, and `jq`, so wherever it is activated it
works, including CI, containers, and worktrees. Activation is a separate, single,
loud step.

## Considered options

- **Commit husky's `.husky/_` shim so a clone has it.** Rejected: it is generated
  and gitignored by husky itself, so every `prepare` would rewrite files
  repo-contract claims to own byte-for-byte, and the drift check would flip
  between the two owners. It also would not help, since `core.hooksPath` still
  has to be set for git to look inside it.
- **Keep delegating to husky's `prepare`.** Rejected: that is the failure under
  investigation. It requires a package manager, a `package.json`, and an install
  the failing cases never run, and it sets the path as a side effect nobody sees.
- **Only document the manual `git config` step.** Rejected: it makes correct
  behavior depend on a human remembering, and leaves the absolute-path worktree
  hazard unrepaired. `init` already visits every consumer; activation belongs
  where the files are written.
- **Have the hooks self-check activation at run time.** Rejected as incoherent: a
  hook that git never invokes cannot report that git never invokes it.
- **Point `core.hooksPath` at `.husky/_` and generate the shim from `init`.**
  Rejected: it adds a generated indirection layer that buys nothing once the
  hooks are executable, and re-creates the husky ownership conflict above.

## Consequences

- `init` writes git config, not just files. It is no longer a pure scaffolder,
  and its failure mode inside a repository is a hard exit rather than a warning.
- Consumers still running husky see `core.hooksPath` move from `.husky/_` to
  `.husky` on the next `init`. Both resolve to the same hook files; a subsequent
  husky `prepare` moves it back, and the next `init` repairs it again. A consumer
  wanting the worktree-safe behavior permanently drops `prepare: husky`.
- `core.hooksPath` is single-valued, so the local value `init` writes displaces
  any global one for this repository, including the tier-1 agent-hygiene hooks in
  a contributor's dotfiles. That was already true of every husky repo; `init`
  makes it explicit and reports it, rather than leaving it a side effect of an
  install. A contributor wanting both keeps their tier-1 checks in
  `.husky/local/`, which the vendored hooks chain to.
- The vendored hooks are mode-`0755` files. A consumer whose tooling strips the
  executable bit gets it back on the next `init`, but between the two git will
  skip the hook with a hint, not an error.
- This repo has no husky dependency: its `prepare` script is
  `git config core.hooksPath .husky`, which is also the smallest possible example
  for a consumer that wants install-time activation as well.
- The regression tests in `src/hooks.test.js` drive real `git commit` calls in a
  shim-less repository and in a linked worktree on another branch. Testing the
  hook body with `sh -e` cannot catch an activation bug, since it invokes the
  hook that git would not.
