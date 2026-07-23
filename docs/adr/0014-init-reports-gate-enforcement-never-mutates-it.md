# `init` reports missing gate enforcement and never repairs it

> **Path note:** the hook directory is now `.repo-contract/hooks` and the
> bundle `templates/git-hooks/`, per
> [ADR 0017](0017-vendored-hooks-move-to-repo-contract-hooks.md). Every `.husky`
> path below reads as its `.repo-contract/hooks` equivalent; nothing else in this
> ADR is affected.

Vendoring a gate workflow buys the check **running**. It does not buy the check
**blocking**. What blocks a merge is a required-status-check rule on the default
branch, which lives in repository settings that nothing in a repository can
commit.

This is the same split ADR 0012 drew for hooks, one layer up. There, a vendored
hook file is execution and `core.hooksPath` is activation; a file sitting in
`.husky/` guarantees nothing until a per-clone setting points git at it. Here, a
vendored workflow is execution and the required-status-check rule is activation; a
gate that runs on every PR guarantees nothing until a per-repo setting makes its
verdict binding. In both cases `init` ships the carrier and cannot ship the
enforcement, and in both cases the gap is silent.

The gap was not theoretical. A fleet audit found the PR gate, documented as
merge-blocking, was **enforced in zero of five repositories**, including this one.
Three default branches had no protection of any kind. That is why
`orestes/dotfiles#84` could merge carrying `pr-readiness:failing`: the gate had
correctly graded nothing, and even a correct failing grade would not have stopped
the merge. The tool that exists to kill silent drift could not see its own.

## `init` reports the gap, as one line

`init` already holds a `gh` session and repo context (it reconciles labels over
them), and it already prints a per-file, per-label reconciliation report. Detecting
enforcement is one more read on that same session, so `init` gains a final
**Protection** line: it reads the default branch's required contexts from **both**
mechanisms GitHub offers (classic branch protection and rulesets, which compose)
and reports whether the merge-blocking gate's `pr-readiness` context is among them.

The read distinguishes five cases, because the ways this can be wrong are not
interchangeable:

| Case            | Meaning                                             | Reported |
| --------------- | --------------------------------------------------- | -------- |
| `required`      | the gate's context is required; enforcement is real | ok       |
| `not-required`  | the branch is protected, but not on this context    | warn     |
| `unprotected`   | the branch has no protection or ruleset at all      | warn     |
| `not-installed` | no `pr-readiness*.yml` vendored; nothing to require | ok       |
| `unreadable`    | a 403 hid the answer                                | ok       |

`unreadable` earns its place: reading branch protection needs admin scope, so
collapsing a 403 into `not-required` would tell every contributor without it that
their gate is unenforced. A read failure is not evidence of a missing rule, and a
checker that cries wolf in the repos an operator cannot fix from their seat gets
ignored everywhere else.

The report never changes `init`'s exit code. Missing enforcement is a
repository-settings fact, not an `init` failure, and `init`'s exit code already
means "were the files and labels reconciled". Folding a settings verdict into it
would conflate two unrelated questions.

## It reports, and stops

It never writes. `init` does not gain the ability to configure protection.

The asymmetry of the mistakes decides this. `init` is routine and run
half-attentively across the fleet; giving that command admin scope over five
default branches risks locking all of them. A bad label reconcile is a one-second
undo. A bad ruleset is not: it can wedge every open PR at once, and unwedging it
needs the same admin access that caused it. Requiring a check is also a genuinely
deliberate act with a precondition a tool cannot judge (requiring a context that
is currently red blocks every open PR immediately), so the report prints the
condition and leaves the decision with a human.

Detection was the missing half. Automated mutation was never the missing half.

## Why a line in `init`, not a standalone command

An earlier draft shipped this as a separate `verify-protection` CLI command with
its own exit codes. It was dropped before landing. Branch protection is set once
per repo and does not drift the way vendored files do, so a standalone drift
_detector_ over-fits the problem: the valuable finding (0/5 enforced) came from a
one-time audit, not from anything that needs re-running on a schedule. The moment
enforcement matters is the moment an operator vendors or re-vendors the gate, which
is exactly when they run `init`. Reporting there reaches the operator at the one
point the answer is actionable, adds no new CLI surface to keep documented, and
reuses the `gh` session `init` already opened.

## Considered options

- **A standalone `verify-protection` command with exit codes.** Rejected: a
  permanent command for a one-time setup check, whose one real finding came from
  an audit, not from recurring drift. It also had to invent three distinct
  meanings for exit 0 (required, not-installed, unreadable), a sign it had not
  decided whether it was a binary check or a human report.
- **Have `init` require the context automatically.** Rejected: admin scope on a
  routine command, against a setting that is irreversible in practice within one
  session, with a precondition (is the gate green?) a tool cannot judge.
- **Ship it as a scheduled workflow that opens an issue on drift.** Rejected: it
  is another vendored file to keep in lock-step across the fleet, and its own
  enforcement would depend on the settings it is auditing.
- **Check every gate's context, not just the merge-blocking one.** Rejected for
  now: the issue gate runs on issues, which have no merge to block, and
  commit-hygiene is opt-in per repo. Only `pr-readiness` claims to block merge, so
  only it can be wrong about it.
- **Report `unreadable` as a failure.** Rejected: it converts a permissions
  boundary into a false verdict.

## Consequences

- `init` warns in most repos today. That is the finding, not a defect, and it
  resolves as each default branch is configured. The warning never fails `init`.
- The read needs admin scope to be conclusive. Without it the line is `unreadable`
  and honest, rather than absent or wrong.
- Enforcement remains a manual, per-repo act. `init` now makes its absence loud at
  the moment an operator is already configuring the repo, which is the guarantee
  actually on offer, exactly as ADR 0012 landed for hook activation.
- `GitHub` gains two read-only methods (`getDefaultBranch`,
  `getRequiredStatusChecks`), and `src/protection.js` holds the verdict logic.
  Nothing on that path writes.
