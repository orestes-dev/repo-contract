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
