# Commit hooks keep the sh+jq dependency budget; library delegation is confined to CI and the CLI

The repo-contract baseline (Conventional Commits, the em-dash ban, no
default-branch commits) is enforced on three **execution surfaces**: the vendored
git hooks, the Commit hygiene CI gate, and the CLI validators. Each surface has a
**dependency budget** (the toolchain it may assume is already present), fixed by
when and where it runs. We decided the hooks keep the strictest budget (POSIX
`sh`, `git`, `jq`, never `node_modules`), and that any delegation to a
Conventional-Commits library (commitlint, `conventional-commits-parser`) happens
only on the looser gate and CLI surfaces, which already run node with an install
step behind them. The commit rules are therefore expressed twice (inline sh+grep
in `templates/husky/commit-msg`, and library/JS on the node surfaces), and the two
copies are drift-checked, not collapsed.

The forcing reason is the hook's runtime moment, not taste. The hook runs at
commit time in any checkout state: a fresh clone or linked worktree that commits
before provisioning, a container, a CI checkout, or a consumer repo that has no
`package.json` at all. A hook that reaches for `node_modules` fails exactly in
those cases, which are the cases the vendored, install-free hook exists to cover
(ADR 0007, ADR 0012). Spending a node dependency in the hook would trade the
run-before-install guarantee for a library convenience the CI mirror already
provides.

## Considered options

- **Move the hook onto node + commitlint (one source of truth).** Rejected on
  measured cost. A spawn benchmark (macOS, node v26, cold process per validation,
  which is how git invokes a commit-msg hook):

  | validator                            |  median |  ×sh |
  | ------------------------------------ | ------: | ---: |
  | sh + jq (current)                    |  11.7ms | 1.0× |
  | node, empty script (floor)           |  31.0ms | 2.7× |
  | node + `conventional-commits-parser` |  36.7ms | 3.1× |
  | node + `@commitlint`                 | 114.0ms | 9.8× |

  Node's interpreter startup **alone** is 2.7× the entire sh+jq hook, before any
  dependency loads; the canonical library is ~10× and ~114ms per commit. Bundling
  cannot go below the ~31ms node floor. And commitlint still needs `node_modules`
  present, so it reintroduces the run-before-install failure. The single-source
  win buys nothing the drift check does not already give, at a latency and
  fragility cost paid on every commit.

- **A lighter parser in the hook (`conventional-commits-parser`).** Rejected as a
  false economy: at ~3× it still forfeits "instant," still needs `node_modules`,
  and you keep hand-rolling the type list around it, so it is barely a delegation.

- **Delegate on the gate and CLI only (chosen).** The CI gate already runs
  `yarn install --immutable` (cached) and the CLI resolves deps via npx, so both
  can adopt commitlint with no new constraint. The hook stays the fast
  local-feedback enforcer; CI stays the authority.

## Consequences

- The baseline commit rules are duplicated by design (sh hook ↔ node mirror), an
  Accepted duplication guarded by drift tests, not debt to pay down.
- "Delegate the solved problem to a library" applies per surface, not repo-wide:
  the hook's budget forecloses it there and only there.
- Today's hook check is subject-shape only. Adopting commitlint on the node
  surfaces would widen enforcement (type enum, scope, breaking-change parsing)
  and would then diverge from the deliberately narrower hook, a change to make
  consciously, since the drift check pins the two together.
