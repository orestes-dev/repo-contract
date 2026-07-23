# Repo Contract

A deterministic gate that scores GitHub **issues** and **pull requests** against a structural quality bar, labels each outcome, and posts a scorecard explaining it. It exists so work has a proper spec before anyone picks it up (the issue) and a proper report of how that spec was met (the PR). The **Issue gate** is advisory (labels + scorecard, never fails CI, since GitHub cannot block issue creation); the **PR gate** hard-fails CI (a red check blocks merge), and additionally requires the PR to descend from a gate-cleared issue. The **Commit-hygiene gate** also hard-fails CI: it mirrors the repo-contract baseline (Conventional Commits subjects, em-dash policy in the diff, no default-branch commits) that local git hooks enforce, so the baseline is un-silenceable rather than un-bypassable (ADR `docs/adr/0002`, orestes/dotfiles#52). All three gates share one core: title check, scorecard, labels, override, presence/length rules, and the validator; each is a **Gate** descriptor injecting its own namespace, structure provider, and blocking policy.

## Language

**Intent**:
The single source of truth for a gate: which **fields** to present, in what order, and at what severity. It is concrete code, read at runtime: the ordered field descriptor in `rules.js` (issues) and `PR_SECTIONS` (PRs). A given intent is **rendered** into concrete artifacts that differ in format but express the same structure: the GitHub-native rendering (the Issue Form YAML, the PR template Markdown) and the **Author guide** (the LLM-facing Markdown). No rendering is read at runtime; each is drift-tested against the intent so they cannot diverge in structure.

**Issue Form**:
The GitHub YAML template (`.github/ISSUE_TEMPLATE/task.yml`) GitHub's issue-form UI renders for an author opening a new issue. A rendering of the issue gate's **Intent**, not its source: read only by the GitHub UI and the drift tests, never at runtime. Its structure (headings, order, required, options) is drift-tested against `rules.js`.
_Avoid_: Template (ambiguous with workflow template), schema.

**PR Form**:
The Markdown rendering of the PR gate's **Intent** (`PR_SECTIONS`). GitHub renders `.github/PULL_REQUEST_TEMPLATE.md` as the PR body; the byte-identical `.template.pr.md` at the repo root is its **Author guide**. Because both are the same bytes, PR authoring guidance lives in HTML comments (hidden in the posted body, read by author and LLM in the raw file). GitHub does not enforce the sections, so the PR gate enforces them itself. Its required sections are Summary, Verification, Scope, and Decisions; Divergence is optional until its flag checkbox is checked, when it owes a rationale.
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
Exactly one of `issue-quality:pass` / `issue-quality:warning` / `issue-quality:failing` (on issues), `pr-readiness:pass` / `pr-readiness:warning` / `pr-readiness:failing` (on PRs, applied by the PR gate), or `commit-hygiene:pass` / `commit-hygiene:warning` / `commit-hygiene:failing` (on PRs, applied by the commit-hygiene gate), mutually exclusive within its own namespace, reflecting the worst check outcome. The gate's machine-readable verdict. On issues it is the verdict; on PRs the merge-blocking verdict is the CI **Check**, and the label is a filterable echo of it. A PR carries the PR gate's and the commit gate's labels independently, one per namespace, so the two never collide.

**Override**:
The manual escape hatch: an `override:<gate>` label (`override:issue-quality`, `override:pr-readiness`, or `override:commit-hygiene`) plus a written `## Override rationale` section bypasses that gate. Neither alone suffices. It strips the quality label but not the scorecard, which stays with a banner acknowledging the bypass. The override label is human-applied and the gate never removes it, so it persists as a durable, filterable signal. Each override is scoped to its own namespace, so waiving commit hygiene never waives PR readiness or issue quality. On the PR and commit-hygiene gates, a bot-authored PR (actor ends in `[bot]`) is exempt without an override, since no human is present to apply one.

**Gate clearance**:
Whether an issue clears the gate's bar: it carries `issue-quality:pass`, `issue-quality:warning` (non-blocking by design), or `override:issue-quality` (a human waived the block). Clearance means the issue is _legible_, meeting a minimum of structure and substance to be worth documenting; it does **not** mean the design is settled or that the work is ready to implement, which is a separate downstream signal the gate has no opinion on. `issue-quality:failing` and an issue with no quality label at all (un-gated, or the run is in flight) are not cleared. Consumers express clearance as a positive union of the cleared labels, never as the absence of `failing`, which would sweep in un-gated issues.
_Avoid_: Readiness, ready for pickup (the gate judges legibility, not readiness-to-implement; that word belongs to the consumer's own `ready-to-implement` signal).

**Rejection**:
An issue carrying the `wontfix` label: work deliberately declined rather than work to do. The label is the sole signal (GitHub's close `state_reason` is bookkeeping the gate does not police, and a `wontfix` issue left open is still a Rejection), and it is human-applied, never gate-written. A Rejection owes a written `## Rejection rationale` section, checked **additively**: the work-item **Fields** are still graded, because a declined issue whose original what/why is unreadable is no more useful than one with no reason recorded. Shaped exactly like **Override** rather than as a **Field**: a `##` section, conditional on a label, absent from `rules.js`, the **Issue Form**, and the **Author guide**, since nobody writes it when opening an issue. `init` materializes the `wontfix` label alongside the gate and override labels, adopting GitHub's own default metadata so reconciliation is a no-op in a repo that never recoloured it.
_Avoid_: Wontfix (the label string, not the condition), rejection mode (there is no separate validation path; it is one more additive **Check**).

**Linked issue**:
An issue a PR declares it closes, read from GitHub's native `closingIssuesReferences` (populated by `Closes #N` or the Development sidebar), the same relationship that auto-closes the issue on merge. The PR gate's notion of "connected," never a body field it parses. Only same-repo links count toward the PR gate's clearance check; cross-repo links are ignored (the workflow token cannot read another repo's labels).
_Avoid_: Referenced issue, mentioned issue (a bare `#N` mention that is not a closing reference is not a Linked issue).

**Divergence**:
A declared departure of a PR's implementation from its Linked issue's original what/why. The issue's what/why may evolve during coding; a Divergence is that evolution made explicit, owing a written rationale. The gate checks only that a rationale is **present** when the author flags a Divergence, never whether the code actually conforms to the issue; conformance is the implementer's and reviewer's judgment.
_Avoid_: Deviation, scope change.

**PR Readiness**:
Whether a PR is cleared to merge by the gate. Distinct from an issue's **Gate clearance**: a PR is ready when it has no error (its required sections are present, its title is conventional, and **every** same-repo Linked issue is itself gate-cleared), or a human waived the block with `override:pr-readiness` plus a rationale, or a bot authored it. Expressed as a passing (green) status **Check**, the merge-blocking signal; the `pr-readiness:*` label and scorecard are explanatory.

**Commit hygiene**:
Whether a PR's commits obey the repo-contract baseline the local git hooks enforce: every non-exempt commit subject is Conventional Commits, no em dashes are added on `*.md`/`*.mdx` lines in the diff, and the PR is not opened from the default branch. Checked by the commit-hygiene gate, which reads the PR's commits and diff (not a body the author fills in) and hard-fails CI on any un-relaxed violation. It is the CI **mirror** of the baseline, not a second definition of it: the point is legibility, not un-bypassability, so a red gate is always waivable by `override:commit-hygiene` plus a rationale, and each rule reads its per-repo opt-out from the committed `.repo-contract.json` the local hooks also consume (`skipConventionalCommits`, `maxAllowedEmDashes`, `allowEmDashes`, `allowDefaultBranchCommits`). A relaxed rule passes with a scorecard line quoting the recorded reason. On a different axis from **PR Readiness** (which scores the PR body and its linked issues); the two are separate namespaces so one override never waives the other.

**Gate context**:
The status-check name a gate's workflow publishes: the job key in its YAML (`issue-quality`, `pr-readiness`, `commit-hygiene`) and the string a required-status-check rule matches against. Named per gate, never per tool: all three were once `repo-contract`, which made them indistinguishable to branch protection and meant the `pr-readiness` context an operator would reach for from the docs did not exist anywhere (ADR 0013). Owned in code (`GATE_CONTEXT` in `constants.js`) and restated in the YAML, which cannot import it, with a **Drift test** guarding the pair.
_Avoid_: Check name, job name (both true but incidental; what matters is that this is the only handle branch protection has on a gate).

**Gate activation**:
The step that makes a vendored gate actually block a merge: its **Gate context** listed among the default branch's required status checks, through either classic branch protection or a ruleset. Distinct from the gate _running_, which vendoring the workflow already buys. This is the **Hook activation** split one layer up, and for the same reason: `init` ships the carrier and cannot ship the enforcement, because both live in per-repo settings a repository cannot commit. Unactivated, a red PR gate blocks nothing and announces that nowhere, which is how an issue merged carrying `pr-readiness:failing` (orestes/dotfiles#84) and why the gate was enforced in zero of five repos when first audited. `init` reports the gap (its closing Protection line) and deliberately never repairs it (ADR 0014): `init` is run half-attentively across a fleet, a bad ruleset is not the one-second undo a bad label reconcile is, and requiring a currently-red check blocks every open PR at once, so activation stays a human act.
_Avoid_: Branch protection (the GitHub mechanism, only one of two that can supply this, and already the collision **Default-branch protection** is qualified against), enabling the gate (ambiguous with vendoring its workflow).

**Tiered enforcement**:
The three-audience split of git-hook enforcement (dotfiles ADR 0002, orestes/dotfiles#52), the frame the rest of the hook vocabulary hangs off. **Tier 1**, agent-hygiene: personal-workflow guards (block `.claude/`, `.planning/`, `tmp/`; the branch-name convention check) that protect only the user's own machine, kept in personal dotfiles via `core.hooksPath` and never vendored. **Tier 2**, repo-contract: the Conventional Commits, em-dash, and no-default-branch rules every consumer must obey, including CI and contributors with no `~/.dotfiles`; owned by this repo, vendored by `init` as committed hooks, and mirrored on CI by the **Commit hygiene** gate. **Tier 3**, project checks (`yarn build`/`test`/`lint`, `gitleaks`): per-repo, dependency-bearing, chained via the **`.repo-contract/hooks/local` chain** and guaranteed by environment provisioning rather than graceful degradation. repo-contract owns tier 2 only.
_Avoid_: Level, layer.

**Execution surface**:
One of the distinct runtime contexts repo-contract's code runs in, each entered at a different moment and assuming a different toolchain already present: the **Repo-contract hook** (commit time, in the consumer repo, in any checkout state), the **Commit hygiene** / gate Action (a CI runner mid-workflow), and the CLI (`init`, `validate-issue`/`validate-pr`, `sweep` on an operator's machine). Which surface an artifact runs on fixes its **Dependency budget**. Orthogonal to **Tiered enforcement**: that splits the same hooks by _who owns and must obey_ them; this splits all the code by _where it executes_. The same commit rule lives on three surfaces at once (hook, gate, CLI mirror), one tier.
_Avoid_: Tier (the ownership/audience axis, a different split), layer, environment.

**Dependency budget**:
The maximal toolchain an **Execution surface** may assume is already present, fixed by when and where it runs rather than chosen for convenience. The hook's is the strictest: POSIX sh, git, and jq (jq only when `.repo-contract.json` exists), never `node_modules`, because it runs at commit time before any install, in fresh worktrees, containers, and CI; that budget is why the **Conventional-Commits commit hook** is inline sh + grep and not commitlint (ADR 0015). The Action's budget adds node and an install step (`yarn install --immutable`, cached, on the runner); the CLI's adds node and npx-resolved dependencies. Looser budgets are supersets of stricter ones, so shared logic (the baseline commit rules) is duplicated _down_ into the hook's budget and drift-checked, never hoisted into a dependency the hook cannot spend.
_Avoid_: Dependency floor (this is a ceiling spent against, not a minimum required), tier, runtime requirements.

**Scaffold**:
One of the coherent bundles `init` lays down and reconciles as a unit, the granularity of its interactive opt-in. There are three: the **Quality gates** (the issue and PR gates together, their Forms, Author guides, workflows, and the `issue-quality:*` / `pr-readiness:*` / override / `wontfix` labels), the **Commit-hygiene gate** (its workflow and `commit-hygiene:*` / override labels), and the **Local hooks** (the vendored `.repo-contract/hooks/*` and their `core.hooksPath` activation). A scaffold is not a **Gate**: the Quality-gates scaffold bundles two gates, the commit-hygiene scaffold one, the local-hooks scaffold none. The three are independent with no dependency edge between them, which is why any subset installs coherently. That independence is engineered, not found: the issue and PR gates are coupled into one scaffold precisely because splitting them is incoherent (the PR gate's linked-issue check would have no issue-gate labels to read), so their coupling dissolves the only dependency rather than managing it; the commit-hygiene gate and the local hooks stay separate because one is the un-silenceable CI mirror and the other bypassable local feedback, wanted by different audiences. The set a repo installed is recorded as an authoritative whitelist in `.repo-contract.json`, so re-running `init` neither reinstalls an unselected scaffold nor reads its absence as drift. `init` only ever adds to that set: a selection that would drop an installed scaffold is refused, never recorded, because removing one is `uninstall`'s job. Orthogonal to **Execution surface** (where code runs) and **Tiered enforcement** (who owns a rule): a scaffold splits what `init` installs into independently selectable units.
_Avoid_: Surface (reserved for **Execution surface**, a different axis), Gate (a scaffold bundles zero, one, or two gates), feature, module.

**Orphan**:
A **Scaffold**'s file present on disk while the `scaffolds` manifest does not list it: installed reality outrunning the record. `init` reports one and never removes it; `uninstall` resolves it. It arises where a repo scaffolded before the manifest existed (absent key, every file on disk) runs `init --only` with a narrower selection, which the never-deselect refusal cannot catch because the record it reads is empty. Detection reaches the filesystem and `core.hooksPath`, not the remote: an orphaned **Local hooks** scaffold that `core.hooksPath` still points at is not inert but enforcing, which is the fact the report exists to surface, whereas an orphaned scaffold's labels sit harmlessly on the remote and are `uninstall`'s to name.
_Avoid_: Stale, drift (both **Drift test** and `init`'s `drift` state mean a _selected_ file whose bytes differ from the template; an orphan's bytes are irrelevant).

**Repo-contract hook**:
A tier-2 committed git hook (`.repo-contract/hooks/pre-commit`, `.repo-contract/hooks/commit-msg`) encoding a rule of the baseline every consumer must obey. `init` ships them from `templates/git-hooks/`; each depends only on POSIX sh, git, and jq (jq only when `.repo-contract.json` exists), never on `node_modules`, so it runs before `yarn install` in fresh worktrees, containers, and CI, once **Hook activation** has happened there. Git execs the file directly (no shim), so it must stay executable and its body free of bashisms. Distinct from a tier-1 agent-hygiene hook, which lives in personal dotfiles and is never vendored.
_Avoid_: Global hook, baseline hook (the baseline is the rule set; this is a vendored carrier of one tier-2 slice of it).

**Vendored hook**:
A repo-contract hook shipped into a consumer as a committed file rather than referenced from a shared location, so it survives environments where `~/.dotfiles` is absent (CI, containers, fresh worktrees) in which a `core.hooksPath` delegation to a personal checkout would silently no-op. Vendoring buys **execution**, never activation: see **Hook activation**. `init` writes each one byte-for-byte from `templates/git-hooks/` (`classify()` reports `absent`/`ok`/`drift`, `--force` repairs a drifted copy); repo-contract owns it and drift-tests it, so a consumer edits the upstream template and re-runs `init` instead of patching in place. This repo's own `.repo-contract/hooks/*` are its dogfood instance of the same bundle.
_Avoid_: Committed hook (a synonym; prefer this term), linked hook, symlinked hook (the point is a self-contained copy, not a reference).

**Hook activation**:
The step that makes git actually invoke a **Vendored hook**: `core.hooksPath` pointing at `.repo-contract/hooks`, plus the hook file being executable. Distinct from execution (whether the hook can run once invoked), which is what vendoring and the hook's strict **Dependency budget** buy. `init` performs it (`ensureHooksPath()` reports `create`/`repair`/`ok`, and exits non-zero inside a repository it cannot configure), because `core.hooksPath` is per-clone git config that no repository can commit: one activation step per clone is the guarantee, and the **Commit hygiene** gate is the backstop for a checkout where nobody took it. The value is always the relative `.repo-contract/hooks`, never an absolute path: `core.hooksPath` is shared across linked worktrees, so an absolute one pins every worktree to a single checkout's hooks while a relative one resolves against each worktree's own root (ADR 0012). The directory is namespaced under `.repo-contract/` rather than named `.husky` or `.githooks`, so a vendoring tool never claims a name a consumer may already own (ADR 0017).
_Avoid_: Install (names a package-manager step that is neither necessary nor sufficient), husky setup, `prepare` (husky is no longer required).

**`.repo-contract.json`**:
The committed, repo-root file holding a repo's enforcement opt-outs, replacing the per-machine `git config hooks.*` that ADR 0002 retired as invisible and clone-losing. Read by `src/config.js` (`JSON.parse`, no added parser, so it stays `jq`-queryable) and by the shipped hooks directly through jq. Its `overrides` map keys an opt-out (`skipConventionalCommits`, `allowEmDashes`, `maxAllowedEmDashes`, `allowDefaultBranchCommits`) to an `Override`: the `value` the check reads plus a required, non-empty `reason`. An absent file means full enforcement with no opt-outs, so a repo that never wrote it behaves exactly as before. The same file feeds the **Commit hygiene** CI gate, so a local relaxation and its CI mirror read one source. It also carries the **Scaffold** install manifest: a `scaffolds` array of the scaffold ids installed (`quality-gates`, `commit-hygiene`, `git-hooks`), authoritative and rewritten on every `init` run. An absent key means none installed, not all-in, so a repo scaffolded before the manifest existed needs one `init` run to record what it already has. The array is never empty: a run that would install nothing is an error, and `uninstall`ing the last scaffold removes the key rather than writing `[]`. Every id must name a known scaffold, since an ignored typo would read as a scaffold nobody installed and let a later selection drop it unrefused. The manifest is neither a rule nor an opt-out, but a record of what `init` scaffolded.
_Avoid_: Config, hooks config (it carries opt-outs and the scaffold manifest, never the rules themselves).

**Reason-as-data-field**:
The rule that every `.repo-contract.json` opt-out records its rationale as a queryable JSON `reason` string, not a code comment. A program cannot surface a comment, so the tool quotes the reason verbatim where the bypass takes effect: the hooks' `format_override` and `src/config.js` `formatOverride()` both render `<key> opt-out from .repo-contract.json (<value>): <reason>`. `src/config.js` rejects an opt-out whose `reason` is missing or empty, since a durable, surfaced rationale is the whole point of the file (ADR 0002).
_Avoid_: Reason comment.

**Conventional-Commits commit hook**:
The commit-msg half of the repo-contract baseline: `.repo-contract/hooks/commit-msg` checks the subject (the first non-empty, non-comment line) against `type(scope)?!?: description` for the known types (`feat`, `fix`, `perf`, `refactor`, `test`, `build`, `chore`, `docs`, `style`, `ci`, `revert`), skipping generated subjects (`Merge`, `Revert`, `fixup!`, `squash!`). `skipConventionalCommits` in `.repo-contract.json` relaxes it, quoting the reason. The **Commit hygiene** gate mirrors it on CI. It stays inline sh + grep rather than delegating to commitlint because the hook's **Dependency budget** cannot spend `node_modules`; library-backed parsing is available only on the looser gate and CLI surfaces (ADR 0015).
_Avoid_: Commitlint (no commitlint dependency; the check is inline POSIX sh plus grep).

**Em-dash policy**:
The repo-contract rule banning the em-dash character in added Markdown and in commit messages, up to an optional budget. The pre-commit hook scans added lines of staged `*.md`/`*.mdx` and fails once the count passes `maxAllowedEmDashes` (default 0); the commit-msg hook fails on any em dash in the message unless `allowEmDashes` is set. Both opt-outs live in `.repo-contract.json` and the **Commit hygiene** gate mirrors both on CI.
_Avoid_: Dash rule, punctuation lint.

**Default-branch protection**:
The pre-commit rule refusing a commit made while `HEAD` is the default branch (resolved from `origin/HEAD`, falling back to `init.defaultBranch` then `main`), pushing the author to branch first. `allowDefaultBranchCommits` in `.repo-contract.json` relaxes it. Part of the repo-contract baseline and mirrored by the **Commit hygiene** gate. Distinct from GitHub's server-side branch protection: this is the local pre-commit guard, the reason the term is qualified.
_Avoid_: Branch protection (GitHub's server-side setting is the collision this qualified name guards against).

**`.repo-contract/hooks/local` chain**:
The consumer-owned extension point the repo-contract hooks call last: `.repo-contract/hooks/pre-commit` and `.repo-contract/hooks/commit-msg` each run `sh -e .repo-contract/hooks/local/<name>` when it is present, so a repo adds its own tier-3 project checks (lint-staged, gitleaks, build) without editing the vendored hook. `init` never writes `.repo-contract/hooks/local/`, so it survives `init --force`, which would otherwise repair a drifted vendored hook. This repo's `.repo-contract/hooks/local/pre-commit` runs `yarn lint-staged`.
_Avoid_: Local hook override (it chains after the contract checks; it does not replace them).

**Suggested rule**:
The agent-guidance snippet `init` prints to stdout (it does not write it to any file) for the operator to paste into their own agent-rules file (`AGENTS.md`, `CLAUDE.md`, editor rules). It tells an agent to follow the **Author guide** (`.template.issue.md` / `.template.pr.md`) and to pre-flight validate before opening the issue or PR. Kept out of the repo so `init` never clobbers a file it does not own. Names no subcommand, flag, or exit code, deferring to `--help`: a pasted copy is unreachable from here, so whatever it pins about the CLI surface strands its consumer when that surface moves.

**Sweep**:
A local, on-demand backfill that applies quality labels and scorecards across a repo's existing open issues, using the operator's own `gh` session rather than CI credentials.

**Pre-flight validation**:
Running the validator against a drafted issue body locally (`validate-issue <file>`) before `gh issue create`, to catch hard errors before the issue exists.

**Drift test**:
A test asserting that a restated copy of a fact still matches its single source. The standing cases: each rendering's structure against its **Intent** (the Issue Form and the Author guides against `rules.js`, the PR template against `PR_SECTIONS`), the README threshold numbers against the rules, this repo's dogfood copies against the canonical `templates/` bundle (including its `.repo-contract/hooks/pre-commit` and `.repo-contract/hooks/commit-msg` against `templates/git-hooks/*`, byte-identical so editing one without the other goes red), and the two workflow files against each other's shared parts. Renderings are checked as strictly as their format allows: the YAML on headings, order, required, and options; the Markdown guides on headings and order only, since their prose is free. Duplication kept on purpose is made safe by a drift test rather than eliminated.

**Accepted duplication**:
A restatement deliberately left in place because collapsing it costs more than it saves, guarded by a drift test. Standing examples: the two workflow files (consumer `@main` vs dogfood `./`), the byte-identical PR pair (`.template.pr.md` == `.github/PULL_REQUEST_TEMPLATE.md`), the vendored `.repo-contract/hooks/*` hooks (this repo's `.repo-contract/hooks/pre-commit` and `.repo-contract/hooks/commit-msg` byte-identical to `templates/git-hooks/*`), and this repo's dogfood copies against the `templates/` bundle.

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

**Domain expert**: No. The PR gate hard-fails, and one of its errors is that every same-repo Linked issue must be gate-cleared. #42 isn't, so the check is red. A perfect PR body doesn't buy clearance for the spec it claims to satisfy.

**Dev**: Then someone fixes #42 and it flips to pass. Does the PR go green on its own?

**Domain expert**: No, and that's deliberate. The PR check only re-runs on PR events, so it goes stale. The scorecard tells the author to re-run it once the issue is gate-cleared, rather than us coupling the two gates. If they can't wait, `override:pr-readiness` plus a rationale is the escape hatch.

**Dev**: The PR gate never asks whether the code actually matches #42's acceptance criteria?

**Domain expert**: Right. It checks presence, not conformance. If the implementation drifted from the issue, that's a Divergence, and the gate only checks the author wrote a rationale for it. Judging whether the rationale is honest is the reviewer's job, human or agent, not the gate's.

**Dev**: The git hooks block a Conventional Commits violation and an em dash. Does this repo own every hook I have?

**Domain expert**: No, only the tier-2 repo-contract ones. Tiered enforcement splits hooks by audience. Tier 1 is agent-hygiene (block `.claude/`, `.planning/`, `tmp/`; the branch-name check): personal-workflow guards that live in your dotfiles via `core.hooksPath` and are never vendored. Tier 2 is the repo-contract baseline (Conventional Commits, em-dash policy, no default-branch commits), which repo-contract owns: `init` ships those as committed `.repo-contract/hooks/*` hooks and the Commit hygiene gate mirrors them on CI. Tier 3 is your project checks (lint, build, gitleaks), which chain off the `.repo-contract/hooks/local` extension. The Conventional Commits and em-dash blocks you saw are tier 2.

**Dev**: One commit legitimately needs an em dash. How do I get it through without `--no-verify`?

**Domain expert**: Add a committed `.repo-contract.json` opt-out, never a per-machine `git config` flag. For the message, `overrides.allowEmDashes` with `{"value": true, "reason": "..."}`; for staged Markdown, `overrides.maxAllowedEmDashes` with a numeric budget and a reason. The `reason` is a data field, not a comment, precisely so the hook can quote it back: it prints `allowEmDashes opt-out from .repo-contract.json (true): <your reason>`. `src/config.js` rejects the entry if the reason is missing or empty. And because the same file feeds the Commit hygiene CI gate, the opt-out you commit locally is the one CI honors too, so the bypass is legible in both places rather than invisible.

**Dev**: I made a worktree off this repo and my commits there sail through with no hook output at all. The `.repo-contract/hooks/` files are right there in the checkout.

**Domain expert**: The files being there is execution; you are missing **Hook activation**. Check `git config core.hooksPath`. If it is absolute, the shared `.git/config` was pointing every worktree at one checkout's hooks, and that one has since moved or the worktree resolves outside itself. Run `init` in the worktree: it repairs the value to the relative `.repo-contract/hooks`, which resolves against each worktree's own root, and it re-asserts the executable bit, since git skips a non-executable hook with only a hint. If your commits already landed unenforced, the Commit hygiene gate will still catch them on the PR: that is the backstop for exactly this.

**Dev**: My PR gate is vendored and reports red on a PR, and the PR merged anyway. Is the gate broken?

**Domain expert**: The gate worked; you are missing **Gate activation**. Vendoring the workflow makes the check run, not block. Blocking needs the gate's **Gate context** (`pr-readiness`) listed among the default branch's required status checks, and that is a repository setting no repo can commit, so `init` cannot ship it. `init` ends with a Protection line that reads both classic protection and rulesets and tells you which of the five cases you are in. It will not fix it for you, deliberately, because requiring a check that is currently red blocks every open PR at once.

**Dev**: Same shape as the hooks problem, then.

**Domain expert**: Exactly the same shape, one layer up. A vendored hook file is execution and `core.hooksPath` is activation; a vendored workflow is execution and the required-status-check rule is activation. Both halves that `init` cannot ship are per-repo settings, and both used to fail silently. The difference is that hooks have CI as a backstop, and for gate activation there is no backstop below it: it is the last line.

**Dev**: Can't the repo just activate its own hooks on clone, so nobody has to remember?

**Domain expert**: No, and deliberately so: git refuses to let a repository configure hook execution for whoever clones it, because that is arbitrary code running unbidden. `core.hooksPath` is per-clone config that is never committed. So the guarantee we can offer is one legible activation step per clone (`init`, or `git config core.hooksPath .repo-contract/hooks` with no tooling), covering every linked worktree afterwards, with CI as the un-bypassable copy of the same rules.

**Dev**: The CI gate parses Conventional Commits with commitlint. Why does the hook re-implement the same check in sh and grep instead of just calling commitlint too? Feels like tier-2 logic living in two places.

**Domain expert**: It is two places, but not two tiers. Tier is _who owns the rule_; the two copies are two **Execution surfaces**, and each surface has its own **Dependency budget**. The gate runs on a CI runner that already ran `yarn install`, so its budget can spend `node_modules` and reach for a library. The hook runs at commit time, in any checkout state, possibly before a single install, and its budget is only sh, git, and jq, so it cannot spend a dependency at all. The rule is one tier-2 rule expressed twice because it lands on two surfaces with different budgets, and the two are drift-checked against each other.

**Dev**: So could we move the hook onto node and collapse the duplication?

**Domain expert**: We measured it (ADR 0015). Node's interpreter startup alone is already about 3x the whole sh+jq hook, and the actual library you'd want, commitlint, is about 10x, per commit; it also needs `node_modules` present, which reintroduces the run-before-install failure the strict budget exists to avoid. The duplication is the deliberate price of the hook keeping its budget. Library-backed parsing is welcome on the gate and CLI surfaces, never in the hook.
