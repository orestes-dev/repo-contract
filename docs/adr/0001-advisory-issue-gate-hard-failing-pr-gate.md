# Advisory issue gate, hard-failing PR gate

The issue gate communicates only through labels and a scorecard and never fails
CI, because GitHub cannot block issue creation: a gate that cannot stop the thing
it judges gains nothing from a red check. The PR gate evaluates an object whose
merge CI _can_ be blocked, so it hard-fails instead: any error (no ready linked
issue, a missing required section, a non-conventional title) turns the check red
and blocks merge, while warnings stay green. We accept the resulting asymmetry,
two gates in one project with opposite enforcement postures, because it follows
from the objects rather than from taste: enforcement lives where it can actually
prevent the unwanted state.

## Consequences

- Tools and reviewers reading a PR rely on the **check status** as the
  merge-blocking signal; the `pr-readiness:*` labels and the scorecard comment are
  explanatory, not the gate itself.
- The only human bypass is the `override:pr-readiness` label plus a written
  `## Override rationale` section, mirroring the issue override. Bot-authored PRs
  (actor ends in `[bot]`) auto-pass, since no human is present to apply an
  override to, for example, a Dependabot bump.
