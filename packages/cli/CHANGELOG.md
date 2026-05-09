# Changelog

All notable changes to the `@mstar-harness/cli` package are documented in this file.

## 0.2.0

- add target adapter architecture for CLI flows
- add `cursor` target support in `init` and `doctor`
  - `global`: install plugin via clone into `~/.cursor/plugins/local/mstar-harness`
  - `project`: install plugin as git submodule at `.cursor/plugins/mstar-harness`
- keep `opencode` model-driven init flow with schema/plugin/model validation
- default `--scope` behavior to `project` when not provided
- add standalone CLI docs at `docs/cli.md` and document target-based usage
