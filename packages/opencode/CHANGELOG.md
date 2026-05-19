# Changelog

All notable changes to the `@mstar-harness/opencode` package are documented in this file.

The monorepo root [CHANGELOG.md](../../CHANGELOG.md) summarizes cross-surface releases.

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
