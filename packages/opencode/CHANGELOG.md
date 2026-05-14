# Changelog

All notable changes to the `@mstar-harness/opencode` package are documented in this file.

The monorepo root [CHANGELOG.md](../../CHANGELOG.md) summarizes cross-surface releases.

## 0.3.0

- Align package version with monorepo **0.3.0** (see root `CHANGELOG.md` for harness and host-adapter notes bundled via `harness-skills/` / `harness-agents/`).

## 0.2.0

- Publish OpenCode plugin with bundled repo `skills/` and `agents/` (`bundle-assets` / root `postinstall`).
- Remove cwd-based harness path resolution; consume bundled assets only.
