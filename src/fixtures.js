// Shared test fixtures. Imported only by *.test.js, never by production code.
// A single canonical "good issue" body keeps the three test suites from drifting
// apart; each derives its own failing/override variants from it.

/** A complete, well-formed issue body that passes every check. */
export const goodBody = [
  "### Context",
  "",
  "The dashboard refetches everything on every keystroke, which is slow. We want it debounced so typing stays responsive.",
  "",
  "### Acceptance Criteria",
  "",
  "- [ ] Input is debounced to 300ms",
  "- [ ] No refetch fires until typing pauses",
  "",
  "### Out of Scope",
  "",
  "- Redesigning the search UI",
  "",
  "### Decisions",
  "",
  "- Debounce, not throttle: trailing-edge fetch matches user intent.",
  "",
  "### Affected files / entry points",
  "",
  "- src/search.js: onQueryChange()",
  "",
  "### Size",
  "",
  "S",
  "",
].join("\n");
