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

**Tiered enforcement**:
The three-audience split of git-hook enforcement (dotfiles ADR 0002, orestes/dotfiles#52), the frame the rest of the hook vocabulary hangs off. **Tier 1**, agent-hygiene: personal-workflow guards (block `.claude/`, `.planning/`, `tmp/`; the branch-name convention check) that protect only the user's own machine, kept in personal dotfiles via `core.hooksPath` and never vendored. **Tier 2**, repo-contract: the Conventional Commits, em-dash, and no-default-branch rules every consumer must obey, including CI and contributors with no `~/.dotfiles`; owned by this repo, vendored by `init` as committed hooks, and mirrored on CI by the **Commit hygiene** gate. **Tier 3**, project checks (`yarn build`/`test`/`lint`, `gitleaks`): per-repo, dependency-bearing, chained via the **`.husky/local` chain** and guaranteed by environment provisioning rather than graceful degradation. repo-contract owns tier 2 only.
_Avoid_: Level, layer.

**Repo-contract hook**:
A tier-2 committed git hook (`.husky/pre-commit`, `.husky/commit-msg`) encoding a rule of the baseline every consumer must obey. `init` ships them from `templates/husky/`; each depends only on POSIX sh, git, and jq (jq only when `.repo-contract.json` exists), never on `node_modules`, so it runs before `yarn install` in fresh worktrees, containers, and CI, once **Hook activation** has happened there. Git execs the file directly (no husky shim), so it must stay executable and its body free of bashisms. Distinct from a tier-1 agent-hygiene hook, which lives in personal dotfiles and is never vendored.
_Avoid_: Global hook, baseline hook (the baseline is the rule set; this is a vendored carrier of one tier-2 slice of it).

**Vendored hook**:
A repo-contract hook shipped into a consumer as a committed file rather than referenced from a shared location, so it survives environments where `~/.dotfiles` is absent (CI, containers, fresh worktrees) in which a `core.hooksPath` delegation to a personal checkout would silently no-op. Vendoring buys **execution**, never activation: see **Hook activation**. `init` writes each one byte-for-byte from `templates/husky/` (`classify()` reports `absent`/`ok`/`drift`, `--force` repairs a drifted copy); repo-contract owns it and drift-tests it, so a consumer edits the upstream template and re-runs `init` instead of patching in place. This repo's own `.husky/*` are its dogfood instance of the same bundle.
_Avoid_: Committed hook (a synonym; prefer this term), linked hook, symlinked hook (the point is a self-contained copy, not a reference).

**Hook activation**:
The step that makes git actually invoke a **Vendored hook**: `core.hooksPath` pointing at `.husky`, plus the hook file being executable. Distinct from execution (whether the hook can run once invoked), which is what vendoring and the sh/git/jq-only dependency budget buy. `init` performs it (`ensureHooksPath()` reports `create`/`repair`/`ok`, and exits non-zero inside a repository it cannot configure), because `core.hooksPath` is per-clone git config that no repository can commit: one activation step per clone is the guarantee, and the **Commit hygiene** gate is the backstop for a checkout where nobody took it. The value is always the relative `.husky`, never an absolute path: `core.hooksPath` is shared across linked worktrees, so an absolute one pins every worktree to a single checkout's hooks while a relative one resolves against each worktree's own root (ADR 0012).
_Avoid_: Install (names a package-manager step that is neither necessary nor sufficient), husky setup, `prepare` (husky is no longer required).

**`.repo-contract.json`**:
The committed, repo-root file holding a repo's enforcement opt-outs, replacing the per-machine `git config hooks.*` that ADR 0002 retired as invisible and clone-losing. Read by `src/config.js` (`JSON.parse`, no added parser, so it stays `jq`-queryable) and by the shipped hooks directly through jq. Its `overrides` map keys an opt-out (`skipConventionalCommits`, `allowEmDashes`, `maxAllowedEmDashes`, `allowDefaultBranchCommits`) to an `Override`: the `value` the check reads plus a required, non-empty `reason`. An absent file means full enforcement with no opt-outs, so a repo that never wrote it behaves exactly as before. The same file feeds the **Commit hygiene** CI gate, so a local relaxation and its CI mirror read one source.
_Avoid_: Config, hooks config (it carries only opt-outs, never the rules themselves).

**Reason-as-data-field**:
The rule that every `.repo-contract.json` opt-out records its rationale as a queryable JSON `reason` string, not a code comment. A program cannot surface a comment, so the tool quotes the reason verbatim where the bypass takes effect: the hooks' `format_override` and `src/config.js` `formatOverride()` both render `<key> opt-out from .repo-contract.json (<value>): <reason>`. `src/config.js` rejects an opt-out whose `reason` is missing or empty, since a durable, surfaced rationale is the whole point of the file (ADR 0002).
_Avoid_: Reason comment.

**Conventional-Commits commit hook**:
The commit-msg half of the repo-contract baseline: `.husky/commit-msg` checks the subject (the first non-empty, non-comment line) against `type(scope)?!?: description` for the known types (`feat`, `fix`, `perf`, `refactor`, `test`, `build`, `chore`, `docs`, `style`, `ci`, `revert`), skipping generated subjects (`Merge`, `Revert`, `fixup!`, `squash!`). `skipConventionalCommits` in `.repo-contract.json` relaxes it, quoting the reason. The **Commit hygiene** gate mirrors it on CI.
_Avoid_: Commitlint (no commitlint dependency; the check is inline POSIX sh plus grep).

**Em-dash policy**:
The repo-contract rule banning the em-dash character in added Markdown and in commit messages, up to an optional budget. The pre-commit hook scans added lines of staged `*.md`/`*.mdx` and fails once the count passes `maxAllowedEmDashes` (default 0); the commit-msg hook fails on any em dash in the message unless `allowEmDashes` is set. Both opt-outs live in `.repo-contract.json` and the **Commit hygiene** gate mirrors both on CI.
_Avoid_: Dash rule, punctuation lint.

**Default-branch protection**:
The pre-commit rule refusing a commit made while `HEAD` is the default branch (resolved from `origin/HEAD`, falling back to `init.defaultBranch` then `main`), pushing the author to branch first. `allowDefaultBranchCommits` in `.repo-contract.json` relaxes it. Part of the repo-contract baseline and mirrored by the **Commit hygiene** gate. Distinct from GitHub's server-side branch protection: this is the local pre-commit guard, the reason the term is qualified.
_Avoid_: Branch protection (GitHub's server-side setting is the collision this qualified name guards against).

**`.husky/local` chain**:
The consumer-owned extension point the repo-contract hooks call last: `.husky/pre-commit` and `.husky/commit-msg` each run `sh -e .husky/local/<name>` when it is present, so a repo adds its own tier-3 project checks (lint-staged, gitleaks, build) without editing the vendored hook. `init` never writes `.husky/local/`, so it survives `init --force`, which would otherwise repair a drifted vendored hook. This repo's `.husky/local/pre-commit` runs `yarn lint-staged`.
_Avoid_: Local hook override (it chains after the contract checks; it does not replace them).

**Suggested rule**:
The agent-guidance snippet `init` prints to stdout (it does not write it to any file) for the operator to paste into their own agent-rules file (`AGENTS.md`, `CLAUDE.md`, editor rules). It tells an agent to follow the **Author guide** (`.template.issue.md` / `.template.pr.md`) and to pre-flight validate before opening the issue or PR. Kept out of the repo so `init` never clobbers a file it does not own. Names no subcommand, flag, or exit code, deferring to `--help`: a pasted copy is unreachable from here, so whatever it pins about the CLI surface strands its consumer when that surface moves.

**Sweep**:
A local, on-demand backfill that applies quality labels and scorecards across a repo's existing open issues, using the operator's own `gh` session rather than CI credentials.

**Pre-flight validation**:
Running the validator against a drafted issue body locally (`validate-issue <file>`) before `gh issue create`, to catch hard errors before the issue exists.

**Drift test**:
A test asserting that a restated copy of a fact still matches its single source. The standing cases: each rendering's structure against its **Intent** (the Issue Form and the Author guides against `rules.js`, the PR template against `PR_SECTIONS`), the README threshold numbers against the rules, this repo's dogfood copies against the canonical `templates/` bundle (including its `.husky/pre-commit` and `.husky/commit-msg` against `templates/husky/*`, byte-identical so editing one without the other goes red), and the two workflow files against each other's shared parts. Renderings are checked as strictly as their format allows: the YAML on headings, order, required, and options; the Markdown guides on headings and order only, since their prose is free. Duplication kept on purpose is made safe by a drift test rather than eliminated.

**Accepted duplication**:
A restatement deliberately left in place because collapsing it costs more than it saves, guarded by a drift test. Standing examples: the two workflow files (consumer `@main` vs dogfood `./`), the byte-identical PR pair (`.template.pr.md` == `.github/PULL_REQUEST_TEMPLATE.md`), the vendored `.husky/*` hooks (this repo's `.husky/pre-commit` and `.husky/commit-msg` byte-identical to `templates/husky/*`), and this repo's dogfood copies against the `templates/` bundle.

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

**Domain expert**: No, only the tier-2 repo-contract ones. Tiered enforcement splits hooks by audience. Tier 1 is agent-hygiene (block `.claude/`, `.planning/`, `tmp/`; the branch-name check): personal-workflow guards that live in your dotfiles via `core.hooksPath` and are never vendored. Tier 2 is the repo-contract baseline (Conventional Commits, em-dash policy, no default-branch commits), which repo-contract owns: `init` ships those as committed `.husky/*` hooks and the Commit hygiene gate mirrors them on CI. Tier 3 is your project checks (lint, build, gitleaks), which chain off the `.husky/local` extension. The Conventional Commits and em-dash blocks you saw are tier 2.

**Dev**: One commit legitimately needs an em dash. How do I get it through without `--no-verify`?

**Domain expert**: Add a committed `.repo-contract.json` opt-out, never a per-machine `git config` flag. For the message, `overrides.allowEmDashes` with `{"value": true, "reason": "..."}`; for staged Markdown, `overrides.maxAllowedEmDashes` with a numeric budget and a reason. The `reason` is a data field, not a comment, precisely so the hook can quote it back: it prints `allowEmDashes opt-out from .repo-contract.json (true): <your reason>`. `src/config.js` rejects the entry if the reason is missing or empty. And because the same file feeds the Commit hygiene CI gate, the opt-out you commit locally is the one CI honors too, so the bypass is legible in both places rather than invisible.

**Dev**: I made a worktree off this repo and my commits there sail through with no hook output at all. The `.husky/` files are right there in the checkout.

**Domain expert**: The files being there is execution; you are missing **Hook activation**. Check `git config core.hooksPath`. If it is absolute, the shared `.git/config` was pointing every worktree at one checkout's hooks, and that one has since moved or the worktree resolves outside itself. Run `init` in the worktree: it repairs the value to the relative `.husky`, which resolves against each worktree's own root, and it re-asserts the executable bit, since git skips a non-executable hook with only a hint. If your commits already landed unenforced, the Commit hygiene gate will still catch them on the PR: that is the backstop for exactly this.

**Dev**: Can't the repo just activate its own hooks on clone, so nobody has to remember?

**Domain expert**: No, and deliberately so: git refuses to let a repository configure hook execution for whoever clones it, because that is arbitrary code running unbidden. `core.hooksPath` is per-clone config that is never committed. So the guarantee we can offer is one legible activation step per clone (`init`, or `git config core.hooksPath .husky` with no tooling), covering every linked worktree afterwards, with CI as the un-bypassable copy of the same rules.
