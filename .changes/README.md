# Changelog fragments

This directory holds per-change **changelog fragments** that `scripts/prepare-release.ts`
assembles into `CHANGELOG.md` / `CHANGELOG_CN.md` / `packages/*/CHANGELOG.md` at release time.

## Workflow

1. **During development**, add one fragment per logical change to `unreleased/`:
   `unreleased/<slug>.md` (e.g. `unreleased/add-dispatch-gate.md`). Commit it with the change.
2. **At release time**, `bun run release:prepare -- <version>` (or the **Release prep** GitHub
   Actions workflow) reads every `unreleased/*.md`, inserts a `## [<version>]` section into each
   changelog, bumps all version surfaces, and **moves** the consumed fragments into
   `archive/<version>/`.
3. The prepared changes ship as a `release vX.Y.Z` PR; merging it tags + publishes (see
   `.github/workflows/release.yml` and `AGENTS.md` → *Release Process*).

## Fragment format

```markdown
---
category: Harness        # optional; section header. Default per package (see below).
packages: root           # optional; comma list of root | cli | opencode. Default: root.
---

- English bullet (markdown). Use **bold** lead-ins like the real changelogs.
- Another English bullet.

<!-- CN -->
- 中文要点（markdown）。
- 另一条中文要点。
```

- **`category`** drives the `### <Category>` header under the version section.
  Defaults: `root` → `Harness`, `cli` → `Changed`, `opencode` → `Bundled harness skills (\`harness-skills/\` at publish)`.
- **`packages`** routes bullets to changelog(s). `root` → root EN + root CN.
  `cli`/`opencode` → that package's changelog (EN only).
- The body before `<!-- CN -->` is English; after it is Chinese. Chinese is written only to
  `CHANGELOG_CN.md` (root). If a `root` fragment omits the CN block, the English bullets are
  reused for the Chinese section.
- A release always appends an auto-generated **Version alignment** block — do not write one.

## Example

```markdown
---
category: Harness
packages: root
---

- Added a **field-completeness gate** at the dispatch self-check: a missing role-binding field is now dispatch-incomplete.
- Updated `mstar-dispatch-gates` + `mstar-host/references/omp.md`.

<!-- CN -->
- 在派发自检处新增**逐项字段完整性门禁**：漏写角色绑定字段现为派发未完成。
- 更新 `mstar-dispatch-gates` + `mstar-host/references/omp.md`。
```
