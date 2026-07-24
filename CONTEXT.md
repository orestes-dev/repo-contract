# Repo Contract

A deterministic gate that scores GitHub **issues** and **pull requests** against a structural quality bar, labels each outcome, and posts a scorecard explaining it. It exists so work has a proper spec before anyone picks it up (the issue) and a proper report of how that spec was met (the PR). The **Issue gate** is advisory (labels + scorecard, never fails CI, since GitHub cannot block issue creation); the **PR gate** hard-fails CI (a red check blocks merge), and additionally requires the PR to descend from a gate-cleared issue. The **Commit-hygiene gate** also hard-fails CI: it mirrors the repo-contract baseline (Conventional Commits subjects, em-dash policy in the diff, no default-branch commits) that local git hooks enforce, so the baseline is un-silenceable rather than un-bypassable (ADR `docs/adr/0002`, orestes/dotfiles#52). All three gates share one core: title check, scorecard, labels, override, presence/length rules, and the validator; each is a **Gate** descriptor injecting its own namespace, structure provider, and blocking policy.

## Language

**Intent**:
The single source of truth for a gate: which **fields** to present, in what order, and at what severity. It is concrete code, read at runtime: `rules.js` (issues) and `PR_SECTIONS` (PRs). A given intent is **rendered** into artifacts that differ in format but express the same structure: the GitHub-native rendering (the Issue Form YAML, the PR template Markdown) and the **Author guide** (the LLM-facing Markdown). No rendering is read at runtime; each is drift-tested against the intent so they cannot diverge in structure.

**Issue Form**:
The GitHub YAML template (`.github/ISSUE_TEMPLATE/task.yml`) GitHub's issue-form UI renders for an author opening a new issue. A rendering of the issue gate's **Intent**, not its source: read only by the GitHub UI and the drift tests, never at runtime.
_Avoid_: Template (ambiguous with workflow template), schema.

**PR Form**:
The Markdown rendering of the PR gate's **Intent** (`PR_SECTIONS`). GitHub renders `.github/PULL_REQUEST_TEMPLATE.md` as the PR body; the byte-identical `.template.pr.md` at the repo root is its **Author guide**. Because both are the same bytes, PR authoring guidance lives in HTML comments (hidden in the posted body, read by author and LLM in the raw file). GitHub does not enforce the sections, so the PR gate enforces them itself.
_Avoid_: Template.

**Author guide**:
The LLM-facing Markdown an author (human or agent) follows to write a well-formed body, carrying each section's heading plus examples, voice notes, and guidance code cannot express. `.template.issue.md` and `.template.pr.md` at the repo root, both ignored by GitHub (non-reserved names). A rendering of the **Intent**, drift-tested on headings and order only; its prose is deliberately richer than the GitHub rendering and is not drift-checked. `init` ships it into a consumer and the **Suggested rule** points an agent at it.
_Avoid_: Template, LLM template, schema.

**Structure**:
The set of **fields** an object must contain and their shape. Owned by the gate's **Intent** and read from there at runtime. The renderings restate it and are drift-tested against it.

**Field**:
One input the issue **Intent** declares, identified by a stable `id` and rendered in the submitted body as a `### <heading>` **section**. Required, optional-but-warns-when-empty, and purely optional are the three severities a field can carry.
_Avoid_: Question, item.

**Title**:
The issue's one-line summary, validated (not a field, since the form doesn't own it) against the Conventional Commits format `type(scope): summary`. It leads the scorecard so the change type reads first and maps onto the eventual branch/commit.

**Section**:
A `### <heading>` block in a submitted issue body. A section is the rendered form of a field: GitHub renders each field's heading as the section heading, and the validator parses sections back out to check them.

**Rule**:
The constraint layer on a field: minimum/maximum length, checklist-item requirement, warn-if-empty on an optional field, or which sizes are too large to land. `rules.js` owns both the field descriptor and these constraints; a Rule is the constraint half.
_Avoid_: Validation, constraint, config.

**Check**:
One evaluated rule or structural requirement against a submitted section, producing a pass, warning, or fail with a message. Checks are **additive**: each fires only when its trigger is present.

**Scorecard**:
The single bot comment on an issue listing every check and its outcome, kept in sync on each run. Present on every result, pass and override included, so a clean issue gets confirmation rather than silence and an overridden one still shows what the gate found. No run leaves an issue without one.
_Avoid_: Report (reserved for the CLI's terminal output), comment.

**Quality Label**:
The gate's machine-readable verdict: one `pass` / `warning` / `failing` value in the gate's own namespace (`issue-quality:*` on issues, `pr-readiness:*` and `commit-hygiene:*` on PRs), reflecting the worst check outcome. Mutually exclusive within a namespace, independent across them, so a PR carries the PR gate's and the commit gate's labels at once and the two never collide. On issues the label is the verdict; on PRs the merge-blocking verdict is the CI **Check** and the label is a filterable echo of it.

**Override**:
The manual escape hatch: an `override:<gate>` label plus a written `## Override rationale` section bypasses that gate. Neither alone suffices. It strips the quality label but not the scorecard, which stays with a banner acknowledging the bypass. The override label is human-applied and the gate never removes it, so it persists as a durable, filterable signal. Each override is scoped to its own namespace, so waiving commit hygiene never waives PR readiness or issue quality. On the PR and commit-hygiene gates, a bot-authored PR (actor ends in `[bot]`) is exempt without an override, since no human is present to apply one.

**Gate clearance**:
Whether an issue clears the gate's bar: it carries `issue-quality:pass`, `issue-quality:warning` (non-blocking by design), or `override:issue-quality` (a human waived the block). Clearance means the issue is _legible_, meeting a minimum of structure and substance to be worth documenting; it does **not** mean the design is settled or that the work is ready to implement, which is a separate downstream signal the gate has no opinion on. `issue-quality:failing` and an issue with no quality label at all (un-gated, or the run is in flight) are not cleared. Consumers express clearance as a positive union of the cleared labels, never as the absence of `failing`, which would sweep in un-gated issues.
_Avoid_: Readiness, ready for pickup (the gate judges legibility, not readiness-to-implement; that word belongs to the consumer's own `ready-to-implement` signal).

**Rejection**:
An issue carrying the `wontfix` label: work deliberately declined rather than work to do. The label is the sole signal (GitHub's close `state_reason` is bookkeeping the gate does not police, and a `wontfix` issue left open is still a Rejection), and it is human-applied, never gate-written. A Rejection owes a written `## Rejection rationale` section, checked **additively**: the work-item **Fields** are still graded, because a declined issue whose original what/why is unreadable is no more useful than one with no reason recorded. Shaped exactly like **Override** rather than as a **Field**: a `##` section conditional on a label, absent from the **Intent** and both renderings, since nobody writes it when opening an issue.
_Avoid_: Wontfix (the label string, not the condition), rejection mode (there is no separate validation path; it is one more additive **Check**).

**Linked issue**:
An issue a PR declares it closes, read from GitHub's native `closingIssuesReferences` (populated by `Closes #N` or the Development sidebar), the same relationship that auto-closes the issue on merge. The PR gate's notion of "connected," never a body field it parses. Only same-repo links count toward the PR gate's clearance check; cross-repo links are ignored, since the workflow token cannot read another repo's labels.
_Avoid_: Referenced issue, mentioned issue (a bare `#N` mention that is not a closing reference is not a Linked issue).

**Divergence**:
A declared departure of a PR's implementation from its Linked issue's original what/why. The issue's what/why may evolve during coding; a Divergence is that evolution made explicit, owing a written rationale. The gate checks only that a rationale is **present** when the author flags a Divergence, never whether the code actually conforms to the issue; conformance is the implementer's and reviewer's judgment.
_Avoid_: Deviation, scope change.

**PR Readiness**:
Whether a PR is cleared to merge by the gate. Distinct from an issue's **Gate clearance**: a PR is ready when it has no error (its required sections are present, its title is conventional, and **every** same-repo Linked issue is itself gate-cleared), or a human waived the block with `override:pr-readiness` plus a rationale, or a bot authored it. Expressed as a passing (green) status **Check**, the merge-blocking signal; the `pr-readiness:*` label and scorecard are explanatory.

**Commit hygiene**:
Whether a PR's commits obey the repo-contract baseline the local git hooks enforce. Checked by the commit-hygiene gate, which reads the PR's commits and diff (not a body the author fills in) and hard-fails CI on any un-relaxed violation. It is the CI **mirror** of the baseline, not a second definition of it: the point is legibility, not un-bypassability, so a red gate is always waivable by `override:commit-hygiene` plus a rationale, and each rule reads its per-repo opt-out from the same committed `.repo-contract.json` the local hooks consume. On a different axis from **PR Readiness**, which scores the PR body and its linked issues; the two are separate namespaces so one override never waives the other.

**Gate context**:
The status-check name a gate's workflow publishes: the job key in its YAML (`issue-quality`, `pr-readiness`, `commit-hygiene`) and the string a required-status-check rule matches against. Named per gate, never per tool (ADR [0013](docs/adr/0013-gate-job-names-are-status-check-contexts.md)). Owned in code (`GATE_CONTEXT`) and restated in the YAML, which cannot import it, with a **Drift test** guarding the pair.
_Avoid_: Check name, job name (both true but incidental; what matters is that this is the only handle branch protection has on a gate).

**Gate activation**:
The step that makes a vendored gate actually block a merge: its **Gate context** listed among the default branch's required status checks (classic protection or a ruleset). Distinct from the gate _running_, which vendoring the workflow already buys. The **Hook activation** split one layer up and for the same reason: both halves live in per-repo settings a repository cannot commit, so `init` ships the carrier and never the enforcement. Unactivated, a red gate blocks nothing and announces that nowhere, which is how a PR merged carrying `pr-readiness:failing` (orestes/dotfiles#84). Every hard-failing gate has one, not the PR gate alone. `init` reports the gap per context and never repairs it (ADR [0014](docs/adr/0014-init-reports-gate-enforcement-never-mutates-it.md)). The report keys off the vendored workflow file, never the `scaffolds` manifest, since the file is what makes a check run: that is what lets it name an **Orphan** gate running unrequired.
_Avoid_: Branch protection (the GitHub mechanism, only one of two that can supply this, and already the collision **Default-branch protection** is qualified against), enabling the gate (ambiguous with vendoring its workflow).

**Tiered enforcement**:
The three-audience split of git-hook enforcement (dotfiles ADR 0002, orestes/dotfiles#52), the frame the rest of the hook vocabulary hangs off. **Tier 1**, agent-hygiene: personal-workflow guards that protect only the user's own machine, kept in personal dotfiles via `core.hooksPath` and never vendored. **Tier 2**, repo-contract: the rules every consumer must obey, including CI and contributors with no `~/.dotfiles`; owned by this repo, vendored by `init` as committed hooks, and mirrored on CI by the **Commit hygiene** gate. **Tier 3**, project checks (`yarn build`/`test`/`lint`, `gitleaks`): per-repo, dependency-bearing, chained via the **`.repo-contract/hooks/local` chain** and guaranteed by environment provisioning rather than graceful degradation. repo-contract owns tier 2 only.
_Avoid_: Level, layer.

**Execution surface**:
One of the distinct runtime contexts repo-contract's code runs in, each entered at a different moment and assuming a different toolchain already present: the **Repo-contract hook** (commit time, in the consumer repo, in any checkout state), the gate Action (a CI runner mid-workflow), and the CLI (an operator's machine). Which surface an artifact runs on fixes its **Dependency budget**. Orthogonal to **Tiered enforcement**: that splits the same hooks by _who owns and must obey_ them; this splits all the code by _where it executes_. The same commit rule lives on three surfaces at once, one tier.
_Avoid_: Tier (the ownership/audience axis, a different split), layer, environment.

**Dependency budget**:
The maximal toolchain an **Execution surface** may assume is already present, fixed by when and where it runs rather than chosen for convenience. The hook's is the strictest: POSIX sh, git, and jq, never `node_modules`, because it runs at commit time before any install (ADR [0015](docs/adr/0015-commit-hooks-keep-the-sh-jq-dependency-budget.md)). The Action's budget adds node and an install step; the CLI's adds node and npx-resolved dependencies. Looser budgets are supersets of stricter ones, so shared logic is duplicated _down_ into the hook's budget and drift-checked, never hoisted into a dependency the hook cannot spend.
_Avoid_: Dependency floor (this is a ceiling spent against, not a minimum required), tier, runtime requirements.

**Scaffold**:
One of the coherent bundles `init` lays down and reconciles as a unit, the granularity of its interactive opt-in. There are three: the **Quality gates** (the issue and PR gates together), the **Commit-hygiene gate**, and the **Local hooks**. A scaffold is not a **Gate**: one bundles two gates, one bundles one, one bundles none. The three have no dependency edge between them, which is why any subset installs coherently, and that independence is engineered rather than found (ADR [0016](docs/adr/0016-init-scaffolds-are-three-coupled-units.md)). The set a repo installed is recorded as an authoritative whitelist in `.repo-contract.json`, so re-running `init` neither reinstalls an unselected scaffold nor reads its absence as drift. That authority covers what repo-contract owns and reconciles, never what the platform executes: GitHub reads `.github/workflows/`, not the manifest, which is why an **Orphan** can run unrecorded and why the manifest and **Gate activation** never contest each other, being facts about different objects. `init` only ever adds: a selection that would drop an installed scaffold is refused, because removing one is `uninstall`'s job. Orthogonal to **Execution surface** (where code runs) and **Tiered enforcement** (who owns a rule).
_Avoid_: Surface (reserved for **Execution surface**, a different axis), Gate (a scaffold bundles zero, one, or two gates), feature, module.

**Orphan**:
A **Scaffold**'s file present on disk while the `scaffolds` manifest does not list it: installed reality outrunning the record. `init` reports one and never removes it; `uninstall` resolves it. Detection reaches the filesystem and `core.hooksPath`, not the remote, because the question is whether the orphan is still enforcing: an orphaned hook fires on every commit and an orphaned gate's workflow still runs on every PR (so it gets a **Gate activation** verdict like any installed context), while its labels sit inert on the remote and are `uninstall`'s to name.
_Avoid_: Stale, drift (both **Drift test** and `init`'s `drift` state mean a _selected_ file whose bytes differ from the template; an orphan's bytes are irrelevant).

**Repo-contract hook**:
A tier-2 committed git hook (`.repo-contract/hooks/pre-commit`, `.repo-contract/hooks/commit-msg`) encoding a rule of the baseline every consumer must obey. Git execs the file directly, with no shim and no husky, so it must stay executable and its body free of bashisms. Distinct from a tier-1 agent-hygiene hook, which lives in personal dotfiles and is never vendored.
_Avoid_: Global hook, baseline hook (the baseline is the rule set; this is a vendored carrier of one tier-2 slice of it).

**Vendored hook**:
A repo-contract hook shipped into a consumer as a committed file rather than referenced from a shared location, so it survives environments where `~/.dotfiles` is absent (CI, containers, fresh worktrees) in which a `core.hooksPath` delegation to a personal checkout would silently no-op. Vendoring buys **execution**, never activation: see **Hook activation**. repo-contract owns each one byte-for-byte, so a consumer edits the upstream template and re-runs `init` instead of patching in place.
_Avoid_: Committed hook (a synonym; prefer this term), linked hook, symlinked hook (the point is a self-contained copy, not a reference).

**Hook activation**:
The step that makes git actually invoke a **Vendored hook**: `core.hooksPath` pointing at `.repo-contract/hooks`, plus the hook file being executable. Distinct from execution (whether the hook can run once invoked), which is what vendoring and the hook's strict **Dependency budget** buy. `init` owns only the value it set, the mirror of the way `uninstall` unsets only what it wrote (ADR [0020](docs/adr/0020-init-activation-owns-only-what-it-set.md)). A foreign value (a stale `.husky`, an operator's own directory, an absolute path) is not repointed; because a git hook on disk that cannot be activated is inert, `init` refuses to write the hooks scaffold at all in that case and reports loudly, rather than laying down files it cannot turn on. The refusal names the remedy, and names what the operator does not lose: because the setting is single-valued, taking the slot displaces whatever held it, and those hooks keep running once their bodies move into the **`.repo-contract/hooks/local` chain**, the tool-agnostic adoption path repo-contract signposts instead of building a migration for any particular prior tool (ADR [0021](docs/adr/0021-the-local-chain-is-the-adoption-path.md)). Activation is per-clone git config that no repository can commit, so one activation step per clone is the guarantee, and the **Commit hygiene** gate is the backstop for a checkout where nobody took it. The value repo-contract writes is always the relative `.repo-contract/hooks`, never absolute, since `core.hooksPath` is shared across linked worktrees (ADR [0012](docs/adr/0012-init-activates-hooks-with-a-relative-hookspath.md)); the directory is namespaced under `.repo-contract/` rather than named `.husky` or `.githooks` so a vendoring tool never claims a name a consumer may already own (ADR [0017](docs/adr/0017-vendored-hooks-move-to-repo-contract-hooks.md)).
_Avoid_: Install (names a package-manager step that is neither necessary nor sufficient), husky setup, `prepare` (husky is no longer required).

**`.repo-contract.json`**:
The committed, repo-root file holding a repo's enforcement opt-outs, replacing the per-machine `git config hooks.*` that ADR 0002 retired as invisible and clone-losing. Plain JSON, `jq`-queryable, which is what lets the hooks read it on their own **Dependency budget**. Its `overrides` map keys an opt-out to the `value` the check reads plus a required, non-empty `reason`. An absent file means full enforcement with no opt-outs, so a repo that never wrote it behaves exactly as before. The same file feeds the **Commit hygiene** CI gate, so a local relaxation and its CI mirror read one source. It also carries the **Scaffold** install manifest, a `scaffolds` array that is authoritative: an absent key means none installed, not all-in, so a repo scaffolded before the manifest existed needs one `init` run to record what it already has. The manifest is neither a rule nor an opt-out, but a record of what `init` scaffolded; its authority stops at repo-contract's own decisions (see **Scaffold**).
_Avoid_: Config, hooks config (it carries opt-outs and the scaffold manifest, never the rules themselves).

**Reason-as-data-field**:
The rule that every `.repo-contract.json` opt-out records its rationale as a queryable JSON `reason` string, not a code comment. A program cannot surface a comment, so the tool quotes the reason verbatim where the bypass takes effect, and rejects an opt-out whose `reason` is missing or empty, since a durable, surfaced rationale is the whole point of the file (ADR 0002).
_Avoid_: Reason comment.

**Conventional-Commits commit hook**:
The commit-msg half of the repo-contract baseline: it checks the subject (the first non-empty, non-comment line) against Conventional Commits, skipping generated subjects. `skipConventionalCommits` in `.repo-contract.json` relaxes it, quoting the reason. The **Commit hygiene** gate mirrors it on CI. It stays inline sh + grep rather than delegating to commitlint because the hook's **Dependency budget** cannot spend `node_modules` (ADR [0015](docs/adr/0015-commit-hooks-keep-the-sh-jq-dependency-budget.md)); library-backed parsing is available only on the looser gate and CLI surfaces.
_Avoid_: Commitlint (no commitlint dependency; the check is inline POSIX sh plus grep).

**Em-dash policy**:
The repo-contract rule banning the em-dash character in added Markdown and in commit messages, up to an optional budget. The pre-commit hook scans added lines of staged `*.md`/`*.mdx`; the commit-msg hook reads the message. Both opt-outs (`maxAllowedEmDashes`, `allowEmDashes`) live in `.repo-contract.json` and the **Commit hygiene** gate mirrors both on CI.
_Avoid_: Dash rule, punctuation lint.

**Default-branch protection**:
The pre-commit rule refusing a commit made while `HEAD` is the default branch, pushing the author to branch first. `allowDefaultBranchCommits` in `.repo-contract.json` relaxes it. Part of the repo-contract baseline and mirrored by the **Commit hygiene** gate. Distinct from GitHub's server-side branch protection: this is the local pre-commit guard, the reason the term is qualified.
_Avoid_: Branch protection (GitHub's server-side setting is the collision this qualified name guards against).

**`.repo-contract/hooks/local` chain**:
The consumer-owned extension point the repo-contract hooks call last, so a repo adds its own tier-3 project checks without editing the vendored hook. `init` never writes `.repo-contract/hooks/local/`, so it survives the repair that rewrites a drifted vendored hook. It doubles as the **adoption path** for a consumer whose `core.hooksPath` repo-contract displaced: whatever hook tool held the single-valued setting keeps running once its bodies move here (ADR [0021](docs/adr/0021-the-local-chain-is-the-adoption-path.md)).
_Avoid_: Local hook override (it chains after the contract checks; it does not replace them).

**Suggested rule**:
The agent-guidance snippet `init` prints to stdout (it does not write it to any file) for the operator to paste into their own agent-rules file (`AGENTS.md`, `CLAUDE.md`, editor rules). It tells an agent to follow the **Author guide** and to validate a drafted body before opening the issue or PR. Kept out of the repo so `init` never clobbers a file it does not own. Names no subcommand, flag, or exit code, deferring to `--help`: a pasted copy is unreachable from here, so whatever it pins about the CLI surface strands its consumer when that surface moves.

**Dogfood instance**:
This repo's own installed copy of the `templates/` bundle, occupying the same paths a consumer's install occupies and byte-identical to its source in every one, with no exception. The repo holds the **source** role too, but only in `templates/` and `src/`: the two roles live in different paths and never in the same file. That separation is what lets `init` run in its own repo and report every file `ok`, since `init`'s only vocabulary is byte-equality (ADR [0003](docs/adr/0003-code-owned-structure-drift-checked-renderings.md)). The exceptionlessness is itself a decision, and it cost the pre-merge self-test the hand-authored gate workflows used to double as (ADR [0018](docs/adr/0018-the-dogfood-instance-is-a-plain-consumer.md)).
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

**Domain expert**: No. The PR gate hard-fails, and one of its errors is that every same-repo **Linked issue** must be gate-cleared. #42 isn't, so the check is red. A perfect PR body doesn't buy clearance for the spec it claims to satisfy.

**Dev**: Then someone fixes #42 and it flips to pass. Does the PR go green on its own?

**Domain expert**: No, and that's deliberate. The PR check only re-runs on PR events, so it goes stale. The scorecard tells the author to re-run it once the issue is gate-cleared, rather than us coupling the two gates. If they can't wait, `override:pr-readiness` plus a rationale is the escape hatch.

**Dev**: The PR gate never asks whether the code actually matches #42's acceptance criteria?

**Domain expert**: Right. It checks presence, not conformance. If the implementation drifted from the issue, that's a **Divergence**, and the gate only checks the author wrote a rationale for it. Judging whether the rationale is honest is the reviewer's job, human or agent, not the gate's.

**Dev**: The git hooks block a Conventional Commits violation and an em dash. Does this repo own every hook I have?

**Domain expert**: No, only the tier-2 ones. **Tiered enforcement** splits hooks by audience: tier 1 is your personal agent-hygiene guards in your dotfiles, tier 2 is the repo-contract baseline this repo owns and vendors, tier 3 is your project checks chaining off `.repo-contract/hooks/local`. What you saw is tier 2.

**Dev**: One commit legitimately needs an em dash. How do I get it through without `--no-verify`?

**Domain expert**: A committed `.repo-contract.json` opt-out, never a per-machine `git config` flag. The `reason` is a data field, not a comment, precisely so the hook can quote it back at you when the bypass fires, and an entry without one is rejected. And because the same file feeds the **Commit hygiene** gate, the opt-out you commit locally is the one CI honors too, so the bypass is legible in both places rather than invisible.

**Dev**: I made a worktree off this repo and my commits there sail through with no hook output at all. The `.repo-contract/hooks/` files are right there in the checkout.

**Domain expert**: The files being there is execution; you are missing **Hook activation**. Check `git config core.hooksPath`. An absolute value is foreign (repo-contract only ever writes the relative form, which resolves against each worktree's own root), so `init` will not repoint it for you: it refuses, and names both the remedy and the explicit opt-in that takes the slot anyway. If your commits already landed unenforced, the **Commit hygiene** gate will still catch them on the PR: that is the backstop for exactly this.

**Dev**: My PR gate is vendored and reports red on a PR, and the PR merged anyway. Is the gate broken?

**Domain expert**: The gate worked; you are missing **Gate activation**. Vendoring the workflow makes the check run, not block. Blocking needs the gate's **Gate context** listed among the default branch's required status checks, and that is a repository setting no repo can commit. Same shape as the hooks problem, one layer up: a vendored file is execution, a per-repo setting is activation, and `init` reports the gap rather than closing it. The difference is that hooks have CI as a backstop, and for gate activation there is none: it is the last line.

**Dev**: Can't the repo just activate its own hooks on clone, so nobody has to remember?

**Domain expert**: No, and deliberately so: git refuses to let a repository configure hook execution for whoever clones it, because that is arbitrary code running unbidden. So the guarantee we can offer is one legible activation step per clone, covering every linked worktree afterwards, with CI as the un-bypassable copy of the same rules.

**Dev**: The CI gate parses Conventional Commits with a library. Why does the hook re-implement the same check in sh and grep? Feels like tier-2 logic living in two places.

**Domain expert**: It is two places, but not two tiers. Tier is _who owns the rule_; the two copies are two **Execution surfaces**, and each has its own **Dependency budget**. The gate runs after an install, so it can reach for a library. The hook runs at commit time in any checkout state, possibly before a single install, so it cannot spend a dependency at all. One tier-2 rule expressed twice because it lands on two surfaces with different budgets, and the two are drift-checked against each other. The measurements that settled it are in ADR [0015](docs/adr/0015-commit-hooks-keep-the-sh-jq-dependency-budget.md).
