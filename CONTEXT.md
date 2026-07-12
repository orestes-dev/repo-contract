# Issue Quality Gate

A deterministic gate that labels every GitHub issue as passing, warning, or failing against a structural quality bar, and posts a scorecard explaining the outcome. It exists so issues land well-scoped and actionable before anyone picks them up.

## Language

**Issue Form**:
The GitHub YAML template (`.github/ISSUE_TEMPLATE/task.yml`) an author fills in to open an issue. The single source of truth for issue **structure**.
_Avoid_: Template (ambiguous with workflow template), schema.

**Structure**:
The set of **fields** an issue must contain and their shape: each field's id, heading, whether it is required, and any enumerated options. Owned entirely by the Issue Form and read from it at runtime.

**Field**:
One input in the Issue Form, identified by a stable `id` and rendered in the submitted body as a `### <heading>` **section**. The fields are Context, Acceptance Criteria, Out of Scope, Decisions, Affected files / entry points, Depends on, and Size. Context, Acceptance Criteria, Out of Scope, and Size are required; Decisions and Affected files are optional but warn when empty; Depends on is purely optional.
_Avoid_: Question, item.

**Title**:
The issue's one-line summary, validated (not a field, since the form doesn't own it) against the Conventional Commits format `type(scope): summary`. It leads the scorecard so the change type reads first and maps onto the eventual branch/commit.

**Section**:
A `### <heading>` block in a submitted issue body. GitHub renders each field's heading as the section heading; the validator parses sections back out to check them. A section is the rendered form of a field.

**Rule**:
A constraint applied to a field that the Issue Form cannot express: minimum/maximum length, checklist-item requirement, warn-if-empty on an optional field, or which sizes are too large to land. Owned by `schema.js`, keyed by field `id`, and joined to the structure at runtime.
_Avoid_: Validation, constraint, config.

**Check**:
One evaluated rule or structural requirement against a submitted section, producing a pass, warning, or fail with a message. Checks are **additive**: each fires only when its trigger is present (a required field, a dropdown's options, a length rule, a checklist rule).

**Scorecard**:
The single bot comment on an issue listing every check and its outcome, kept in sync on each run. Present on every result, pass included, so a clean issue gets confirmation rather than silence.
_Avoid_: Report (reserved for the CLI's terminal output), comment.

**Quality Label**:
Exactly one of `issue-quality:pass` / `issue-quality:warning` / `issue-quality:failing`, mutually exclusive, reflecting the worst check outcome. The gate's machine-readable verdict.

**Override**:
The manual escape hatch: the `override:issue-quality` label plus a written `## Override rationale` section bypasses the gate. Neither alone suffices.

**Sweep**:
A local, on-demand backfill that applies quality labels and scorecards across a repo's existing open issues, using the operator's own `gh` session rather than CI credentials.

**Pre-flight validation**:
Running the validator against a drafted issue body locally (`validate <file>`) before `gh issue create`, to catch hard errors before the issue exists.

**Drift test**:
A test asserting that a restated copy of a fact still matches its single source: the README threshold numbers against the rules, and the two workflow files against each other's shared parts. Duplication that is kept on purpose is made safe by a drift test rather than eliminated.

**Accepted duplication**:
A restatement deliberately left in place because collapsing it costs more than it saves, guarded by a drift test. The two workflow files (consumer `@main` vs dogfood `./`) are the standing example.

## Example dialogue

**Dev**: If the Issue Form owns the structure, where does "Context must be at least 30 characters" live?

**Domain expert**: That's a rule, not structure. The form only says Context is a required field; the 30-character floor is a rule in `schema.js`, keyed to the Context field's id. We join the two at runtime.

**Dev**: And if someone renames the Context field's heading in the form?

**Domain expert**: The section heading follows automatically, because the validator reads headings from the form. The rule still matches because it's keyed by id, not heading. A test asserts every rule still maps to a real field, so an orphaned rule or an unruled field fails CI.

**Dev**: The README also lists "30 characters." Isn't that duplication?

**Domain expert**: It is, and it's accepted duplication: the README is the human-readable bar, so we keep the number but guard it with a drift test against the rule. Same pattern as the two workflow files.
