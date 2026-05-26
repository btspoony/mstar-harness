# Changelog

All notable changes to the `@mstar-harness/cli` package are documented in this file.

The monorepo root [CHANGELOG.md](../../CHANGELOG.md) summarizes cross-surface releases.

## 0.4.0

- add `codex` target support in `init` and `doctor`
- write/update `~/.agents/plugins/marketplace.json` with a `"source": "url"` personal marketplace entry for Codex
- validate Codex personal marketplace metadata in `doctor --target codex`

## 0.3.1

- Version alignment with monorepo **0.3.1** (no CLI API change in this bump; see root changelog for harness/docs).

## 0.3.0

- Version alignment with monorepo **0.3.0** (no CLI API change in this bump; see root changelog for harness/docs).

## 0.2.0

- add target adapter architecture for CLI flows
- add `cursor` target support in `init` and `doctor`
  - `global`: install plugin via clone into `~/.cursor/plugins/local/mstar-harness`
  - `project`: install plugin as git submodule at `.cursor/plugins/mstar-harness`
- keep `opencode` model-driven init flow with schema/plugin/model validation
- default `--scope` behavior to `project` when not provided
- add standalone CLI docs at `docs/cli.md` and document target-based usage
