// The per-scaffold manifest (ADR 0016): for each independently-installable unit,
// the files it vendors, the labels it needs on the remote, and whether it claims
// `core.hooksPath`. It replaces the flat `TEMPLATES` + `GATE_LABELS` lists so that
// "touch only that scaffold" is expressible, which is what a partial install and a
// future `uninstall` both need.
//
// A Scaffold is not a Gate. `quality-gates` bundles two gates, coupled because the
// PR gate's transitive linked-issue check reads the issue gate's `issue-quality:*`
// labels: installing one without the other would fail every PR that closes an
// issue, so coupling them dissolves the only dependency edge between scaffolds
// rather than managing it. `commit-hygiene` bundles one gate; `git-hooks` bundles
// none. The result is three units with zero dependency edges, so any subset
// installs coherently.
//
// `templates/` stays the canonical bundle every destination is a verbatim,
// byte-for-byte copy of, which is what makes exact equality a precise drift signal
// (ADR 0003).

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LABEL_META,
  PR_LABEL_META,
  COMMIT_LABEL_META,
  OVERRIDE_LABEL,
  PR_OVERRIDE_LABEL,
  COMMIT_OVERRIDE_LABEL,
  OVERRIDE_LABEL_META,
  WONTFIX_LABEL_META,
  SCAFFOLD,
  SCAFFOLD_IDS,
} from "./constants.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/**
 * Flatten one or more `{ name: { color, description } }` metadata maps into the
 * `{ name, color, description }` shape the label loop reconciles, so that loop
 * stays one pass over a list, mirroring the file loop above it.
 * @param {...Record<string, {color: string, description: string}>} metas
 * @returns {{name: string, color: string, description: string}[]}
 */
const labels = (...metas) =>
  metas.flatMap((meta) =>
    Object.entries(meta).map(([name, { color, description }]) => ({
      name,
      color,
      description,
    })),
  );

/**
 * Pick a single override label out of the shared `OVERRIDE_LABEL_META`. The three
 * overrides live in one map because they are one conceptual escape hatch, but they
 * belong to different scaffolds, so each is claimed by name rather than by
 * flattening the map wholesale.
 * @param {string} name
 * @returns {{name: string, color: string, description: string}}
 */
const override = (name) => ({
  name,
  .../** @type {Record<string, {color: string, description: string}>} */ (
    OVERRIDE_LABEL_META
  )[name],
});

/**
 * One installable unit.
 * @typedef {object} Scaffold
 * @property {string} id - The recorded manifest id, from `SCAFFOLD`.
 * @property {string} summary - One line, shown by `--help` and the TTY prompt.
 * @property {{from: string, to: string, exec?: boolean}[]} files - Verbatim copies.
 * @property {{name: string, color: string, description: string}[]} labels
 * @property {boolean} activatesHooks - Whether it claims `core.hooksPath`.
 */

/** @type {Scaffold[]} */
export const SCAFFOLDS = [
  {
    id: SCAFFOLD.QUALITY_GATES,
    summary:
      "Issue Form + PR Form, their Author guides, and the issue-quality and pr-readiness workflows",
    files: [
      {
        // Consumer's copy is UI-only; the gate reads structure from its own checkout.
        from: join(ROOT, "templates", "form", "task.yml"),
        to: join(".github", "ISSUE_TEMPLATE", "task.yml"),
      },
      {
        // Issue Author guide: the LLM-facing companion to the Issue Form, dropped
        // at the consumer root under a non-reserved name GitHub ignores.
        from: join(ROOT, "templates", "markdown", "issue.md"),
        to: ".template.issue.md",
      },
      {
        from: join(ROOT, "templates", "workflow", "issue-quality.yml"),
        to: join(".github", "workflows", "issue-quality.yml"),
      },
      {
        // Markdown PR Form, GitHub rendering: GitHub posts it as the PR body.
        // The canonical source is `templates/markdown/pr.md`, written
        // byte-for-byte to both destinations. Because the two are identical
        // bytes, PR authoring guidance stays in HTML comments so it never prints
        // into the posted PR body (ADR 0003).
        from: join(ROOT, "templates", "markdown", "pr.md"),
        to: join(".github", "PULL_REQUEST_TEMPLATE.md"),
      },
      {
        // PR Author guide: the same bytes at the consumer root under a
        // non-reserved name GitHub ignores, the path the Suggested rule points
        // agents at.
        from: join(ROOT, "templates", "markdown", "pr.md"),
        to: ".template.pr.md",
      },
      {
        from: join(ROOT, "templates", "workflow", "pr-readiness.yml"),
        to: join(".github", "workflows", "pr-readiness.yml"),
      },
    ],
    // Both gate triples, both their overrides, and `wontfix`. The Rejection
    // selector belongs here because the issue gate is what reads it.
    labels: [
      ...labels(LABEL_META, PR_LABEL_META),
      override(OVERRIDE_LABEL),
      override(PR_OVERRIDE_LABEL),
      ...labels(WONTFIX_LABEL_META),
    ],
    activatesHooks: false,
  },
  {
    id: SCAFFOLD.COMMIT_HYGIENE,
    summary:
      "the commit-hygiene workflow: the un-silenceable CI mirror of the commit baseline",
    files: [
      {
        // No new Form or guide; the gate reads the PR's commits and diff, not a
        // body the author fills in.
        from: join(ROOT, "templates", "workflow", "commit-hygiene.yml"),
        to: join(".github", "workflows", "commit-hygiene.yml"),
      },
    ],
    labels: [...labels(COMMIT_LABEL_META), override(COMMIT_OVERRIDE_LABEL)],
    activatesHooks: false,
  },
  {
    id: SCAFFOLD.GIT_HOOKS,
    summary:
      "the vendored commit-msg and pre-commit hooks: bypassable fast local feedback on the same baseline",
    files: [
      {
        // Repo-contract commit-msg hook (Conventional Commits subject, em-dash
        // policy). Vendored as a committed hook so it enforces where
        // `~/.dotfiles` is absent (CI, containers, fresh worktrees); jq/git/sh
        // only, no node_modules, so it runs before `yarn install` (ADR 0002,
        // ADR 0012, ADR 0015). Git executes it directly via `core.hooksPath`,
        // which is why it is written executable.
        from: join(ROOT, "templates", "git-hooks", "commit-msg"),
        to: join(".repo-contract", "hooks", "commit-msg"),
        exec: true,
      },
      {
        // Repo-contract pre-commit hook (no default-branch commits, em-dash
        // policy in staged Markdown). Same vendoring rationale as commit-msg.
        // Repo-specific checks belong in `.repo-contract/hooks/local/pre-commit`,
        // which `init` never writes.
        from: join(ROOT, "templates", "git-hooks", "pre-commit"),
        to: join(".repo-contract", "hooks", "pre-commit"),
        exec: true,
      },
    ],
    // Hooks run locally against a committed config; nothing on the remote.
    labels: [],
    activatesHooks: true,
  },
];

/**
 * Look up a scaffold by id. Ids are validated where the manifest is parsed, so an
 * unknown one here is a programming error rather than bad consumer input.
 * @param {string} id
 * @returns {Scaffold}
 */
export function scaffold(id) {
  const found = SCAFFOLDS.find((s) => s.id === id);
  if (!found) throw new Error(`Unknown scaffold: ${id}`);
  return found;
}

/**
 * The scaffolds named by a selection, in `SCAFFOLD_IDS` order so every report,
 * prompt, and manifest lists them the same way.
 * @param {string[]} ids
 * @returns {Scaffold[]}
 */
export function selected(ids) {
  return SCAFFOLD_IDS.filter((id) => ids.includes(id)).map(scaffold);
}

/**
 * Every file a selection vendors, flattened for the copy loop.
 * @param {string[]} ids
 * @returns {{from: string, to: string, exec?: boolean}[]}
 */
export function filesFor(ids) {
  return selected(ids).flatMap((s) => s.files);
}

/**
 * Every label a selection needs on the remote, deduplicated by name. Labels are
 * per-scaffold so an unselected gate's labels are never created: nothing should
 * appear in a repo's label list for a gate it did not install.
 * @param {string[]} ids
 * @returns {{name: string, color: string, description: string}[]}
 */
export function labelsFor(ids) {
  const byName = new Map();
  for (const { labels: list } of selected(ids)) {
    for (const label of list) byName.set(label.name, label);
  }
  return [...byName.values()];
}
