# Contributing

```sh
corepack enable && yarn install --immutable
yarn test
```

## Running the gate locally

```sh
# Validate an issue body file the way CI would; title optional
node bin/cli.js validate-issue path/to/body.md --title "feat(x): do the thing"

# Install repo-contract into another repo. On a terminal this prompts for which
# scaffolds to install; `--only` selects them without asking. All three (9 files)
# are the Issue Form, the PR Form, the two Author guides, the three gate workflows
# (issue-quality, pr-readiness, commit-hygiene), and the two vendored git hooks
# (.repo-contract/hooks/pre-commit, .repo-contract/hooks/commit-msg), whose
# activation sets core.hooksPath.
# `--force` upgrades drifted copies in place.
node bin/cli.js init
node bin/cli.js init --only git-hooks,commit-hygiene

# Backfill labels/scorecards across an existing backlog
# (credentials from `gh auth token`, repo from `gh repo view`)
node bin/cli.js sweep
```

## Why JavaScript, not TypeScript

Plain JS type-checked with `tsc` (`checkJs` + JSDoc) keeps the action buildless:
it runs straight from source, so consumers reference it at `@main` with no
compiled artifact to release, and no one is forced onto a Node version new
enough to strip types.

## Dependencies are budgeted per surface

The baseline is enforced on three execution surfaces, and each may assume a
different toolchain is already present (ADR
[0015](docs/adr/0015-commit-hooks-keep-the-sh-jq-dependency-budget.md)). The
**vendored git hooks** keep the strictest budget: POSIX `sh`, `git`, and `jq`,
never `node_modules`, because they run at commit time in checkouts that have not
been provisioned. The **CI gate** and the **CLI** are looser: both run node with
an install behind them.

`@clack/prompts`, which draws `init`'s scaffold prompt, is the CLI surface's first
runtime dependency and lives in [`src/prompt.js`](src/prompt.js) alone. It is
pinned to an exact version, not a range: `npx`-from-git resolves the CLI's
dependencies with no lockfile, so the pin is the only thing between a consumer and
whatever the range would float to on the day they run it. Adding a runtime
dependency to the hooks is not a judgement call to weigh; the budget forecloses
it.

## Repo-contract git hooks

`init` vendors two committed git hooks, [`.repo-contract/hooks/pre-commit`](.repo-contract/hooks/pre-commit)
(no default-branch commits, em-dash policy in staged Markdown) and
[`.repo-contract/hooks/commit-msg`](.repo-contract/hooks/commit-msg) (Conventional Commits subject, em-dash
policy). They are POSIX `sh` + `git` + `jq` only, never `node_modules`, so they
run before `yarn install` and where `~/.dotfiles` is absent (CI, containers,
fresh worktrees). repo-contract owns them byte-for-byte and drift-checks them
against [`templates/git-hooks/`](templates/git-hooks/); edit the template and re-run
`init --force`, never patch a vendored copy in place.

Git only runs them once `core.hooksPath` points at `.repo-contract/hooks`, which is per-clone
config no repository can commit, so **every fresh clone or worktree needs one
activation step**. `yarn install` does it here (the `prepare` script is
`git config core.hooksPath .repo-contract/hooks`), `node bin/cli.js init` does it
anywhere, and `git config core.hooksPath .repo-contract/hooks` does it with no tooling at all. The value must
stay relative: `core.hooksPath` is shared across linked worktrees, so an absolute
path makes every worktree run one fixed checkout's hooks. `init` repairs an
absolute value, and repairs a legacy `.husky`/`.husky/_` path too. There is no
husky dependency: the hooks are executable and git execs them directly
([ADR 0012](docs/adr/0012-init-activates-hooks-with-a-relative-hookspath.md),
[ADR 0017](docs/adr/0017-vendored-hooks-move-to-repo-contract-hooks.md)).
If a hook stops firing, check `git config core.hooksPath` first, then that
`.repo-contract/hooks/*` is still executable (git skips a non-executable hook with only a
hint).

Each hook chains, as its last step, to an optional consumer-owned extension at
`.repo-contract/hooks/local/<hook>` (for example
`.repo-contract/hooks/local/pre-commit` running
`yarn lint-staged`). This is where a repo adds its own tier-3 project checks
(lint-staged, gitleaks, build). `init` never writes `.repo-contract/hooks/local/`, so it
survives `init --force`.

Enforcement opt-outs live in a committed [`.repo-contract.json`](src/config.js) at
the repo root (never per-machine `git config hooks.*`). Each opt-out under
`overrides.<key>` carries a `value` the hook keys off and a required `reason`
recorded as a data field, not a comment, so the hook can quote it verbatim when
the bypass triggers. The reader is [`src/config.js`](src/config.js); an absent
file means full enforcement with no opt-outs.

## Labels

`init` owns the label schema: the three gate triples (`issue-quality:*`,
`pr-readiness:*`, `commit-hygiene:*`), the three override labels
(`override:issue-quality`, `override:pr-readiness`, `override:commit-hygiene`),
and `wontfix`. Each label belongs to a scaffold
([`src/scaffolds.js`](src/scaffolds.js)) and is reconciled only where that
scaffold is installed, so nothing appears in a repo's label list for a gate it
did not take. Every label's colour and description live in code
([`src/constants.js`](src/constants.js): `LABEL_META`, `PR_LABEL_META`,
`COMMIT_LABEL_META`, `OVERRIDE_LABEL_META`, `WONTFIX_LABEL_META`), so `init` can
both **create** any missing label and **reconcile** one whose colour or
description has drifted, reporting `created` / `repaired` / `ok` per label the
way it reports per file. The override labels are materialized here rather than
lazily: a gate run never applies one (a human does), so nothing would ever create
them on demand. `wontfix` is materialized for the same reason, and adopts
GitHub's own default colour and description so the reconcile is a no-op in a repo
that never recoloured it.

The label step discovers credentials and repo context the way `sweep` does
(`gh auth token`, `gh repo view`), but softly: with no credentials or repo it is
reported as skipped and the file scaffolding still succeeds.

### Renaming a gate label

A rename is a deliberate, multi-repo procedure, not something made safe
automatically. The label strings are duplicated into
[`templates/workflow/*.yml`](templates/workflow/), which consumers copy once
while pinning the Action `@main`; a rename reaches the Action everywhere but
never the consumers' `if:` conditions, and that fails open silently (the workflow
just stops triggering on the override toggle, with no error). To rename one:

1. Change the string in [`src/constants.js`](src/constants.js), and in
   `templates/workflow/*.yml` wherever it is named.
2. Find the consumers: `gh search code "orestes-dev/repo-contract@main" --owner orestes-dev`.
   The code-search index lags, so also check any repo carrying
   `.github/workflows/issue-quality.yml`, `pr-readiness.yml`, or
   `commit-hygiene.yml`. Known consumers today: `orestes-dev/second-brain`,
   `orestes-dev/food`.
3. In each consumer: `gh label edit <old> --name <new>` (renaming preserves the
   label on every object carrying it, so there is no migration), then
   `npx github:orestes-dev/repo-contract init --force` to refresh the copied
   workflows, then commit.
4. Verify the override toggle still triggers a run in each consumer. Nothing will
   tell you if it does not.

## Tests

`yarn test` runs the whole suite. Alongside the validator, action, sweep, and
commit-validator suites, [`src/hooks.test.js`](src/hooks.test.js) exercises the
vendored git hooks (drift against the `templates/git-hooks/` bundle,
the `.repo-contract/hooks/local/*` chain, `init`'s drop/repair, and the activation regressions that
drive a real `git commit` in a never-installed checkout and in a linked worktree)
and
[`src/config.test.js`](src/config.test.js) covers the `.repo-contract.json`
reader.

## Architecture decisions

Decisions live in [`docs/adr/`](docs/adr/), numbered and dated. When a later
session **revises** one, amend that ADR in place rather than writing a superseding
one, and move the reading you abandoned into its Considered options so amending
costs no reasoning. A consolidation of the set into one revised, non-conflicting
document per decision is planned, and a supersession chain is exactly what that
consolidation would have to unwind: two ADRs disagreeing about the same decision
is the state it exists to remove.

This is not a licence to rewrite history. An ADR whose decision still stands takes
an appended note when new evidence arrives (see
[ADR 0009](docs/adr/0009-serialise-gate-runs-instead-of-cancelling.md)); only a
decision that was actually reversed gets amended, and the reversal is legible in
git and in the Considered options either way.

## Writing a glossary entry

[`CONTEXT.md`](CONTEXT.md) is the domain glossary, and two principles decide what
belongs in an entry. Author against them rather than by imitating the longest
neighbour; an entry a reader wades through stops being consulted, and prose that
narrates an implementation goes stale silently, because no drift test covers it.

**The recoverability test.** A sentence earns its place only if a reader with the
codebase **and this repo's own docs** open could not recover it. Names of
functions and fields stay only where they are the term's canonical handle
(`core.hooksPath` **is** the vocabulary), never as narration of how the code is
arranged. The deliberate overlaps that Accepted duplication covers are unaffected;
the target is a glossary entry paraphrasing prose the README or this file already
carries.

**The ownership split.** `CONTEXT.md` owns what a word means and what it is not.
ADRs own why this option beat that one. Code owns how, and "how" is runtime
behaviour as much as code structure: what the tool does, in what order, at which
moment, is the README's and `--help`'s, not a glossary entry's. An entry that
argues links to its ADR; an entry that enumerates points at the code. An entry
that exists only to describe a code artifact, with no vocabulary dispute and no
boundary to guard, does not belong at all.

The ownership split is mechanical enough to check sentence by sentence: **the
subject of a glossary sentence is the term, and its verb is a copula.** When the
subject becomes a tool and the verb an action it performs, you have started
writing the manual. Try rewriting the sentence as _X is / is not Y_. If it
survives the rewrite, it was vocabulary wearing a verb, so keep the rewrite and
drop the verb. If it can only be said as _the tool does Z_, it belongs in the
README.

Behaviour earns a place only where it **is** the distinction, so that deleting it
collapses the term into a neighbour: "vendoring buys execution, never activation"
is the whole of why **Hook activation** has a name. Worked examples of the failing
side:

| Behaviour sentence                                                                          | Rewritten as vocabulary                                                                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `init` never writes the local chain, so it survives the repair that rewrites a drifted hook | The chain is consumer-owned, so it sits outside what repo-contract writes, reconciles, or repairs             |
| `init` reports the activation gap per context and never repairs it                          | Activation lives in per-repo settings, so it is the operator's to set and never a vendoring tool's to deliver |
| The pre-commit hook scans staged Markdown; the commit-msg hook reads the message            | (cut: the rule's scope is already stated, and where each half runs is the code's)                             |

A flag, an exit code, or an invocation is this test applied to CLI nouns: a
subcommand named as the actor of a rule can be vocabulary, but `--help` owns the
rest, and a glossary copy of it goes stale unnoticed.

Three kinds of sentence survive regardless, because code cannot carry them: the
boundary a term guards (what it is **not**, and the collision a qualified name
exists to prevent), the `_Avoid_` synonyms, and consequential asymmetries a reader
would otherwise infer wrongly (an absent `scaffolds` key means none installed, not
all-in). There is no length ceiling and no lint: a mechanical proxy would be
satisfied by splitting one long entry into two.

## Conventions

Structure is owned by code: the ordered field descriptor in
[`src/rules.js`](src/rules.js) holds id, heading, order, type, required, options,
and constraints together, and the validator reads it directly. Nothing reads the
[Issue Form](.github/ISSUE_TEMPLATE/task.yml) at runtime; it and the Author guide
are drift-checked renderings of that source (see
[ADR 0003](docs/adr/0003-code-owned-structure-drift-checked-renderings.md)). Drift
tests pin those renderings and the [README](README.md) against the rules. A
separate table-driven test ([`src/scaffolds.test.js`](src/scaffolds.test.js))
walks `SCAFFOLDS[].files` and asserts every installed destination in this repo,
Forms, Author guides, workflows, and hooks alike, is byte-identical to its
`templates/` source. Edit the template, never the installed copy, and re-run
`node bin/cli.js init` to apply it. When a drift test fails, update both sides in
the same change.
