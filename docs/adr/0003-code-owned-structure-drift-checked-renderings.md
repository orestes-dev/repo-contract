# Code-owned structure, drift-checked renderings

The project began with the GitHub Issue Form YAML as the single source of truth:
`form.js` parsed `task.yml` at runtime to derive issue structure, and `rules.js`
held only the constraints the form could not express. That premise no longer
holds. The YAML issue-form schema is too restricted to carry the guidance an LLM
author needs (examples, voice, notes), and reading structure from it at runtime
coupled the gate to a format chosen for GitHub's UI rather than for the gate.

The structural source of truth is now **code**: the ordered field descriptor in
`rules.js` (issues) and `PR_SECTIONS` (PRs), which own id, heading, order, type,
required, options, and the constraints together. The validator reads these
directly; `form.js` is deleted and nothing reads the YAML at runtime. Every other
representation is a **rendering** of that source, drift-tested so it cannot
diverge in structure:

- the **GitHub-native rendering** (`task.yml` for the issue-form UI,
  `.github/PULL_REQUEST_TEMPLATE.md` for the PR body), read only by GitHub and the
  drift tests;
- the **Author guide** (`.template.issue.md`, `.template.pr.md` at the repo root),
  the LLM-facing Markdown an author follows, ignored by GitHub because the names
  are not reserved template paths.

Each rendering is checked as strictly as its format allows: the YAML on headings,
order, required, and options; the Markdown guides on headings and order only,
since their prose is deliberately richer than the GitHub rendering and free to
differ. `templates/` is the canonical bundle; this repo's `.github/` and root
files are a dogfood instance drift-checked to match it.

## Considered options

- **Read the Markdown Author guide at runtime** (parse headings, join to
  `rules.js` for id/type/required/options). Rejected: it keeps a runtime file
  read and a runtime join, and leaves the two gates asymmetric (the PR gate
  already reads a code descriptor). Moving all structure into code makes both
  gates symmetric and drops the runtime parse entirely.
- **Keep the YAML authoritative for required/type/options.** Rejected: it leaves
  the gate driven by the restricted YAML and forces reading two files. The whole
  motivation was to stop the YAML from driving anything.

## Consequences

- **Two prose homes for issue fields, on purpose.** The YAML descriptions serve
  GitHub's UI; the Author guide serves an LLM. They are different audiences, so
  only structure (headings, order) is drift-checked between them; the guidance
  prose is allowed to differ and is not compared.
- **The PR Author guide is byte-identical to the native PR template.**
  `.template.pr.md` == `.github/PULL_REQUEST_TEMPLATE.md`, guarded by an equality
  drift test. Because the same bytes render as the posted PR body, PR authoring
  guidance must live in HTML comments, so the PR guide is less rich than the
  issue guide.
- **A dogfood drift test is added:** this repo's applied copies must equal the
  `templates/` bundle, so dogfooding cannot silently drift from what `init`
  ships.
- **`scaffold` is removed.** Its blank heading skeleton is superseded by the
  committed Author guide an agent follows directly.
