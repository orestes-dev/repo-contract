# PR gate labels and scorecard use the `pr-readiness` namespace

The PR gate never reads the diff. It checks PR metadata (title is conventional,
the required body sections are present and non-empty) and linked-issue readiness
(every same-repo issue the PR closes is itself ready). "Quality" overstated that:
it reads as a judgement on the code, which the gate never makes. "Readiness" is
what it actually decides, and it already names the sibling issue property in
CONTEXT.md, so the label now matches the concept.

The labels are `pr-readiness:pass` / `pr-readiness:warning` / `pr-readiness:failing`,
the override is `override:pr-readiness`, the scorecard heading is "PR Readiness
Checklist", the comment marker is `<!-- pr-readiness-gate -->`, and the consumer
workflow is `pr-readiness.yml`.

## Considered options

Renaming the whole product (`quality-gate` the Action and repo) was rejected: the
Action hosts both gates, and the issue gate genuinely checks issue *quality*
(structure, completeness). Only the PR gate's user-facing namespace moves.

Renaming the Actions job (`quality-gate`), and therefore the emitted check
context, was rejected: the check is the shared Action's contribution and is named
for it, not for either gate. It is not a required status check in the consumer
repos, so there was nothing to gain from churning it.

Keeping "quality" for symmetry with the issue gate was rejected: symmetry with a
misleading name is not a virtue. The issue gate keeps `issue-quality` because that
name is accurate for it.

## Consequences

- **The label namespace is a breaking change for consumers.** Since consumers pin
  `@main`, the next gate run writes `pr-readiness:*` and leaves any old
  `pr-quality:*` labels orphaned until deleted. Consumer queries and branch-config
  that referenced the old namespace must move in lockstep. Only two consumers
  exist (this repo's dogfood and `orestes-dev/food`), and the check context is
  unchanged, so no branch-protection required-check breaks.
- **The comment marker changed**, so on a PR that already carried the old
  scorecard the gate posts a fresh comment rather than updating the old one; the
  stale one can be deleted by hand. New PRs are unaffected.
- **The issue gate is untouched**: `issue-quality:*`, `override:issue-quality`,
  and "Issue Quality Checklist" stay, because the name is correct there.
