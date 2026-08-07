# Changelog

All notable changes to the `@mstar-harness/cli` package are documented in this file.

The monorepo root [CHANGELOG.md](../../CHANGELOG.md) summarizes cross-surface releases.

## [Unreleased]

## [1.8.9] - 2026-08-07

### Changed

- Added a portable **Agent Plugins v1.0.0** manifest (`plugin.json`) at the repo root, aligned with the CLI release surface (`skills/` is the Agent Skills component), plus `mstar-harness plugin validate` to check the package (including `mcp.json` / `skills/`) against the Agent Plugins v1.0.0 spec.

- Version alignment with harness **1.8.9**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.9**.

## [1.8.8] - 2026-08-06

### Changed

- Version alignment with harness **1.8.8**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.8**.

## [1.8.7] - 2026-08-06

### Changed

- Version alignment with harness **1.8.7**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.7**.

## [1.8.6] - 2026-08-06

### Changed

- Version alignment with harness **1.8.6** (no CLI API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.6**.

## [1.8.5] - 2026-08-06

### Changed

- omp `init` post-install note: Host adapter now `mstar-host → references/omp.md` (`skill://…`) instead of consumer-cwd `skills/mstar-host/…`.
- Version alignment with harness **1.8.5**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.5**.

## [1.8.4] - 2026-08-06

- Version alignment with harness **1.8.4** (skill-relative script path docs; no CLI API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.4**.

## [1.8.3] - 2026-08-05

- Version alignment with harness **1.8.3** (omp host docs prefer live-schema role `task.agent`; no CLI API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.3**.

## [1.8.2] - 2026-08-05

- Derive ZCode marketplace/`doctor` version from `packages/cli/package.json` via shared `readHarnessVersion()` (remove drifted hardcoded `PLUGIN_VERSION`).
- Version alignment with harness **1.8.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.2**.

## [1.8.1] - 2026-08-05

- Version alignment with harness **1.8.1** (no CLI API change; bundled skills/commands optimization landed at the harness layer).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.1**.

## [1.8.0] - 2026-08-05

- **Codex adapter**: `CODEX_PROJECT_COMMAND_NAMES` (renamed from `CODEX_ITERATION_SKILL_NAMES`) now includes `codebase-audit`; project-scoped install materializes it alongside iteration commands. Global-scoped install warning updated.
- **omp adapter**: smoke test (`COMMAND_SMOKE`) and install notes include `codebase-audit`.

## [1.7.1] - 2026-08-05

- Fix omp doctor plugin detection for `omp plugin list --json` `{ npm, marketplace }` shape.
- Version alignment with harness **1.7.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.7.1**.

## [1.7.0] - 2026-08-05

- Add **`omp`** install target (`packages/cli/src/adapters/omp.ts`): link/install Morning Star into omp plugins; doctor validates markers + `omp plugin list`.
- Version alignment with harness **1.7.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.7.0**.


## 1.6.1

- Version alignment with harness **1.6.1** (no CLI API change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.6.1**.

## 1.6.0

- **New `zcode` install target**: `init --target zcode` registers a `mstar-local` marketplace (github source) in `~/.zcode/cli/plugins/{known_marketplaces.json, marketplaces/mstar-local/marketplace.json}`; `doctor --target zcode` validates both JSON files + checkout + gitignore. Project scope keeps a local `.zcode/plugin-checkout` for smoke checks. `SUPPORTED_TARGETS` now includes `zcode`; `shared-install` `HARNESS_MARKERS` also accepts `.zcode-plugin/plugin.json`.
- Version alignment with harness **1.6.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.6.0**.

## 1.5.6

- Version alignment with harness **1.5.6** (no CLI API change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.6**.

## 1.5.5

- Version alignment with harness **1.5.5** (no CLI API change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.5**.

## 1.5.4

- Version alignment with harness **1.5.4** (no CLI API change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.4**.

## 1.5.3

- Version alignment with harness **1.5.3** (no CLI API change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.3**.

## 1.5.2

- Project `init`/`doctor` (Cursor/Codex project scope): append/check full harness **process** gitignore set under `.mstar/` and legacy `.agents/` (`archived/`, `iterations/`, `plans/`, `sdd/`, `notes.json`, `status.json`). Results paths (`knowledge/`, `specs/`, `AGENTS.md`) are not forced gitignored.
- Version alignment with harness **1.5.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.2**.

## 1.5.1

- Version alignment with harness **1.5.1** (Phase 5 push cadence; no CLI API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.1**.

## 1.5.0

- Version alignment with harness **1.5.0** (iteration Phase 2 worktree/lease + Phase 5 babysit-first helpers; no CLI API change in this bump).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.0**.

## 1.4.0

- Version alignment with harness **1.4.0** (Kimi host installs via Kimi TUI `/plugins install`; no CLI `--target kimi`).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.4.0**.

## 1.3.2

- Version alignment with harness **1.3.2** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.3.2**.

## 1.3.1

- Version alignment with harness **1.3.1** (iteration package layout; no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.3.1**.

## 1.3.0

- Codex project install: materialize `iteration-start`, `iteration-drive`, and `iteration-loop` as `.agents/skills/*/SKILL.md` symlinks; `doctor` validates links; global install skips with warning.
- Version alignment with harness **1.3.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.3.0**.

## 1.2.1

- Version alignment with harness **1.2.1** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.2.1**.

## 1.2.0

- OpenCode `init` fast path: schema + plugin only; no interactive model picking / no `opencode models` discovery (avoids silent hangs). Optional `--*-model` flags remain as advanced overrides.
- Version alignment with harness **1.2.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.2.0**.

## 1.1.0

- Version alignment with harness **1.1.0** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.1.0**.

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
