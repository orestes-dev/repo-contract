# Quality Gate

A deterministic gate that scores GitHub **issues** and **pull requests** against a structural quality bar, labels each outcome, and posts a scorecard explaining it. It exists so work has a proper spec before anyone picks it up (the issue) and a proper report of how that spec was met (the PR). The **Issue gate** is advisory (labels + scorecard, never fails CI, since GitHub cannot block issue creation); the **PR gate** hard-fails CI (a red check blocks merge), and additionally requires the PR to descend from a ready issue. The two gates share one core: title check, scorecard, labels, override, presence/length rules, and the validator.

## Language

**Intent**:
The single source of truth for a gate: which **fields** to present, in what order, and at what severity. It is concrete code, read at runtime: the ordered field descriptor in `rules.js` (issues) and `PR_SECTIONS` (PRs). A given intent is **rendered** into concrete artifacts that differ in format but express the same structure: the GitHub-native rendering (the Issue Form YAML, the PR template Markdown) and the **Author guide** (the LLM-facing Markdown). No rendering is read at runtime; each is drift-tested against the intent so they cannot diverge in structure.

**Issue Form**:
The GitHub YAML template (`.github/ISSUE_TEMPLATE/task.yml`) GitHub's issue-form UI renders for an author opening a new issue. A rendering of the issue gate's **Intent**, not its source: read only by the GitHub UI and the drift tests, never at runtime. Its structure (headings, order, required, options) is drift-tested against `rules.js`.
_Avoid_: Template (ambiguous with workflow template), schema.

**PR Form**:
The Markdown rendering of the PR gate's **Intent** (`PR_SECTIONS`). GitHub renders `.github/PULL_REQUEST_TEMPLATE.md` as the PR body; the byte-identical `.template.pr.md` at the repo root is its **Author guide**. Because both are the same bytes, PR authoring guidance lives in HTML comments (hidden in the posted body, read by author and LLM in the raw file). GitHub does not enforce the sections, so the PR gate enforces them itself. Its required sections are Summary, Verification, and Divergence.
_Avoid_: Template.

**Author guide**:
The LLM-facing Markdown an author (human or agent) follows to write a well-formed body, carrying each section's heading plus examples, voice notes, and guidance code cannot express. `.template.issue.md` and `.template.pr.md` at the repo root, both ignored by GitHub (non-reserved names). A rendering of the **Intent**, drift-tested on headings and order only; its prose is deliberately richer than the GitHub rendering and is not drift-checked. `init` ships it into a consumer and the **Suggested rule** points an agent at it.
_Avoid_: Template, LLM template, schema.

**Structure**:
The set of **fields** an object must contain and their shape: each field's id, heading, order, type, whether it is required, and any enumerated options. Owned by the gate's **Intent** (`rules.js` / `PR_SECTIONS`) and read from there at runtime. The renderings restate it and are drift-tested against it.

**Field**:
One input the issue **Intent** (`rules.js`) declares, identified by a stable `id` and rendered in the submitted body as a `### <heading>` **section**. The fields are Context, Acceptance Criteria, Out of Scope, Decisions, Affected files / entry points, Depends on, and Size. Context, Acceptance Criteria, Out of Scope, and Size are required; Decisions and Affected files are optional but warn when empty; Depends on is purely optional.
_Avoid_: Question, item.

**Title**:
The issue's one-line summary, validated (not a field, since the form doesn't own it) against the Conventional Commits format `type(scope): summary`. It leads the scorecard so the change type reads first and maps onto the eventual branch/commit.

**Section**:
A `### <heading>` block in a submitted issue body. GitHub renders each field's heading as the section heading; the validator parses sections back out to check them. A section is the rendered form of a field.

**Rule**:
The constraint layer on a field: minimum/maximum length, checklist-item requirement, warn-if-empty on an optional field, or which sizes are too large to land. `rules.js` owns both the field descriptor (id, heading, order, type, required, options) and these constraints; a Rule is the constraint half.
_Avoid_: Validation, constraint, config.

**Check**:
One evaluated rule or structural requirement against a submitted section, producing a pass, warning, or fail with a message. Checks are **additive**: each fires only when its trigger is present (a required field, a dropdown's options, a length rule, a checklist rule).

**Scorecard**:
The single bot comment on an issue listing every check and its outcome, kept in sync on each run. Present on every result, pass and override included, so a clean issue gets confirmation rather than silence and an overridden one still shows what the gate found. No run leaves an issue without one.
_Avoid_: Report (reserved for the CLI's terminal output), comment.

**Quality Label**:
Exactly one of `issue-quality:pass` / `issue-quality:warning` / `issue-quality:failing` (on issues) or `pr-quality:pass` / `pr-quality:warning` / `pr-quality:failing` (on PRs), mutually exclusive within its object, reflecting the worst check outcome. The gate's machine-readable verdict. On issues it is the verdict; on PRs the merge-blocking verdict is the CI **Check**, and the label is a filterable echo of it.

**Override**:
The manual escape hatch: an `override:<gate>` label (`override:issue-quality` or `override:pr-quality`) plus a written `## Override rationale` section bypasses that gate. Neither alone suffices. It strips the quality label but not the scorecard, which stays with a banner acknowledging the bypass. The override label is human-applied and the gate never removes it, so it persists as a durable, filterable signal. On the PR gate, a bot-authored PR (actor ends in `[bot]`) is exempt without an override, since no human is present to apply one.

**Readiness**:
Whether an issue is cleared for a consumer (human or automation) to pick up. Distinct from the **Quality Label**: readiness is "not blocked," the label is the gate's verdict on a single issue. An issue is ready when it carries `issue-quality:pass`, `issue-quality:warning` (non-blocking by design), or `override:issue-quality` (a human waived the block). `issue-quality:failing` and an issue with no quality label at all (un-gated, or the run is in flight) are not ready. Consumers express readiness as a positive union of the ready labels, never as the absence of `failing`, which would sweep in un-gated issues.

**Linked issue**:
An issue a PR declares it closes, read from GitHub's native `closingIssuesReferences` (populated by `Closes #N` or the Development sidebar), the same relationship that auto-closes the issue on merge. The PR gate's notion of "connected," never a body field it parses. Only same-repo links count toward readiness; cross-repo links are ignored (the workflow token cannot read another repo's labels).
_Avoid_: Referenced issue, mentioned issue (a bare `#N` mention that is not a closing reference is not a Linked issue).

**Divergence**:
A declared departure of a PR's implementation from its Linked issue's original what/why. The issue's what/why may evolve during coding; a Divergence is that evolution made explicit, owing a written rationale. The gate checks only that a rationale is **present** when the author flags a Divergence, never whether the code actually conforms to the issue; conformance is the implementer's and reviewer's judgment.
_Avoid_: Deviation, scope change.

**PR Readiness**:
Whether a PR is cleared to merge by the gate. Distinct from **Readiness** (an issue property): a PR is ready when it has no error (its required sections are present, its title is conventional, and **every** same-repo Linked issue is itself ready), or a human waived the block with `override:pr-quality` plus a rationale, or a bot authored it. Expressed as a passing (green) status **Check**, the merge-blocking signal; the `pr-quality:*` label and scorecard are explanatory.

**Suggested rule**:
The agent-guidance snippet `init` prints to stdout (it does not write it to any file) for the operator to paste into their own agent-rules file (`AGENTS.md`, `CLAUDE.md`, editor rules). It tells an agent to follow the **Author guide** (`.template.issue.md` / `.template.pr.md`) and to pre-flight validate before opening the issue or PR. Kept out of the repo so `init` never clobbers a file it does not own.

**Sweep**:
A local, on-demand backfill that applies quality labels and scorecards across a repo's existing open issues, using the operator's own `gh` session rather than CI credentials.

**Pre-flight validation**:
Running the validator against a drafted issue body locally (`validate <file>`) before `gh issue create`, to catch hard errors before the issue exists.

**Drift test**:
A test asserting that a restated copy of a fact still matches its single source. The standing cases: each rendering's structure against its **Intent** (the Issue Form and the Author guides against `rules.js`, the PR template against `PR_SECTIONS`), the README threshold numbers against the rules, this repo's dogfood copies against the canonical `templates/` bundle, and the two workflow files against each other's shared parts. Renderings are checked as strictly as their format allows: the YAML on headings, order, required, and options; the Markdown guides on headings and order only, since their prose is free. Duplication kept on purpose is made safe by a drift test rather than eliminated.

**Accepted duplication**:
A restatement deliberately left in place because collapsing it costs more than it saves, guarded by a drift test. Standing examples: the two workflow files (consumer `@main` vs dogfood `./`), the byte-identical PR pair (`.template.pr.md` == `.github/PULL_REQUEST_TEMPLATE.md`), and this repo's dogfood copies against the `templates/` bundle.

## Example dialogue

**Dev**: Where does the issue structure live, and where does "Context must be at least 30 characters" live?

**Domain expert**: Both in `rules.js`. It owns the ordered field descriptor (id, heading, type, required, options) and the constraints on each field, including Context's 30-character floor. The validator reads `rules.js` at runtime; nothing is parsed from the YAML.

**Dev**: Then what is `task.yml` for?

**Domain expert**: It is the GitHub issue-form UI rendering, read only by GitHub and the drift tests. If its headings, order, required, or options drift from `rules.js`, a test fails. Same for the Author guides' headings.

**Dev**: And if someone renames the Context heading?

**Domain expert**: Change it in `rules.js`; the constraint stays attached because it's keyed by the field's stable `id`, not its heading. The drift tests then force the same rename in the YAML and the Author guide, or CI goes red.

**Dev**: The README also lists "30 characters." Isn't that duplication?

**Domain expert**: It is, and it's accepted duplication: the README is the human-readable bar, so we keep the number but guard it with a drift test against the rule. Same pattern as the two workflow files.

**Dev**: A PR says `Closes #42`, but #42 is `issue-quality:failing`. The PR body is perfect. Does it merge?

**Domain expert**: No. The PR gate hard-fails, and one of its errors is that every same-repo Linked issue must be ready. #42 isn't, so the check is red. A perfect PR body doesn't buy readiness for the spec it claims to satisfy.

**Dev**: Then someone fixes #42 and it flips to pass. Does the PR go green on its own?

**Domain expert**: No, and that's deliberate. The PR check only re-runs on PR events, so it goes stale. The scorecard tells the author to re-run it once the issue is ready, rather than us coupling the two gates. If they can't wait, `override:pr-quality` plus a rationale is the escape hatch.

**Dev**: The PR gate never asks whether the code actually matches #42's acceptance criteria?

**Domain expert**: Right. It checks presence, not conformance. If the implementation drifted from the issue, that's a Divergence, and the gate only checks the author wrote a rationale for it. Judging whether the rationale is honest is the reviewer's job, human or agent, not the gate's.
