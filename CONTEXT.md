# Repo Contract

A deterministic gate that scores GitHub **issues** and **pull requests** against a structural quality bar, labels each outcome, and posts a scorecard explaining it. It exists so work has a proper spec before anyone picks it up (the issue) and a proper report of how that spec was met (the PR). The **Issue gate** is advisory (labels + scorecard, never fails CI, since GitHub cannot block issue creation); the **PR gate** hard-fails CI (a red check blocks merge), and additionally requires the PR to descend from a gate-cleared issue. The **Commit-hygiene gate** also hard-fails CI: it mirrors the repo-contract baseline (Conventional Commits subjects, em-dash policy in the diff, no default-branch commits) that local git hooks enforce, so the baseline is un-silenceable rather than un-bypassable (ADR `docs/adr/0002`, orestes/dotfiles#52). All three gates share one core: title check, scorecard, labels, override, presence/length rules, and the validator; each is a **Gate** descriptor injecting its own namespace, structure provider, and blocking policy.

## Language

**Intent**:
The single source of truth for a gate: which **fields** to present, in what order, and at what severity. It is concrete code, read at runtime: `rules.js` (issues) and `PR_SECTIONS` (PRs). A given intent is **rendered** into artifacts that differ in format but express the same structure: the GitHub-native rendering (the Issue Form YAML, the PR template Markdown) and the **Author guide** (the LLM-facing Markdown). No rendering is read at runtime; each is drift-tested against the intent, so they cannot diverge in structure.

**Issue Form**:
The GitHub YAML template (`.github/ISSUE_TEMPLATE/task.yml`) behind the issue-form UI an author sees when opening a new issue. A rendering of the issue gate's **Intent**, not its source: read only by the GitHub UI and the drift tests, never at runtime.
_Avoid_: Template (ambiguous with workflow template), schema.

**PR Form**:
The Markdown rendering of the PR gate's **Intent** (`PR_SECTIONS`). Two paths with one content: `.github/PULL_REQUEST_TEMPLATE.md`, which GitHub seeds a PR body from, and the byte-identical `.template.pr.md` at the repo root, its **Author guide**. Because both are the same bytes, PR authoring guidance lives in HTML comments (hidden in the posted body, read by author and LLM in the raw file). Unlike the **Issue Form**, it is unenforced by the platform, which is why its sections are the PR gate's to check.
_Avoid_: Template.

**Author guide**:
The LLM-facing Markdown an author (human or agent) follows to write a well-formed body, carrying each section's heading plus examples, voice notes, and guidance code cannot express. `.template.issue.md` and `.template.pr.md` at the repo root, both ignored by GitHub (non-reserved names). A rendering of the **Intent**, drift-tested on headings and order only; its prose is deliberately richer than the GitHub rendering and is not drift-checked at all.
_Avoid_: Template, LLM template, schema.

**Structure**:
The set of **fields** an object must contain and their shape. Owned by the gate's **Intent** and read from there at runtime; the renderings restate it and are drift-tested against it.

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
The gate's machine-readable verdict: one `pass` / `warning` / `failing` value in the gate's own namespace (`issue-quality:*` on issues, `pr-readiness:*` and `commit-hygiene:*` on PRs), reflecting the worst check outcome. Mutually exclusive within a namespace, independent across them, so a PR carries the PR gate's and the commit gate's labels at once and the two never collide. On issues the label is the verdict; on PRs the merge-blocking verdict is the CI **Check** and the label is a filterable echo of it.

**Override**:
The manual escape hatch: an `override:<gate>` label plus a written `## Override rationale` section bypasses that gate. Neither alone suffices. An overridden object carries no quality label but still carries its scorecard, bannered. The override label is human-applied and never gate-written, so it is a durable, filterable signal rather than a transient one. Each override is scoped to its own namespace, so waiving commit hygiene never waives PR readiness or issue quality. On the PR and commit-hygiene gates, a bot-authored PR (actor ends in `[bot]`) is exempt without an override, since no human is present to apply one.

**Gate clearance**:
Whether an issue clears the gate's bar: it carries `issue-quality:pass`, `issue-quality:warning` (non-blocking by design), or `override:issue-quality` (a human waived the block). Clearance means the issue is _legible_, meeting a minimum of structure and substance to be worth documenting; it does **not** mean the design is settled or that the work is ready to implement, which is a separate downstream signal the gate has no opinion on. `issue-quality:failing` and an issue with no quality label at all (un-gated, or the run is in flight) are not cleared. Clearance is a positive union of the cleared labels, never the absence of `failing`, which would sweep in un-gated issues.
_Avoid_: Readiness, ready for pickup (the gate judges legibility, not readiness-to-implement; that word belongs to the consumer's own `ready-to-implement` signal).

**Rejection**:
An issue carrying the `wontfix` label: work deliberately declined rather than work to do. The label is the sole signal (GitHub's close `state_reason` is bookkeeping the gate does not police, and a `wontfix` issue left open is still a Rejection), and it is human-applied, never gate-written. A Rejection owes a written `## Rejection rationale` section, and owes it **additively**: the work-item **Fields** are still graded, because a declined issue whose original what/why is unreadable is no more useful than one with no reason recorded. Shaped exactly like **Override** rather than as a **Field**: a `##` section conditional on a label, absent from the **Intent** and both renderings, since nobody writes it when opening an issue.
_Avoid_: Wontfix (the label string, not the condition), rejection mode (there is no separate validation path; it is one more additive **Check**).

**Linked issue**:
An issue a PR declares it closes, read from GitHub's native `closingIssuesReferences` (populated by `Closes #N` or the Development sidebar), the same relationship that auto-closes the issue on merge. The PR gate's notion of "connected," never a body field it parses. Only same-repo links count toward the PR gate's clearance check; cross-repo links are ignored, since the workflow token cannot read another repo's labels.
_Avoid_: Referenced issue, mentioned issue (a bare `#N` mention that is not a closing reference is not a Linked issue).

**Divergence**:
A declared departure of a PR's implementation from its Linked issue's original what/why. The issue's what/why may evolve during coding; a Divergence is that evolution made explicit, owing a written rationale. Presence of that rationale is the whole of what is ever checked: whether the code conforms to the issue is the implementer's and reviewer's judgment, never the gate's.
_Avoid_: Deviation, scope change.

**PR Readiness**:
Whether a PR is cleared to merge by the gate. Distinct from an issue's **Gate clearance**: a PR is ready when it has no error (its required sections are present, its title is conventional, and **every** same-repo Linked issue is itself gate-cleared), or a human waived the block with `override:pr-readiness` plus a rationale, or a bot authored it. It is a verdict on a moment, not a standing property: the `pr-readiness:*` label and scorecard are explanatory, and the merge-blocking signal is the status **Check** as of its last run.

**Commit hygiene**:
Whether a PR's commits obey the repo-contract baseline the local git hooks enforce. Its evidence is the PR's commits and diff, not a body an author fills in, which is what separates it from **PR Readiness**. It is the CI **mirror** of the baseline, not a second definition of it: the point is legibility, not un-bypassability, so it is always waivable by `override:commit-hygiene` plus a rationale, and each rule's per-repo opt-out is the same committed `.repo-contract.json` the local hooks read. A separate namespace from **PR Readiness**, so one override never waives the other.

**Gate context**:
The status-check name a gate's workflow publishes: the job key in its YAML (`issue-quality`, `pr-readiness`, `commit-hygiene`) and the string a required-status-check rule matches against. Named per gate, never per tool (ADR [0013](docs/adr/0013-gate-job-names-are-status-check-contexts.md)). Owned in code (`GATE_CONTEXT`) and restated in the YAML, which cannot import it, with a **Drift test** guarding the pair.
_Avoid_: Check name, job name (both true but incidental; what matters is that this is the only handle branch protection has on a gate).

**Gate activation**:
The step that makes a vendored gate actually block a merge: its **Gate context** listed among the default branch's required status checks (classic protection or a ruleset). Distinct from the gate _running_, which vendoring the workflow already buys. The **Hook activation** split one layer up and for the same reason: both halves live in per-repo settings a repository cannot commit, so they are the operator's to set and never a vendoring tool's to deliver (ADR [0014](docs/adr/0014-init-reports-gate-enforcement-never-mutates-it.md)). Unactivated, a red gate blocks nothing and announces that nowhere, which is how a PR merged carrying `pr-readiness:failing` (orestes/dotfiles#84). Every hard-failing gate has one, not the PR gate alone. Its subject is the vendored workflow file, never the `scaffolds` manifest, since the file is what makes a check run: an **Orphan** gate therefore has an activation state like any other.
_Avoid_: Branch protection (the GitHub mechanism, only one of two that can supply this, and already the collision **Default-branch protection** is qualified against), enabling the gate (ambiguous with vendoring its workflow).

**Tiered enforcement**:
The three-audience split of git-hook enforcement (dotfiles ADR 0002, orestes/dotfiles#52), the frame the rest of the hook vocabulary hangs off. **Tier 1**, agent-hygiene: personal-workflow guards that protect only the user's own machine, kept in personal dotfiles via `core.hooksPath` and never vendored. **Tier 2**, repo-contract: the rules every consumer must obey, including CI and contributors with no `~/.dotfiles`; owned by this repo, vendored as committed hooks, and mirrored on CI by the **Commit hygiene** gate. **Tier 3**, project checks (`yarn build`/`test`/`lint`, `gitleaks`): per-repo, dependency-bearing, reached through the **`.repo-contract/hooks/local` chain** and guaranteed by environment provisioning rather than graceful degradation. repo-contract owns tier 2 only.
_Avoid_: Level, layer.

**Execution surface**:
One of the distinct runtime contexts repo-contract's code runs in, each entered at a different moment and assuming a different toolchain already present: the **Repo-contract hook** (commit time, in the consumer repo, in any checkout state), the gate Action (a CI runner mid-workflow), and the CLI (an operator's machine). Which surface an artifact runs on fixes its **Dependency budget**. Orthogonal to **Tiered enforcement**: that splits the same hooks by _who owns and must obey_ them; this splits all the code by _where it executes_. The same commit rule lives on three surfaces at once, one tier.
_Avoid_: Tier (the ownership/audience axis, a different split), layer, environment.

**Dependency budget**:
The maximal toolchain an **Execution surface** may assume is already present, fixed by when and where it runs rather than chosen for convenience. The hook's is the strictest: POSIX sh, git, and jq, never `node_modules`, because commit time is before any install (ADR [0015](docs/adr/0015-commit-hooks-keep-the-sh-jq-dependency-budget.md)). The Action's adds node and an install step; the CLI's adds node and npx-resolved dependencies. Looser budgets are supersets of stricter ones, so shared logic is duplicated _down_ into the hook's budget and drift-checked, never hoisted into a dependency the hook cannot spend.
_Avoid_: Dependency floor (this is a ceiling spent against, not a minimum required), tier, runtime requirements.

**Scaffold**:
One of the coherent bundles `init` lays down and reconciles as a unit, the granularity of its interactive opt-in. There are three: the **Quality gates** (the issue and PR gates together), the **Commit-hygiene gate**, and the **Local hooks**. A scaffold is not a **Gate**: one bundles two gates, one bundles one, one bundles none. The three have no dependency edge between them, which is why any subset is coherent, and that independence is engineered rather than found (ADR [0016](docs/adr/0016-init-scaffolds-are-three-coupled-units.md)). The set a repo installed is an authoritative whitelist in `.repo-contract.json`: an unselected scaffold's absence is a record, not drift. That authority covers what repo-contract owns and reconciles, never what the platform executes, which is why an **Orphan** can run unrecorded and why the manifest and **Gate activation** are facts about different objects rather than rival ones. The whitelist is add-only: dropping an installed scaffold is `uninstall`'s, never a narrower selection's.
_Avoid_: Surface (reserved for **Execution surface**, a different axis), Gate (a scaffold bundles zero, one, or two gates), feature, module.

**Orphan**:
A **Scaffold**'s file present on disk while the `scaffolds` manifest does not list it: installed reality outrunning the record. An orphan is `uninstall`'s to resolve, never `init`'s. It is still enforcing, which is the whole reason it has a name: an orphaned hook fires and an orphaned gate's workflow runs exactly as an installed one's does, so an orphaned gate has a **Gate activation** state like any other, while its labels are inert on the remote.
_Avoid_: Stale, drift (both **Drift test** and `init`'s `drift` state mean a _selected_ file whose bytes differ from the template; an orphan's bytes are irrelevant).

**Repo-contract hook**:
A tier-2 committed git hook (`.repo-contract/hooks/pre-commit`, `.repo-contract/hooks/commit-msg`) encoding a rule of the baseline every consumer must obey. Executed by git directly, with no shim and no husky, so it is POSIX sh with no bashisms and must stay executable. Distinct from a tier-1 agent-hygiene hook, which lives in personal dotfiles and is never vendored.
_Avoid_: Global hook, baseline hook (the baseline is the rule set; this is a vendored carrier of one tier-2 slice of it).

**Vendored hook**:
A repo-contract hook shipped into a consumer as a committed file rather than referenced from a shared location, so it survives environments where `~/.dotfiles` is absent (CI, containers, fresh worktrees) in which a `core.hooksPath` delegation to a personal checkout would silently no-op. Vendoring buys **execution**, never activation: see **Hook activation**. repo-contract owns each one byte-for-byte, so a vendored copy is a rendering of its template and never a fork of it.
_Avoid_: Committed hook (a synonym; prefer this term), linked hook, symlinked hook (the point is a self-contained copy, not a reference).

**Hook activation**:
The step that makes git actually invoke a **Vendored hook**: `core.hooksPath` pointing at `.repo-contract/hooks`, plus the hook file being executable. Distinct from execution (whether the hook can run once invoked), which is what vendoring and the hook's strict **Dependency budget** buy. Ownership of the setting is narrow: only the value repo-contract itself wrote is repo-contract's to change or unset (ADR [0020](docs/adr/0020-init-activation-owns-only-what-it-set.md)). A foreign value (a stale `.husky`, an operator's own directory, an absolute path) is therefore not repo-contract's to repoint, and a hook that cannot be activated is inert, so the two together are a refusal rather than a partial install. The setting is single-valued, so taking the slot displaces whatever held it; the displaced hooks are not lost but re-homed, the **`.repo-contract/hooks/local` chain** being the tool-agnostic adoption path rather than a migration for any particular prior tool (ADR [0021](docs/adr/0021-the-local-chain-is-the-adoption-path.md)). Activation is per-clone git config that no repository can commit, so one activation step per clone is the guarantee, and the **Commit hygiene** gate is the backstop for a checkout where nobody took it. The value is always the relative `.repo-contract/hooks`, never absolute, since `core.hooksPath` is shared across linked worktrees (ADR [0012](docs/adr/0012-init-activates-hooks-with-a-relative-hookspath.md)); the directory is namespaced under `.repo-contract/` rather than named `.husky` or `.githooks`, so a vendoring tool never claims a name a consumer may already own (ADR [0017](docs/adr/0017-vendored-hooks-move-to-repo-contract-hooks.md)).
_Avoid_: Install (names a package-manager step that is neither necessary nor sufficient), husky setup, `prepare` (husky is no longer required).

**`.repo-contract.json`**:
The committed, repo-root file holding a repo's enforcement opt-outs, replacing the per-machine `git config hooks.*` that ADR 0002 retired as invisible and clone-losing. Plain JSON, `jq`-queryable, which is what lets the hooks read it on their own **Dependency budget**. Its `overrides` map keys an opt-out to the `value` the check reads plus a required, non-empty `reason`. An absent file means full enforcement with no opt-outs, so a repo that never wrote one is a repo under the full baseline. It is the single source for both the local hooks and the **Commit hygiene** gate, so a relaxation and its CI mirror are the same fact. It also carries the **Scaffold** install manifest, a `scaffolds` array that is authoritative: an absent key means none installed, not all-in. The manifest is neither a rule nor an opt-out, but a record of what was scaffolded; its authority stops at repo-contract's own decisions (see **Scaffold**).
_Avoid_: Config, hooks config (it carries opt-outs and the scaffold manifest, never the rules themselves).

**Reason-as-data-field**:
The rule that every `.repo-contract.json` opt-out records its rationale as a queryable JSON `reason` string, not a code comment. A program cannot surface a comment, so the reason is quoted verbatim wherever the bypass takes effect, and an opt-out without one is invalid rather than merely undocumented (ADR 0002).
_Avoid_: Reason comment.

**Conventional-Commits commit hook**:
The commit-msg half of the repo-contract baseline: the subject (the first non-empty, non-comment line) must be Conventional Commits, and generated subjects are exempt. `skipConventionalCommits` in `.repo-contract.json` is its opt-out, and the **Commit hygiene** gate is its CI mirror. It is inline sh + grep rather than commitlint because the hook's **Dependency budget** cannot spend `node_modules` (ADR [0015](docs/adr/0015-commit-hooks-keep-the-sh-jq-dependency-budget.md)); library-backed parsing is the looser surfaces' privilege.
_Avoid_: Commitlint (no commitlint dependency; the check is inline POSIX sh plus grep).

**Em-dash policy**:
The repo-contract rule banning the em-dash character in added Markdown (`*.md`/`*.mdx`) and in commit messages, up to an optional budget. `maxAllowedEmDashes` and `allowEmDashes` in `.repo-contract.json` are its two opt-outs, and the **Commit hygiene** gate is its CI mirror.
_Avoid_: Dash rule, punctuation lint.

**Default-branch protection**:
The pre-commit rule refusing a commit made while `HEAD` is the default branch, pushing the author to branch first. `allowDefaultBranchCommits` in `.repo-contract.json` is its opt-out. Part of the repo-contract baseline and mirrored by the **Commit hygiene** gate. Distinct from GitHub's server-side branch protection: this is the local pre-commit guard, the reason the term is qualified.
_Avoid_: Branch protection (GitHub's server-side setting is the collision this qualified name guards against).

**`.repo-contract/hooks/local` chain**:
The consumer-owned extension point the repo-contract hooks call last: where a repo's own tier-3 project checks live without editing a vendored hook. Consumer-owned is the whole of it, so it sits outside what repo-contract writes, reconciles, or repairs. It doubles as the **adoption path** for a consumer whose `core.hooksPath` repo-contract displaced, being tool-agnostic where a migration would have to name a particular prior tool (ADR [0021](docs/adr/0021-the-local-chain-is-the-adoption-path.md)).
_Avoid_: Local hook override (it chains after the contract checks; it does not replace them).

**Suggested rule**:
The agent-guidance snippet `init` emits for an operator to paste into their own agent-rules file (`AGENTS.md`, `CLAUDE.md`, editor rules). Output, never a written file, so it is one thing `init` can offer without owning a file it did not create. Its content is a pointer: follow the **Author guide**, and validate a drafted body before the issue or PR exists. It names no subcommand, flag, or exit code, deferring to `--help`, because a pasted copy is unreachable from here and whatever it pins about the CLI surface strands its consumer when that surface moves.

**Dogfood instance**:
This repo's own installed copy of the `templates/` bundle, occupying the same paths a consumer's install occupies and byte-identical to its source in every one, with no exception. The repo holds the **source** role too, but only in `templates/` and `src/`: the two roles live in different paths and never in the same file. That separation is what makes this repo a plain consumer of itself, since `init`'s only vocabulary is byte-equality (ADR [0003](docs/adr/0003-code-owned-structure-drift-checked-renderings.md)). The exceptionlessness is itself a decision, and its price was the pre-merge self-test the hand-authored gate workflows used to double as (ADR [0018](docs/adr/0018-the-dogfood-instance-is-a-plain-consumer.md)).
_Avoid_: Self-test, self-hosting, dogfooding (the practice, not this artifact).

**Drift test**:
A test asserting that a restated copy of a fact still matches its single source: each rendering's structure against its **Intent**, the README's threshold numbers against the rules, the workflow YAML against the strings it hardcodes, and the **Dogfood instance** against the canonical `templates/` bundle. Renderings are checked as strictly as their format allows: the YAML on headings, order, required, and options; the Markdown guides on headings and order only, since their prose is free. Duplication kept on purpose is made safe by a drift test rather than eliminated.

**Accepted duplication**:
A restatement deliberately left in place because collapsing it costs more than it saves, guarded by a drift test. Every instance is one of exactly two kinds: a **verbatim copy**, checked by exact equality (the **Dogfood instance**; the byte-identical PR pair `.template.pr.md` == `.github/PULL_REQUEST_TEMPLATE.md`, whose sameness is why PR guidance lives in HTML comments), or a **value restatement**, where a fact owned in code is repeated in a format that cannot import it (the README's threshold numbers, the workflow job keys, the trigger filters). A partial overlap, two artifacts agreeing on some fields and legitimately differing on others, is no longer accepted anywhere (ADR [0018](docs/adr/0018-the-dogfood-instance-is-a-plain-consumer.md)). Renderings of an **Intent** are a separate category, partial by design, not accepted duplication.

## Example dialogue

**Dev**: Where does the issue structure live, and where does "Context must be at least 30 characters" live?

**Domain expert**: Both in `rules.js`, the issue gate's **Intent**. It owns the field descriptor and the constraints together, and the validator reads it at runtime. `task.yml` is a rendering: read by GitHub's UI and the drift tests, never parsed by us. Rename a heading in `rules.js` and the constraint follows, because it is keyed by the field's stable `id`; the drift tests then force the same rename into the YAML and the Author guide, or CI goes red.

**Dev**: The README also lists "30 characters." Isn't that duplication?

**Domain expert**: It is, and it's **Accepted duplication** of the value-restatement kind: the README is the human-readable bar, so we keep the number and guard it with a drift test against the rule.

**Dev**: A PR says `Closes #42`, but #42 is `issue-quality:failing`. The PR body is perfect. Does it merge?

**Domain expert**: No. **PR Readiness** requires every same-repo **Linked issue** to be gate-cleared, and #42 isn't. A perfect PR body doesn't buy clearance for the spec it claims to satisfy. And readiness is a verdict on a moment: fixing #42 afterwards doesn't retroactively make the PR's last check green, which is deliberate, because the alternative is coupling the two gates.

**Dev**: The PR gate never asks whether the code actually matches #42's acceptance criteria?

**Domain expert**: Right. Presence, not conformance. If the implementation drifted from the issue, that's a **Divergence**, and all that is checked is that a rationale exists. Whether the rationale is honest is the reviewer's judgment, human or agent.

**Dev**: The git hooks block a Conventional Commits violation and an em dash. Does this repo own every hook I have?

**Domain expert**: No, only the tier-2 ones. **Tiered enforcement** splits hooks by audience: tier 1 is your personal agent-hygiene guards in your dotfiles, tier 2 is the repo-contract baseline this repo owns and vendors, tier 3 is your project checks on the `.repo-contract/hooks/local` chain. What you saw is tier 2.

**Dev**: One commit legitimately needs an em dash. How do I get it through without `--no-verify`?

**Domain expert**: A committed `.repo-contract.json` opt-out, never a per-machine `git config` flag. The `reason` is a data field, not a comment, precisely so it can be quoted back at you when the bypass fires, and an entry without one is invalid rather than merely undocumented. Because the same file is the single source for the **Commit hygiene** gate, the opt-out you commit is the one CI honors: the bypass is legible in both places rather than invisible.

**Dev**: I made a worktree off this repo and my commits there sail through with no hook output at all. The `.repo-contract/hooks/` files are right there in the checkout.

**Domain expert**: The files being there is execution; what's missing is **Hook activation**. Check `git config core.hooksPath`. An absolute value is foreign, since repo-contract only ever writes the relative form, which resolves against each worktree's own root, and a foreign value is not repo-contract's to repoint. If your commits already landed unenforced, the **Commit hygiene** gate is the backstop for exactly that.

**Dev**: My PR gate is vendored and reports red on a PR, and the PR merged anyway. Is the gate broken?

**Domain expert**: The gate worked; what's missing is **Gate activation**. Vendoring the workflow makes the check run, not block. Blocking needs the gate's **Gate context** listed among the default branch's required status checks, and that is a repository setting no repo can commit. Same shape as the hooks problem, one layer up: a vendored file is execution, a per-repo setting is activation. The difference is that hooks have CI as a backstop, and gate activation has none below it.

**Dev**: Can't the repo just activate its own hooks on clone, so nobody has to remember?

**Domain expert**: No, and deliberately so: git refuses to let a repository configure hook execution for whoever clones it, because that is arbitrary code running unbidden. So the guarantee is one legible activation step per clone, covering every linked worktree afterwards, with CI as the un-bypassable copy of the same rules.

**Dev**: The CI gate parses Conventional Commits with a library. Why does the hook re-implement the same check in sh and grep? Feels like tier-2 logic living in two places.

**Domain expert**: It is two places, but not two tiers. Tier is _who owns the rule_; the two copies are two **Execution surfaces**, and each has its own **Dependency budget**. The gate's is loose enough for a library; the hook's is sh, git, and jq, because commit time is before any install. One tier-2 rule expressed twice because it lands on two surfaces with different budgets, and the two are drift-checked against each other. The measurements that settled it are in ADR [0015](docs/adr/0015-commit-hooks-keep-the-sh-jq-dependency-budget.md).
