# Scope and Decisions are required PR sections

The PR gate shipped with three sections: `Summary` and `Verification` (required
by presence) and `Divergence` (a flag-gated rationale). That set proves a PR
_happened_ and was _tested_, but says nothing about _where_ the change landed or
_what it decided_. Consumers whose own governance cares about those concerns had
nowhere in the shared PR body to declare them, so the concerns lived only in
repo-local checks (for example a monorepo's single-app-scope rule or an
ADR-required-on-decision-paths rule) with no matching author-facing section.

`PR_SECTIONS` now adds two required sections between `Verification` and
`Divergence`:

- **Scope**: the app, package, or area the PR touches, and the boundary the
  author kept it within. The gate checks presence only; a repo's own governance
  may still enforce the actual boundary from the diff.
- **Decisions**: the settled choices the PR makes and why, including any ADR
  added or followed. `None` is a valid, explicit answer.

Both mirror the issue gate's own `Decisions` and affected-files vocabulary, so a
PR and the issue it closes describe structure with the same words.

## Considered options

- **Add them as warning-level sections.** Rejected: warnings do not block merge,
  so a PR could land with no declared scope or decisions, which is exactly the
  gap this closes. The issue gate treats its `Decisions`/affected-files as
  warnings because issue creation cannot be blocked at all; the PR gate can
  hard-fail, so it should.
- **Leave the concerns to per-repo governance only.** Rejected: it keeps every
  consumer inventing its own scope/decision section, defeating the point of a
  shared PR structure. The diff-based enforcement can stay repo-local; the
  _authoring surface_ belongs in the shared schema.
- **Per-repo configuration of the section set.** Rejected: the gate is
  deliberately config-free so a label means the same thing in every repo
  (see `README.md` Notes). A fixed, larger section set preserves that.

## Consequences

- **A breaking schema change for consumers.** Every opted-in repo's existing PR
  bodies now fail the gate until they add `## Scope` and `## Decisions`. `init`
  ships the updated `templates/markdown/pr.md`; a consumer re-runs
  `init --force` to refresh its committed PR Form and Author guide.
- **The drift surface is unchanged in shape.** The two new sections are rendered
  in `templates/markdown/pr.md` (with `Required.` in their guidance) and copied
  byte-identical to `.github/PULL_REQUEST_TEMPLATE.md` and `.template.pr.md`;
  the existing drift tests pin them to `PR_SECTIONS` automatically.
- **Symmetry with the issue gate.** `Decisions` now appears on both sides,
  narrowing the vocabulary an author (human or LLM) has to hold in mind across
  an issue and its PR.
