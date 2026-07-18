# Contributing

```sh
corepack enable && yarn install --immutable
yarn test
```

## Running the gate locally

```sh
# Validate an issue body file the way CI would; title optional
node bin/cli.js validate-issue path/to/body.md --title "feat(x): do the thing"

# Scaffold the repo-contract bundle into another repo (9 files): the Issue Form,
# the PR Form, the two Author guides, the three gate workflows (issue-quality,
# pr-readiness, commit-hygiene), and the two vendored git hooks (.husky/pre-commit,
# .husky/commit-msg). `--force` upgrades drifted copies in place.
node bin/cli.js init

# Backfill labels/scorecards across an existing backlog
# (credentials from `gh auth token`, repo from `gh repo view`)
node bin/cli.js sweep
```

## Why JavaScript, not TypeScript

Plain JS type-checked with `tsc` (`checkJs` + JSDoc) keeps the action buildless:
it runs straight from source, so consumers reference it at `@main` with no
compiled artifact to release, and no one is forced onto a Node version new
enough to strip types.

## Repo-contract git hooks

`init` vendors two committed husky hooks, [`.husky/pre-commit`](.husky/pre-commit)
(no default-branch commits, em-dash policy in staged Markdown) and
[`.husky/commit-msg`](.husky/commit-msg) (Conventional Commits subject, em-dash
policy). They are POSIX `sh` + `git` + `jq` only, never `node_modules`, so they
run before `yarn install` and where `~/.dotfiles` is absent (CI, containers,
fresh worktrees). quality-gate owns them byte-for-byte and drift-checks them
against [`templates/husky/`](templates/husky/); edit the template and re-run
`init --force`, never patch a vendored copy in place.

Each hook chains, as its last step, to an optional consumer-owned extension at
`.husky/local/<hook>` (for example `.husky/local/pre-commit` running
`yarn lint-staged`). This is where a repo adds its own tier-3 project checks
(lint-staged, gitleaks, build). `init` never writes `.husky/local/`, so it
survives `init --force`.

Enforcement opt-outs live in a committed [`.quality-gate.json`](src/config.js) at
the repo root (never per-machine `git config hooks.*`). Each opt-out under
`overrides.<key>` carries a `value` the hook keys off and a required `reason`
recorded as a data field, not a comment, so the hook can quote it verbatim when
the bypass triggers. The reader is [`src/config.js`](src/config.js); an absent
file means full enforcement with no opt-outs.

## Tests

`yarn test` runs the whole suite. Alongside the validator, action, sweep, and
commit-validator suites, [`src/hooks.test.js`](src/hooks.test.js) exercises the
vendored husky hooks (drift against the `templates/husky/` bundle, the
`.husky/local/*` chain, and `init`'s drop/repair) and
[`src/config.test.js`](src/config.test.js) covers the `.quality-gate.json`
reader.

## Conventions

Structure is owned by code: the ordered field descriptor in
[`src/rules.js`](src/rules.js) holds id, heading, order, type, required, options,
and constraints together, and the validator reads it directly. Nothing reads the
[Issue Form](.github/ISSUE_TEMPLATE/task.yml) at runtime; it and the Author guide
are drift-checked renderings of that source (see
[ADR 0003](docs/adr/0003-code-owned-structure-drift-checked-renderings.md)). Drift
tests pin those renderings, the [README](README.md)
against the rules, and each workflow's dogfood copy under
[`.github/workflows/`](.github/workflows/) against its template under
[`templates/workflow/`](templates/workflow/)
([`issue-quality.yml`](templates/workflow/issue-quality.yml),
[`pr-readiness.yml`](templates/workflow/pr-readiness.yml),
[`commit-hygiene.yml`](templates/workflow/commit-hygiene.yml)). When one fails,
update both sides in the same change.
