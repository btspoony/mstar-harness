# Changelog

All notable changes to the `@mstar-harness/opencode` package are documented in this file.

The monorepo root [CHANGELOG.md](../../CHANGELOG.md) summarizes cross-surface releases.

## 0.5.1

### Bundled harness skills (`harness-skills/` at publish)

- Cursor Plan mode dual-write bridge (`mstar-host-cursor`, `cursor-plan-mode-bridge`, `pm`, `mstar-harness-core`); `rules/mstar-cursor-plan-mode.mdc`.

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
