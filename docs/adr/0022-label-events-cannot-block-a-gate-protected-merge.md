# Label events cannot block a gate-protected merge, so the labels-at-creation rule stays prose

Issue #114 asked whether the global agent rule "set every label at PR creation"
deserves enforcement: a `PreToolUse` guard blocking `gh pr edit --add-label`, or a
deterministic workflow-level mitigation that would retire the prose rule
entirely. The answer to both is no. The rule's stated harm (a label event cancels
an in-flight required run and deadlocks branch protection at
`mergeable_state: blocked` on a stale `cancelled` check-run) cannot occur on
these gates, so there is nothing here to guard and no workflow change to make.

Issue #115 settled it by measurement rather than reasoning: six configuration
variants run side by side as distinct required contexts, protected and
unprotected, in a throwaway repo. Two mechanical facts about GitHub account for
every outcome.

- **A `skipped` required check-run is treated as passing.** A label event that
  triggers a job whose `if:` filter skips does write a fresh `skipped` check-run,
  and it does become the latest for its context, overwriting a green `success`.
  `mergeStateStatus` stays `CLEAN` regardless, protected and unprotected. The
  feared skipped-overwrite deadlock does not exist.
- **A `cancelled` required check-run is treated as non-passing, but only while it
  remains the latest.** Isolated with `gh run cancel` and nothing superseding it,
  a lone `cancelled` context does block the merge. In a real label race the
  joining label event's own run reports a `skipped` check-run that supersedes the
  `cancelled` one, so it never remains latest and the merge settles `CLEAN`
  anyway.

The gates carry `cancel-in-progress: false` (ADR
[0009](0009-serialise-gate-runs-instead-of-cancelling.md)) and therefore never
cancel a run at all, which forecloses the only branch-protection `BLOCKED` mode a
label event could otherwise produce. The harm the racy `cancel-in-progress: true`
did cause is the one ADR 0009 already named, a **dropped verdict**, and it was
confirmed here on the issue gate, where the label _is_ the verdict: an incidental
creation label cancels the validating run and no `issue-quality:*` label is ever
written. On the two PR gates the verdict is the check-run and the label a
cosmetic echo, so a label event cannot leave a required context blocking there
under any variant measured.

## Considered options

- **Keep the rule as unenforced prose, scoped (chosen).** It names a real
  mechanism, the `cancelled`-stays-latest finding above, and stays useful as
  general advice for `cancel-in-progress: true` CI. What it needs is a scope
  caveat, not a guard: it does not apply to these gates, and even under
  `cancel:true` the incidental-label case produces a superseding `skipped` rather
  than a persistent `cancelled`. The rule is tier-1 agent prose, so that
  correction belongs in the dotfiles repo, not here.
- **A `PreToolUse` guard blocking `gh pr edit --add-label`.** Rejected on the
  evidence that motivated #114's "do not enforce an unverified rule" framing. The
  mechanism does not hold for the repos this guard would fire in most often, and
  a machine-global agent hook cannot see whether a given target repo's workflows
  cancel, so it would either block a safe operation everywhere or need per-repo
  knowledge it has no way to hold. Enforcement is warranted by a defect, and
  there is none to point at.
- **Drop the label trigger on the two PR gates.** Measured to work: `override:*`
  and manual `pr-readiness:*` edits get honoured by the next `edited` content
  event instead. Rejected because it loses the self-heal of those edits while
  buying no merge safety, since a label event cannot leave a required PR context
  blocking in the first place.
- **Split label events into their own concurrency group, or remove concurrency
  entirely.** Re-measured and re-rejected for the reason ADR 0009's third option
  already gave: both avoid the cancellation and reintroduce the content/label
  race on the label the gate is writing.

## Consequences

- **ADR 0009 is confirmed, not superseded.** No workflow change followed #114 or
  #115, and its appended note points here for the measurement.
- **Serialization on the PR gates rests on self-heal, not merge safety.** The
  merge-safety argument for `cancel-in-progress: false` holds on the issue gate,
  where a dropped run means a dropped verdict. Anyone revisiting the PR gates'
  concurrency should weigh it as the consistency and self-heal choice it is.
- **Two GitHub platform behaviours are now load-bearing.** That `skipped` reads
  as passing and that supersession decides which check-run branch protection
  sees are facts about GitHub, not properties this repo controls, and a change to
  either would be silent. They are cited to their trials so a future
  contradiction is re-measurable rather than re-argued.
- **The raw evidence lives in issue #115.** The full variant matrix, `gh` JSON,
  and per-trial outcomes are recorded there; the throwaway repo they ran in was
  deleted once this verdict was recorded.
