# Repo Contract

A deterministic gate that scores GitHub **issues** and **pull requests** against a structural quality bar, labels the outcome, and posts a scorecard explaining it. Three gates share one core, each a **Gate** descriptor injecting its own namespace, structure provider, and blocking policy: the **Issue gate** is advisory, since GitHub cannot block issue creation, while the **PR gate** and the **Commit-hygiene gate** hard-fail CI.

## Language

**Intent**:
The single source of truth for a gate: which **fields** to present, in what order, and at what severity. Concrete code read at runtime, `rules.js` (issues) and `PR_SECTIONS` (PRs). An intent is **rendered** into artifacts that differ in format but express the same structure: the GitHub-native rendering and the **Author guide**. No rendering is read at runtime; each is drift-tested against the intent, so they cannot diverge in structure.

**Issue Form**:
The GitHub YAML template (`.github/ISSUE_TEMPLATE/task.yml`) behind the issue-form UI. A rendering of the issue gate's **Intent**, not its source: read only by the GitHub UI and the drift tests, never at runtime.
_Avoid_: Template (ambiguous with workflow template), schema.

**PR Form**:
The Markdown rendering of the PR gate's **Intent** (`PR_SECTIONS`): two paths with one content, `.github/PULL_REQUEST_TEMPLATE.md` that GitHub seeds a PR body from, and the byte-identical `.template.pr.md` that is its **Author guide**. Because both are the same bytes, authoring guidance lives in HTML comments, hidden in the posted body and visible in the raw file. Unlike the **Issue Form**, unenforced by the platform, so its sections are the PR gate's to check.
_Avoid_: Template.

**Author guide**:
The LLM-facing Markdown an author, human or agent, follows to write a well-formed body: each section's heading plus examples, voice notes, and guidance code cannot express. `.template.issue.md` and `.template.pr.md`, both ignored by GitHub. A rendering of the **Intent** drift-tested on headings and order only; its prose is deliberately richer and not drift-checked at all.
_Avoid_: Template, LLM template, schema.

**Structure**:
The set of **fields** an object must contain and their shape. Owned by the gate's **Intent** and read from there at runtime; the renderings restate it under a **Drift test**.

**Field**:
One input the issue **Intent** declares, identified by a stable `id` and rendered in the submitted body as a `### <heading>` **section**. Required, optional-but-warns-when-empty, and purely optional are the three severities a field can carry.
_Avoid_: Question, item.

**Title**:
The issue's one-line summary, validated against the Conventional Commits format `type(scope): summary`. Not a **Field**: the form does not own it. Its change type is the handle that carries into the eventual branch and commit.

**Section**:
A `### <heading>` block in a submitted issue body: the rendered form of a **Field**, and the unit the validator parses back out.

**Rule**:
The constraint layer on a field: minimum/maximum length, checklist-item requirement, warn-if-empty on an optional field, or which sizes are too large to land. `rules.js` owns both the field descriptor and these constraints; a Rule is the constraint half.
_Avoid_: Validation, constraint, config.

**Check**:
One evaluated rule or structural requirement against a submitted section, producing a pass, warning, or fail with a message. Checks are **additive**: each fires only when its trigger is present.

**Scorecard**:
The single bot comment on an issue listing every check and its outcome. Present on every result, pass and override included, so a clean issue gets confirmation rather than silence and an overridden one still shows what the gate found.
_Avoid_: Report (reserved for the CLI's terminal output), comment.

**Quality Label**:
The gate's machine-readable verdict: one `pass` / `warning` / `failing` value in the gate's own namespace (`issue-quality:*`, `pr-readiness:*`, `commit-hygiene:*`), reflecting the worst check outcome. Mutually exclusive within a namespace, independent across them, so the two PR namespaces never collide. On issues the label is the verdict; on PRs the merge-blocking verdict is the CI **Check** and the label is a filterable echo of it.

**Override**:
The manual escape hatch: an `override:<gate>` label plus a written `## Override rationale` section bypasses that gate, and neither alone suffices. An overridden object carries no quality label but still carries its scorecard, bannered. Human-applied and never gate-written, so it is a durable, filterable signal rather than a transient one. Scoped to one namespace, so waiving commit hygiene never waives PR readiness or issue quality. On both PR gates a bot-authored PR is exempt without one, since no human is present to apply it.

**Gate clearance**:
Whether an issue clears the gate's bar: `issue-quality:pass`, `issue-quality:warning` (non-blocking by design), or `override:issue-quality`. Clearance means the issue is _legible_, meeting a minimum of structure and substance to be worth documenting; it does **not** mean the design is settled or the work ready to implement, which is a separate downstream signal the gate has no opinion on. A positive union of those three, never the absence of `failing`, which would sweep in the un-gated issue and the in-flight run alike.
_Avoid_: Readiness, ready for pickup (the gate judges legibility, not readiness-to-implement; that word belongs to the consumer's own `ready-to-implement` signal).

**Rejection**:
An issue carrying the `wontfix` label: work deliberately declined rather than work to do. The label is the sole signal, human-applied and never gate-written; GitHub's close `state_reason` is bookkeeping the gate does not police, and a `wontfix` issue left open is still a Rejection. It owes a written `## Rejection rationale` section, and owes it **additively**: the work-item **Fields** are still graded, because a declined issue whose original what/why is unreadable is no more useful than one with no reason recorded. Shaped exactly like **Override** rather than as a **Field**, a `##` section conditional on a label, absent from the **Intent** and both renderings, since nobody writes it when opening an issue.
_Avoid_: Wontfix (the label string, not the condition), rejection mode (there is no separate validation path; it is one more additive **Check**).

**Linked issue**:
An issue a PR declares it closes, read from GitHub's native `closingIssuesReferences` (`Closes #N` or the Development sidebar), the same relationship that auto-closes the issue on merge. The PR gate's notion of "connected," never a body field it parses. Only same-repo links count, since the workflow token cannot read another repo's labels.
_Avoid_: Referenced issue, mentioned issue (a bare `#N` mention that is not a closing reference is not a Linked issue).

**Divergence**:
A declared departure of a PR's implementation from its **Linked issue**'s original what/why, made explicit and owing a written rationale. Presence of that rationale is the whole of what is ever checked: whether the code conforms to the issue is the implementer's and reviewer's judgment, never the gate's.
_Avoid_: Deviation, scope change.

**PR Readiness**:
Whether a PR is cleared to merge: no error (required sections present, title conventional, and **every** same-repo **Linked issue** itself gate-cleared), or a human waived the block, or a bot authored it. A verdict on a moment, not a standing property: the merge-blocking signal is the status **Check** as of its last run, and the `pr-readiness:*` label and scorecard are explanatory.

**Commit hygiene**:
Whether a PR's commits obey the repo-contract baseline the local git hooks enforce. Its evidence is the PR's commits and diff, not a body an author fills in, which is what separates it from **PR Readiness**. The CI **mirror** of the baseline, not a second definition of it: the point is legibility, not un-bypassability, so it is always waivable, and each rule's per-repo opt-out is the same committed `.repo-contract.json` the local hooks read. A separate namespace from **PR Readiness**, so one override never waives the other.

**Gate context**:
The status-check name a gate's workflow publishes: the job key in its YAML (`issue-quality`, `pr-readiness`, `commit-hygiene`) and the string a required-status-check rule matches against. Named per gate, never per tool (ADR [0013](docs/adr/0013-gate-job-names-are-status-check-contexts.md)). Owned in code as `GATE_CONTEXT` and restated in the YAML, which cannot import it, with a **Drift test** guarding the pair.
_Avoid_: Check name, job name (both true but incidental; what matters is that this is the only handle branch protection has on a gate).

**Gate activation**:
The step that makes a vendored gate actually block a merge: its **Gate context** listed among the default branch's required status checks, by classic protection or a ruleset. Distinct from the gate _running_, which vendoring the workflow already buys. Unactivated, a red gate blocks nothing and announces that nowhere, which is how a PR merged carrying `pr-readiness:failing` (orestes/dotfiles#84). Every hard-failing gate has one, not the PR gate alone. Like **Hook activation** one layer down, it lives in a per-repo setting no repository can commit, so it is the operator's to set and never a vendoring tool's to deliver (ADR [0014](docs/adr/0014-init-reports-gate-enforcement-never-mutates-it.md)). Its subject is the vendored workflow file, never the `scaffolds` manifest, since the file is what makes a check run: an **Orphan** gate therefore has an activation state like any other.
_Avoid_: Branch protection (the GitHub mechanism, only one of two that can supply this, and already the collision **Default-branch protection** is qualified against), enabling the gate (ambiguous with vendoring its workflow).

**Tiered enforcement**:
The three-audience split of git-hook enforcement (dotfiles ADR 0002, orestes/dotfiles#52), the frame the rest of the hook vocabulary hangs off. **Tier 1**, agent-hygiene: personal-workflow guards protecting only the user's own machine, kept in personal dotfiles and never vendored. **Tier 2**, repo-contract: the rules every consumer must obey, including CI and contributors with no `~/.dotfiles`; owned here, vendored as committed hooks, mirrored on CI by the **Commit hygiene** gate. **Tier 3**, project checks (`yarn build`/`test`/`lint`, `gitleaks`): per-repo, dependency-bearing, reached through the **`.repo-contract/hooks/local` chain**. repo-contract owns tier 2 only.
_Avoid_: Level, layer.

**Execution surface**:
One of the distinct runtime contexts repo-contract's code runs in, each entered at a different moment and assuming a different toolchain already present: the **Repo-contract hook** (commit time, any checkout state), the gate Action (a CI runner mid-workflow), and the CLI (an operator's machine). Which surface an artifact runs on fixes its **Dependency budget**. Orthogonal to **Tiered enforcement**: that splits the same hooks by _who owns and must obey_ them, this splits all the code by _where it executes_. The same commit rule lives on three surfaces at once, one tier.
_Avoid_: Tier (the ownership/audience axis, a different split), layer, environment.

**Dependency budget**:
The maximal toolchain an **Execution surface** may assume is already present, fixed by when and where it runs rather than chosen for convenience. The hook's is the strictest, POSIX sh, git, and jq, because commit time is before any install; the Action's and the CLI's add node (ADR [0015](docs/adr/0015-commit-hooks-keep-the-sh-jq-dependency-budget.md)). Looser budgets are supersets of stricter ones, so shared logic is duplicated _down_ into the hook's budget and drift-checked, never hoisted into a dependency the hook cannot spend.
_Avoid_: Dependency floor (this is a ceiling spent against, not a minimum required), tier, runtime requirements.

**Scaffold**:
One of the coherent bundles `init` lays down and reconciles as a unit, the granularity of its opt-in. There are three: the **Quality gates** (the issue and PR gates together), the **Commit-hygiene gate**, and the **Local hooks**. Not a **Gate**: one bundles two gates, one bundles one, one bundles none. They have no dependency edge between them, which is why any subset is coherent, and that independence is engineered rather than found (ADR [0016](docs/adr/0016-init-scaffolds-are-three-coupled-units.md)). The set a repo installed is an authoritative whitelist in `.repo-contract.json`: an unselected scaffold's absence is a record, not drift. That authority covers what repo-contract owns and reconciles, never what the platform executes, which is why an **Orphan** can run unrecorded and why the manifest and **Gate activation** are facts about different objects rather than rival ones. Add-only: dropping an installed scaffold is `uninstall`'s, never a narrower selection's.
_Avoid_: Surface (reserved for **Execution surface**, a different axis), Gate (a scaffold bundles zero, one, or two gates), feature, module.

**Orphan**:
A **Scaffold**'s file present on disk while the `scaffolds` manifest does not list it: installed reality outrunning the record. `uninstall`'s to resolve, never `init`'s. Still enforcing, which is the whole reason it has a name: its hook fires and its workflow runs exactly as an installed one's does, so an orphaned gate has a **Gate activation** state like any other, while its labels sit inert on the remote.
_Avoid_: Stale, drift (both **Drift test** and `init`'s `drift` state mean a _selected_ file whose bytes differ from the template; an orphan's bytes are irrelevant).

**Repo-contract hook**:
A tier-2 committed git hook (`.repo-contract/hooks/pre-commit`, `.repo-contract/hooks/commit-msg`) encoding a rule of the baseline every consumer must obey. Executed by git directly, with no shim and no husky, so it is POSIX sh with no bashisms and must stay executable. Distinct from a tier-1 agent-hygiene hook, which lives in personal dotfiles and is never vendored.
_Avoid_: Global hook, baseline hook (the baseline is the rule set; this is a vendored carrier of one tier-2 slice of it).

**Vendored hook**:
A repo-contract hook shipped into a consumer as a committed file rather than referenced from a shared location, so it survives the environments where `~/.dotfiles` is absent and a `core.hooksPath` delegation to a personal checkout would silently no-op. Vendoring buys **execution**, never activation: see **Hook activation**. repo-contract owns each byte-for-byte, so a vendored copy is a rendering of its template and never a fork of it.
_Avoid_: Committed hook (a synonym; prefer this term), linked hook, symlinked hook (the point is a self-contained copy, not a reference).

**Hook activation**:
The step that makes git actually invoke a **Vendored hook**: `core.hooksPath` pointing at `.repo-contract/hooks`, plus the hook file being executable. Distinct from execution, which is what vendoring and the hook's strict **Dependency budget** buy. Per-clone git config no repository can commit, so one activation step per clone is the guarantee and the **Commit hygiene** gate is the backstop for a checkout where nobody took it. The setting is single-valued and shared across linked worktrees, which is what makes four things decisions rather than details: the value written is relative, only a value repo-contract itself wrote is repo-contract's to change, a foreign one is a refusal rather than a partial install (an unactivatable hook being inert), and the hooks it displaces are re-homed on the **`.repo-contract/hooks/local` chain** rather than lost (ADRs [0012](docs/adr/0012-init-activates-hooks-with-a-relative-hookspath.md), [0017](docs/adr/0017-vendored-hooks-move-to-repo-contract-hooks.md), [0020](docs/adr/0020-init-activation-owns-only-what-it-set.md), [0021](docs/adr/0021-the-local-chain-is-the-adoption-path.md)).
_Avoid_: Install (names a package-manager step that is neither necessary nor sufficient), husky setup, `prepare` (husky is no longer required).

**`.repo-contract.json`**:
The committed, repo-root file holding a repo's enforcement opt-outs, replacing the per-machine `git config hooks.*` that ADR 0002 retired as invisible and clone-losing. Plain JSON and `jq`-queryable, which is what lets the hooks read it on their own **Dependency budget**. Its `overrides` map keys an opt-out to the `value` a check reads plus a required `reason`. An absent file means full enforcement, so a repo that never wrote one is a repo under the full baseline. The single source for both the local hooks and the **Commit hygiene** gate, so a relaxation and its CI mirror are one fact. It also carries the **Scaffold** manifest, a `scaffolds` array whose absent key means none installed, not all-in. That manifest is neither a rule nor an opt-out but a record, and its authority stops at repo-contract's own decisions (see **Scaffold**).
_Avoid_: Config, hooks config (it carries opt-outs and the scaffold manifest, never the rules themselves).

**Reason-as-data-field**:
The rule that every `.repo-contract.json` opt-out records its rationale as a queryable JSON `reason` string, not a code comment. A program cannot surface a comment, so the reason is quoted verbatim wherever the bypass takes effect, and an opt-out without one is invalid rather than merely undocumented (ADR 0002).
_Avoid_: Reason comment.

**Conventional-Commits commit hook**:
The commit-msg half of the baseline: the subject must be Conventional Commits, and generated subjects are exempt. `skipConventionalCommits` is its opt-out and the **Commit hygiene** gate its CI mirror. Inline sh + grep rather than commitlint, because the hook's **Dependency budget** cannot spend `node_modules` (ADR [0015](docs/adr/0015-commit-hooks-keep-the-sh-jq-dependency-budget.md)); library-backed parsing is the looser surfaces' privilege.
_Avoid_: Commitlint (no commitlint dependency; the check is inline POSIX sh plus grep).

**Em-dash policy**:
The rule banning the em-dash character in added Markdown (`*.md`/`*.mdx`) and in commit messages, up to an optional budget. `maxAllowedEmDashes` and `allowEmDashes` are its two opt-outs and the **Commit hygiene** gate its CI mirror.
_Avoid_: Dash rule, punctuation lint.

**Default-branch protection**:
The pre-commit rule refusing a commit made while `HEAD` is the default branch, pushing the author to branch first. `allowDefaultBranchCommits` is its opt-out, and the **Commit hygiene** gate its CI mirror. Distinct from GitHub's server-side branch protection: this is the local guard, the reason the term is qualified.
_Avoid_: Branch protection (GitHub's server-side setting is the collision this qualified name guards against).

**`.repo-contract/hooks/local` chain**:
The consumer-owned extension point the repo-contract hooks call last: where a repo's own tier-3 project checks live without editing a vendored hook. Consumer-owned is the whole of it, so it sits outside what repo-contract writes, reconciles, or repairs. It doubles as the **adoption path** for a consumer whose `core.hooksPath` repo-contract displaced, being tool-agnostic where a migration would have to name a particular prior tool (ADR [0021](docs/adr/0021-the-local-chain-is-the-adoption-path.md)).
_Avoid_: Local hook override (it chains after the contract checks; it does not replace them).

**Suggested rule**:
The agent-guidance snippet `init` emits for an operator to paste into their own agent-rules file. Output, never a written file, so it is one thing repo-contract can offer without owning a file it did not create. Its content is a pointer: follow the **Author guide**, and validate a drafted body before the issue or PR exists. It names no subcommand, flag, or exit code, deferring to `--help`, because a pasted copy is unreachable from here and whatever it pins about the CLI surface strands its consumer when that surface moves.

**Dogfood instance**:
This repo's own installed copy of the `templates/` bundle, occupying the paths a consumer's install occupies and byte-identical to its source in every one, with no exception. The repo holds the **source** role too, but only in `templates/` and `src/`: the two roles live in different paths and never in the same file, which is what makes this repo a plain consumer of itself, since byte-equality is `init`'s only vocabulary. The exceptionlessness is itself a decision, and its price was the pre-merge self-test the hand-authored gate workflows used to double as (ADRs [0003](docs/adr/0003-code-owned-structure-drift-checked-renderings.md), [0018](docs/adr/0018-the-dogfood-instance-is-a-plain-consumer.md)).
_Avoid_: Self-test, self-hosting, dogfooding (the practice, not this artifact).

**Drift test**:
A test asserting that a restated copy of a fact still matches its single source: each rendering's structure against its **Intent**, the README's threshold numbers against the rules, the workflow YAML against the strings it hardcodes, and the **Dogfood instance** against `templates/`. Renderings are checked as strictly as their format allows: the YAML on headings, order, required, and options; the Markdown guides on headings and order only, since their prose is free. Duplication kept on purpose is made safe by a drift test rather than eliminated.

**Accepted duplication**:
A restatement deliberately left in place because collapsing it costs more than it saves, guarded by a **Drift test**. Every instance is one of exactly two kinds: a **verbatim copy** checked by exact equality (the **Dogfood instance**; the byte-identical PR pair, whose sameness is why PR guidance lives in HTML comments), or a **value restatement**, a fact owned in code repeated in a format that cannot import it (the README's numbers, the workflow job keys, the trigger filters). A partial overlap, two artifacts agreeing on some fields and legitimately differing on others, is no longer accepted anywhere (ADR [0018](docs/adr/0018-the-dogfood-instance-is-a-plain-consumer.md)). Renderings of an **Intent** are a separate category, partial by design, not accepted duplication.

## Example dialogue

Three exchanges, kept because each turns on something no single entry can hold: a parallel between two terms, an axis collision, or a verdict crossing object boundaries.

**Dev**: My hooks don't fire in a new worktree, and separately my PR gate reports red and the PR merged anyway. Two bugs?

**Domain expert**: Neither is a bug, and they are the same shape one layer apart. A vendored file is **execution**; a per-repo setting is **activation**. `core.hooksPath` activates a hook, a required-status-check rule activates a gate, and neither is a thing a repository can commit, so both are the operator's. The difference is what sits below: an unactivated hook still has the **Commit hygiene** gate as a backstop, and an unactivated gate has nothing.

**Dev**: The CI gate parses Conventional Commits with a library, and the hook re-implements it in sh. Tier-2 logic in two places?

**Domain expert**: Two places, not two tiers. Tier is _who owns the rule_; these are two **Execution surfaces**, each with its own **Dependency budget**. The gate's is loose enough for a library, the hook's is sh, git, and jq because commit time is before any install. One tier-2 rule expressed twice, drift-checked against each other.

**Dev**: A PR says `Closes #42`, #42 is `issue-quality:failing`, and the PR body is perfect. Does it merge?

**Domain expert**: No. **PR Readiness** requires every same-repo **Linked issue** to be gate-cleared, so a perfect body does not buy clearance for the spec it claims to satisfy. And readiness is a verdict on a moment: fixing #42 afterwards does not retroactively green the PR's last check, which is deliberate, since the alternative is coupling the two gates.
