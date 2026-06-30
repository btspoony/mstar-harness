# Changelog

All notable changes to the `@mstar-harness/opencode` package are documented in this file.

The monorepo root [CHANGELOG.md](../../CHANGELOG.md) summarizes cross-surface releases.

## 0.7.2

- Docs only at package level: root **0.7.2** documents CLI Cursor install layout (real git checkout at plugin path, not symlink). Re-bundle on publish if CLI dist changed.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.7.2**.

## 0.7.1

- Bundled commands/skills: `/iteration-start` §5 Review & Edit chain is a hard gate before integration branch commit — Task dispatch for product-manager, architect, writing-specialist; evidence is edited docs + locked compass (no iteration `reports/` artifacts). Synced in `mstar-iteration` §1.6, `pm`, `mstar-dispatch-gates`, `mstar-harness-core`.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.7.1**.

## 0.6.22

- Bundled skills: `mstar-dispatch-gates`, `mstar-roles` (qc-specialist-shared, dispatch-and-assignment) — replace prohibition-based anti-recursion with identity-deprivation framework. Assignment template gains IDENTITY + CAPABILITY BOUNDARY blocks before prohibitions, shifting from "I must not dispatch" (negation) to "I am a leaf executor; Task is not my tool" (capability deprivation).

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.22**.

## 0.6.21

- Bundled skills: `mstar-design-md` — add YAML frontmatter as SSOT for token values in templates and spec. Bump template format version to 0.1.0.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.21**.

## 0.6.20

- Bundled commands: `/iteration-start` §5 changed to "Review & Edit Chain" — each reviewer now directly edits documents rather than only flagging issues. PM only does the final lock.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.20**.

## 0.6.19

- Bundled skills: `mstar-coding-behavior` strengthened with distilled Ponytail principles — YAGNI gate, The Ladder (7-level decision hierarchy), "deletion over addition / boring over clever", `simplify:` marker discipline, "bug fix = root cause", and "minimal check for non-trivial logic".

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.19**.

## 0.6.18

- Bundled commands: `/iteration-start` now includes explicit `## 0. Boot` section aligned with `/iteration-drive`, loading core harness entry and PM role identity before research.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.18**.

## 0.6.17

- Bundled commands: `/iteration-drive` PR target now resolved from iteration metadata (`target_branch` in `status.json`), defaulting to `main` when not set.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.17**.

## 0.6.16

- Bundled commands: Add `/iteration-drive` command that invokes the PM Autonomous Execute driver to push all non-`Done` plans to completion (implement → QC → QA → Done loop, then optional PR to `main`).

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.16**.

## 0.6.15

- Bundled commands: New `harness-commands/` directory bundle and `loadBundledCommands()` registration in the config hook. Adds `/iteration-start` command that guides PM through iteration bootstrap (research, explore, lock, compass/plans, review chain, integration branch).

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.15**.

## 0.6.11

- Bundled agents: Cursor-first frontmatter on all role shells so hosts that share `agents/*.md` parse `name`/`description`/`model` before OpenCode fields.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.11**.

## 0.6.10

- Bundled skills: Profile B `archived/plans-done.json` schema is `{ "plans": [<plan-id>, ...] }` only; add `plans-done.empty.json` template and bootstrap/PM init notes.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.10**.

## 0.6.9

- Bundled skills: universal `pm` orchestration entry (Cursor/Codex `/pm`, OpenCode PM role switch) and Autonomous Execute driver (`status.json` backlog, `spec_integration_branch`, per-plan feature branches, host todos).

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.9**.

## 0.6.8

- Bundled skills: targeted QC re-review after fixes (owner seat only, in-place reports), short QC report basenames under `reports/<plan-id>/` (`qc1.md` …).

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.8**.

## 0.6.7

- Bundled skills: Codex Plan / Goal Mode bridge for keeping `/plan`, `update_plan`, `/goal`, and goal progress aligned with `.mstar/` SSOT.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.7**.

## 0.6.6

- Bundled skills/agents: Codex custom-agent source files, `.mstar/` harness defaults, and updated host install docs.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.6**.

## 0.6.5

- Bundled skills: Durable Roadmap Gate for staged/partial/temporary work, plus routing-eval v8.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.5**.

## 0.6.4

- Bundled skills: Cursor Plan Build resume contract and routing-eval v7.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.4**.

## 0.6.3

- Bundled skills: slim `/pm` with dispatch-first + `/pm`-only rules; PM shell pointer.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.3**.

## 0.6.2

- Bundled skills: `/pm` Autonomous Execute push (iteration driver, multi-plan); PM shell cross-reference.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.2**.

## 0.6.1

- Bundled skills: `tech-debt-rollup.sh`, PM dual fullstack spread defaults, routing-eval v6.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.1**.

## 0.6.0

- Unified **`mstar-host`** in bundled `harness-skills/`; removed separate package `skills/` host path.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.0**.

## 0.5.1

### Bundled harness skills (`harness-skills/` at publish)

- Cursor Plan mode dual-write bridge (`mstar-host`, `cursor-plan-mode-bridge`, `pm`, `mstar-harness-core`); `rules/mstar-cursor-plan-mode.mdc`.

See root [CHANGELOG.md](../../CHANGELOG.md).

## 0.5.0

### Bundled harness skills (`harness-skills/` at publish)

- Align bundled assets with the 0.5.0 harness release, including Codex plugin validation fixes in shared skill metadata.

See root [CHANGELOG.md](../../CHANGELOG.md).

## 0.4.1

### Bundled harness skills (`harness-skills/` at publish)

- **`mstar-plan-artifacts/templates/`**: `status.empty.json` and `notes.empty.json` moved from `mstar-plan-conventions` (paths in skill text updated).

See root [CHANGELOG.md](../../CHANGELOG.md).

## 0.4.0

### Bundled harness skills (`harness-skills/` at publish)

- **Topic skill split**: `mstar-phase-gates`, `mstar-dispatch-gates`, `mstar-branch-worktree`, `mstar-plan-artifacts` (status/residual included); slimmer `mstar-harness-core` and `mstar-plan-conventions`.
- **`mstar-roles`**: Per-role required skill lists; host adapters updated for on-demand topic loading.
- **`mstar-plan-conventions`**: `{ITERATION_DIR}`, `{KNOWLEDGE_DIR}`, content boundaries; optional `iteration_compass` / `iteration_refs`.
- **`mstar-phase-gates`**: Prepare **`clarify` core discipline** (shared understanding, explore before asking, recommended answers).

See root [CHANGELOG.md](../../CHANGELOG.md) for full release notes.

## 0.3.2

### Bundled harness skills (`harness-skills/` at publish)

- **`mstar-plan-conventions`**: Formalize `{ITERATION_DIR}` (`{HARNESS_DIR}/iterations/`) and `{KNOWLEDGE_DIR}` (`{HARNESS_DIR}/knowledge/`); add `docs/` vs harness subtree content boundaries; optional `iteration_compass` / `iteration_refs` in `status.json` metadata.
- **`mstar-harness-core`**: Embed Prepare **`clarify` core discipline** — walk the design decision tree to shared understanding, explore the codebase before asking the user, provide a recommended answer per question.

## 0.3.1

- Align package version with monorepo **0.3.1** (see root `CHANGELOG.md` for harness and host-adapter notes bundled via `harness-skills/` / `harness-agents/`).

## 0.3.0

- Align package version with monorepo **0.3.0** (see root `CHANGELOG.md` for harness and host-adapter notes bundled via `harness-skills/` / `harness-agents/`).

## 0.2.0

- Publish OpenCode plugin with bundled repo `skills/` and `agents/` (`bundle-assets` / root `postinstall`).
- Remove cwd-based harness path resolution; consume bundled assets only.
