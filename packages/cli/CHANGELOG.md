# Changelog

All notable changes to the `@mstar-harness/cli` package are documented in this file.

The monorepo root [CHANGELOG.md](../../CHANGELOG.md) summarizes cross-surface releases.

## 1.0.6

- Version alignment with harness **1.0.6** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.6**.

## 1.0.5

- Version alignment with harness **1.0.5** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.5**.

## 1.0.4

- Version alignment with harness **1.0.4** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.4**.

## 1.0.3

- Version alignment with harness **1.0.2** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.2**.

## 1.0.1

- Version alignment with harness **1.0.1** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.1**.

## 1.0.0

- Project `init`/`doctor`: append/check `.mstar/sdd/` and `.agents/sdd/` gitignore entries for SDD scratch.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.0**.

## 0.5.4

- **Layout fix**: Cursor global/project plugin paths are **real git checkouts** (`git clone` / `git pull`), not symlinks to `~/.mstar/harness`. Cursor does not discover symlinked plugin directories.
- `doctor --target cursor` fails if the plugin path is a symlink; `init` removes an existing symlink and clones.
- `~/.mstar/harness` remains the shared checkout for Codex marketplace local source and agent symlinks.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.7.2**.

## 0.5.1

- align Cursor global/project plugin symlinks to `morning-star-harness` (matching plugin manifest `name`)
- validate plugin `agents/*.md` use Cursor-first frontmatter in `doctor --target cursor`

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.11**.

## 0.5.0

- maintain a shared local harness checkout at `~/.mstar/harness` for Cursor and Codex install flows
- change Cursor global/project installs to symlink host plugin paths to `~/.mstar/harness`
- change Codex installs to local-source marketplace entries and symlink `codex/agents/*.toml` into global/project Codex agent directories
- validate the local repo, marketplace entry, and Codex agent symlinks in `doctor --target codex`

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
  - `global`: install plugin via symlink at `~/.cursor/plugins/local/morning-star-harness`
  - `project`: install plugin via symlink at `.cursor/plugins/morning-star-harness`
- keep `opencode` model-driven init flow with schema/plugin/model validation
- default `--scope` behavior to `project` when not provided
- add standalone CLI docs at `docs/cli.md` and document target-based usage
