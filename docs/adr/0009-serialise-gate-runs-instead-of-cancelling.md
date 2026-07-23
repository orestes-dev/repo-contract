# Serialize gate runs instead of cancelling

The three vendored gate workflows (`templates/workflow/issue-quality.yml`,
`pr-readiness.yml`, `commit-hygiene.yml`) each serialize per object with a
`concurrency` group keyed on the issue or PR number, so rapid edits cannot race
on the label or double-post the checklist comment. They also carry a job-level
`if:` that runs on content events (`opened`/`edited`/`reopened`/`synchronize`)
but on a label event only when a human touches a gate-relevant label: the
`override:*` toggle, or the gate's own `*:{failing,warning,pass}` namespace, so
the gate never re-triggers on its own label writes.

Paired with `cancel-in-progress: true`, those two properties combined badly.
Creating an object with an incidental (non-gate) label in one command, the
routine `gh issue create --label area:infra`, fires `opened` and `labeled`
into the same concurrency group within seconds. The `opened` run passes `if:`
and starts validating; the `labeled` run joins the group and `cancel-in-progress`
**cancels the validating run**, while the `labeled` run's own `if:` is false
(the label is not gate-relevant) and it **skips**. Nothing validated, no
`*:{failing,warning,pass}` label written. Because `skipped` is neutral, the PR's
`mergeStateStatus` stays `CLEAN` rather than deadlocking, so the failure is
silent: the gate looks like it simply has not run, and any PR that closes such
an issue fails the transitive linked-issue readiness check. The race is
nondeterministic on event ordering: `orestes-dev/food#811` lost and got no
label; `second-brain#738` won with byte-identical workflows.

The fix flips `cancel-in-progress` to `false` in all three templates (and their
dogfood mirrors in `.github/workflows/`, which the drift tests hold in lock-step
on trigger, permissions, concurrency, and filter). Serialization per object is
preserved: the concurrency group is unchanged and only one run executes at a
time, but a joining run no longer cancels the run in flight. It queues behind
it and drains in order. The incidental-label run still skips on its false `if:`,
but only after the validating `opened` run has run to completion and written the
verdict. A run that will skip can no longer kill a run that would work.

## Considered options

- **Serialize instead of cancel (`cancel-in-progress: false`).** Chosen. It
  targets the exact defect named in the issue: `cancel-in-progress: true` let a
  skipping run cancel a validating one. Queue-and-drain keeps per-object
  serialization intact and never drops a verdict, because the validating run
  always completes before the skipping run starts. It is safe against rapid
  edits because `run()` is idempotent (it updates the single checklist comment
  and re-sets the label), so serial redundant runs converge on the last-writer
  state without double-posting or corrupting the label. GitHub keeps only the
  newest pending run per group, so a burst of edits does not pile up unbounded:
  intermediate pending runs are superseded, the in-flight run is never touched.
- **Broaden the `if:` so a surviving label-event run does the validation.**
  Rejected. Keeping `cancel-in-progress: true` and letting the incidental
  `labeled` run pass `if:` and do the work makes correctness depend on the
  cancelling run being the one that validates, which is exactly the fragile
  coupling that produced the race. It also widens the trigger surface: every
  human label event would run the full gate, and the self-loop protection now
  leans entirely on the bot-sender check rather than on the label filter plus
  GitHub's own suppression of `GITHUB_TOKEN`-triggered events. The `if:` filter
  is deliberate and stays; the fix belongs in the concurrency interaction, not
  the skip guard.
- **Put label events in a separate concurrency group from content events.**
  Rejected. It removes the cross-event cancellation but also removes the
  serialization between a content run and a label run on the same object, so a
  self-heal relabel and a body edit could execute concurrently and race on the
  label the gate is trying to write, trading one race for another. A single
  group with `cancel-in-progress: false` keeps every run on one object strictly
  ordered.

## Consequences

- **A gate label is always written.** An object created with incidental labels
  in one command carries the gate's real verdict with no further interaction,
  and PRs closing such issues clear the transitive readiness check.
- **Slightly more runs per object.** Without cancellation, superseded content
  edits are no longer aborted early; each queued run executes. `run()` is
  diff-based and idempotent, so the extra runs are no-ops on the final state,
  but the workflow-run list is longer. This is the cost of never dropping a
  verdict, and it is the intended trade.
- **Every property the `if:` filter guaranteed is preserved.** The gate still
  does not loop on its own label writes (unchanged filter plus bot-sender
  check), `override:*` still short-circuits, and a hand-removed gate label still
  self-heals.
- **Opted-in consumers must re-vendor.** The change ships in the `templates/`
  bundle that `init` copies; opted-in repos pick it up by re-running
  `init --force`, with the git diff as the audit trail (ADR 0003, ADR 0007).
  Until they do, they keep the racy `cancel-in-progress: true`.

## Evidence (2026-07-23, issue #115)

This decision was reasoned only about a label present at creation
(`opened`+`labeled`). It was later challenged by the possibility that a label
added to an already-open PR whose required checks are already green (the
`gh pr edit --add-label` case) writes a fresh `skipped` check-run that overwrites
the green one and deadlocks branch protection. #115 ran the full config matrix
(six variants side-by-side as distinct required contexts, protected and
unprotected) in a throwaway repo to settle it on evidence. The decision is
**confirmed and kept**, and no workflow change followed. Two mechanical facts
account for every outcome:

- **A `skipped` required check-run is treated as passing by branch protection.**
  A label event that triggers a skip-variant does write a fresh `skipped`
  check-run that becomes the latest for its context, overwriting the green
  `success`, yet `mergeStateStatus` stays `CLEAN`, protected and unprotected.
  The feared skipped-overwrite deadlock does not exist.
- **A `cancelled` required check-run, if it remains the latest, is treated as
  non-passing (`BLOCKED`).** Isolated with `gh run cancel` and nothing
  superseding it, a lone `cancelled` context does block the merge. In a real
  label race, however, the joining label event's own run reports a `skipped`
  check-run that _supersedes_ the `cancelled` one, so it never remains latest and
  the merge settles `CLEAN` anyway.

The consequence for this decision is stronger than "verdict preserved":
`cancel-in-progress: false` never cancels a run, so the one branch-protection
`BLOCKED` mode a label event could otherwise produce (a stale `cancelled`
required check) cannot arise from these gates at all. The harm the racy
`cancel-in-progress: true` actually caused is the one this ADR already named,
a **dropped verdict**: silent `CLEAN`, failing the transitive linked-issue
check. That was confirmed here on the issue gate, where the label _is_ the
verdict. An incidental creation label under `cancel:true` cancels the validating
run and the verdict label is never written, while the serial variant drains and
writes it. On the two PR gates the verdict is the CI check-run and the label is a
cosmetic echo, so a label event can never leave a required context blocking.
Serial is kept there too for consistency and to keep manual `pr-readiness:*` and
`override:*` edits self-healing, not because merge safety demands it. Dropping the
label trigger on the PR gates (honouring overrides via the next `edited` content
event instead) was measured to work but loses that self-heal, so it was not
adopted. Splitting label events into their own concurrency group, or removing
concurrency entirely, was re-measured and re-rejected: both avoid the
cancellation but re-introduce the content/label concurrency this ADR's third
rejected option already called out.

The global agent-prose rule ("set every label at PR creation ... a label event
... deadlocks branch protection at `mergeable_state: blocked` on a stale
cancelled check-run") describes a real mechanism, the `cancelled`-stays-latest
`BLOCKED` finding above, and stays as general advice for `cancel:true` CI. Its
scope needs a caveat: it does not apply to these gates, which never cancel after
this ADR, and even under `cancel:true` the incidental-label case produces a
superseding `skipped` run rather than a persistent `cancelled` one. That
correction lives in the dotfiles repo, not here.

Full matrix, raw `gh` JSON, and per-trial outcomes: issue #115 and the throwaway
repo `orestes-dev/gate-label-experiment-20260723-184613` (deleted once #114's
verdict is recorded).
