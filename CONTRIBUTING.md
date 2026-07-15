# Contributing

```sh
corepack enable && yarn install --immutable
yarn test
```

## Running the gate locally

```sh
# Validate an issue body file the way CI would; title optional
node bin/cli.js validate-issue path/to/body.md --title "feat(x): do the thing"

# Scaffold the Issue Form + workflow into another repo
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

## Conventions

Structure is read from the [Issue Form](.github/ISSUE_TEMPLATE/task.yml) at
runtime; rules it can't express live in [`src/rules.js`](src/rules.js), keyed 1:1
to the form fields. Drift tests pin that correspondence, the [README](README.md)
against the rules, and the two workflow files
([dogfood](.github/workflows/issue-quality.yml),
[template](templates/workflow.yml)) against each other. When one fails, update
both sides in the same change.
