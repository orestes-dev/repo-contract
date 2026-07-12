# Contributing

```sh
corepack enable && yarn install --immutable
yarn test
```

## Running the gate locally

```sh
# Validate an issue body file the way CI would; title optional
node bin/cli.js validate path/to/body.md --title "feat(x): do the thing"

# Scaffold the Issue Form + workflow into another repo
node bin/cli.js init

# Backfill labels/scorecards across an existing backlog
# (reads credentials from `gh auth token`, repo from `gh repo view`)
node bin/cli.js sweep
```

## Why JavaScript, not TypeScript

The source is plain JavaScript, type-checked with `tsc` (`checkJs` + JSDoc)
rather than written in TypeScript. This keeps the action buildless: it runs
straight from source, so consumers can reference it at `@main` and pick up
changes with no compiled artifact to publish. Adding a build step would mean
tagging and releasing a built version on every change, which is exactly the
overhead this design avoids.

## Conventions

Structure is read from the Issue Form at runtime; rules the form can't express
live in `src/rules.js`, keyed 1:1 to the form fields. Drift tests pin that
correspondence, the README against the rules, and the two workflow files against
each other. When one fails, update both sides in the same change.
