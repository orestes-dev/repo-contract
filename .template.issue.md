<!--
Issue Author guide. This is the LLM-facing companion to the GitHub Issue Form
(.github/ISSUE_TEMPLATE/task.yml): a section per field with the examples, voice,
and guidance the YAML form cannot carry. Follow it to draft an issue body, then
paste the filled sections (from `### Context` down) as the issue.

GitHub ignores this file: `.template.issue.md` is not a reserved template path,
so it never appears in the new-issue chooser. Only its headings and their order
are pinned to src/rules.js by a drift test; the prose below is free to be as
rich as it needs to be. Edit the guidance here without touching the gate.

Title (issue metadata, not a body section): use Conventional Commits,
`type(scope): summary`, e.g. `feat(search): debounce the query input`. The gate
rejects a title that does not open with a known type. It maps the issue cleanly
onto the eventual branch and commit.
-->

### Context

What needs to happen and why, in enough detail that someone with no prior
context can act on it. State the problem and the desired end state, not a
proposed implementation. Include the concrete artifacts an implementer would
otherwise have to invent or guess: sample payloads, schemas, error messages,
function or API signatures, the file where the behavior lives today.

Aim for substance over length. A few tight sentences that pin down the goal beat
a page of background. This is the one field with a hard floor (too short is a
hard error) and a soft ceiling (very long raises a warning, as a fluff
detector): say what matters and stop.

Example:

> The dashboard refetches every record on each keystroke in the search box,
> which is slow for large accounts (~2s per keypress at 10k rows). We want the
> query debounced so typing stays responsive and only one request fires once
> the user pauses. The handler is `onQueryChange` in `src/search.js`.

### Acceptance Criteria

A markdown checklist of verifiable outcomes, at least one item, each one
objectively checkable by someone who did not write the issue. Prefer observable
behavior ("no request fires until typing pauses for 300ms") over implementation
steps ("add a debounce call"). Fold verification and non-functional
requirements (tests, docs, performance, security, accessibility,
backward-compatibility) in as their own checkable items where they apply.

A bare `- [ ]` with no text does not count; every item needs content.

```md
- [ ] Input is debounced to 300ms before a request fires
- [ ] No refetch fires until typing pauses
- [ ] Existing search tests still pass and one covers the debounce
```

### Out of Scope

The explicit non-goals: what this task deliberately does not include. This is
what forces the work down to a single landable slice, so name the tempting
adjacent changes you are choosing not to make.

```md
- Redesigning the search UI or results layout
- Changing the underlying query or data model
- Caching results across searches
```

### Decisions

Settled choices from planning or a grill, each with the rationale that settled
it. These are constraints the implementer must respect, not a menu of options
and not a proposed approach. One decision per line. Optional, but leaving it
blank raises a warning: if choices were made, record them so nobody relitigates
them or guesses wrong.

```md
- Debounce, not throttle: a trailing-edge fetch matches user intent.
- Reuse the existing request cache rather than add a new layer.
```

### Affected files / entry points

The files, modules, or symbols the work will likely touch, so whoever picks it
up does not have to search for them. A path plus the relevant symbol is ideal.
Optional, but leaving it blank raises a warning: it is cheap orientation you
already have and the implementer does not.

```md
- src/search.js: onQueryChange()
- src/api/records.js: fetchRecords()
```

### Depends on

Prerequisite issues or a required merge order, if any. Leave blank when the work
stands alone; unlike Decisions and Affected files, an empty Depends on is
silent, not a warning, because most issues have no prerequisites.

```md
- #123 must merge first (the schema refactor this builds on)
```

### Size

One of `XS`, `S`, `M`, `L`, `XL`. This is the estimated size of the single
slice. `L` and `XL` are a hard error: they are too big to land as one issue, so
split them into smaller issues that each stand on their own. If you cannot get
below `M`, the scope is still too wide; look at Out of Scope again.

```md
S
```
