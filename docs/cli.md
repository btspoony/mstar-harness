# mstar-harness CLI Guide

This guide documents the standalone `@mstar-harness/cli` package (command: `mstar-harness`) for OpenCode, Cursor, and Codex bootstrap.

## Fast Path

Use this sequence for the quickest user flow.

### OpenCode

1) Preview what will change (schema + plugin only; uses OpenCode default models):

- `npx @mstar-harness/cli init --target opencode --dry-run --yes`

2) Apply the setup:

- `npx @mstar-harness/cli init --target opencode --yes`

3) Verify the final config:

- `npx @mstar-harness/cli doctor --target opencode`

Optional advanced: pass `--pm-model` / `--*-models` flags to write explicit `agent.<role>.model` overrides (does **not** call `opencode models`).

### Cursor

1) Install plugin to project (default scope). The CLI maintains `~/.mstar/harness` and clones a **real directory** at `.cursor/plugins/morning-star-harness` (not a symlink — Cursor cannot load symlinked plugin roots):

- `npx @mstar-harness/cli init --target cursor`

2) Verify project install:

- `npx @mstar-harness/cli doctor --target cursor`

### Codex

1) Add Morning Star to the Codex marketplace metadata and link Codex custom agents. The CLI maintains `~/.mstar/harness`:

- `npx @mstar-harness/cli init --target codex --scope global`

2) Install from that marketplace:

- `codex plugin add morning-star-harness --marketplace personal`

3) Verify marketplace metadata and agent symlinks:

- `npx @mstar-harness/cli doctor --target codex`

## Install

Use one of the following:

- `npx @mstar-harness/cli --help`
- `bunx @mstar-harness/cli --help`

Tip: If your network/npm mirror is slow, you can run the same commands with `bunx`.

## User Commands

### `mstar-harness init`

Interactive bootstrap:

- `npx @mstar-harness/cli init`
- `bunx @mstar-harness/cli init`

`--scope` defaults to `project` when omitted.

OpenCode non-interactive bootstrap (fast path — no model prompts):

- `npx @mstar-harness/cli init --yes --target opencode --scope project`

Dry-run preview (no file write):

- `npx @mstar-harness/cli init --dry-run --scope project --output .tmp/opencode.json --yes`

Optional role-model overrides (advanced; skips live model discovery):

- `npx @mstar-harness/cli init --yes --target opencode --pm-model openai/gpt-5.5 --strategic-models openai/gpt-5.5 --dev-models openai/gpt-5.3-codex --qc-models openai/gpt-5.5,openai/gpt-5.4,openai/gpt-5.3-codex --other-models openai/gpt-5.5`

Cursor install:

- Global install (git checkout at `~/.cursor/plugins/local/morning-star-harness`; shared Codex/OpenCode checkout at `~/.mstar/harness`):
  - `npx @mstar-harness/cli init --target cursor --scope global`
- Project install (git checkout at `.cursor/plugins/morning-star-harness`; the CLI adds it to `.gitignore`):
  - `npx @mstar-harness/cli init --target cursor --scope project`

Codex install:

- Global personal marketplace + custom agents:
  - `npx @mstar-harness/cli init --target codex --scope global`
- Project marketplace + custom agents:
  - `npx @mstar-harness/cli init --target codex --scope project`
- Then install the plugin:
  - `codex plugin add morning-star-harness --marketplace personal`
- Runtime host behavior after install:
  - `/pm` enters the shared PM flow.
  - Codex custom agents are linked from `~/.mstar/harness/codex/agents/*.toml`.
  - Codex-specific clarify, dispatch, sandbox, and tool-discovery rules live in `skills/mstar-host/references/codex.md`.

### `mstar-harness doctor`

Check an existing config:

- `npx @mstar-harness/cli doctor --target opencode --scope project`
- `npx @mstar-harness/cli doctor --output ./opencode.json`
- `npx @mstar-harness/cli doctor --target cursor --scope global`
- `npx @mstar-harness/cli doctor --target cursor --scope project`
- `npx @mstar-harness/cli doctor --target codex`

If validation fails, `doctor` exits with a non-zero status code.

## What `init` Ensures

OpenCode `init` enforces these baseline requirements in `opencode.json`:

- `"$schema": "https://opencode.ai/config.json"`
- `plugin` contains `@mstar-harness/opencode@latest` (legacy `morning-star@git+…` lines for `btspoony/mstar-harness` are stripped on init, including URLs without `.git`, `ssh://`, or `#tag`)
- Role models are **not** required — OpenCode defaults apply unless you pass optional `--*-model` flags

Cursor and Codex `init` ensure a maintained local checkout exists at `~/.mstar/harness`. Codex then creates agent symlinks from that checkout. Cursor clones a **separate real git checkout** at the plugin path (see [Install path layout](#install-path-layout)).

Cursor `init`:

- global: `git clone` / `git pull` at `~/.cursor/plugins/local/morning-star-harness`
- project: `git clone` / `git pull` at `.cursor/plugins/morning-star-harness` and `.gitignore` entry for the plugin directory

Codex `init` writes or updates marketplace metadata with a local-source entry:

- `name`: `morning-star-harness`
- `source.source`: `local`
- `source.path`: `./.mstar/harness` for global scope, `./.codex/plugins/mstar-harness` for project scope
- `policy.installation`: `AVAILABLE`
- `policy.authentication`: `ON_INSTALL`

Codex `init` also links all `codex/agents/*.toml` files into `~/.codex/agents/` for global scope or `.codex/agents/` for project scope. Project scope also links `.codex/plugins/mstar-harness -> ~/.mstar/harness` and adds `.codex/plugins/mstar-harness` plus `.codex/agents/*.toml` to `.gitignore`.

## What `doctor` Checks

- Same schema and presence of **either** `@mstar-harness/opencode…` **or** a recognized legacy `morning-star@git+…` line (so existing git-based configs still pass).
- Missing per-role `agent.<role>.model` is a **yellow recommendation** only (OpenCode defaults are OK).
- If only legacy git is present, or legacy and npm are both listed, `doctor` prints **yellow recommendations** and still exits 0; run `init` to normalize to `@mstar-harness/opencode@latest`.
- For Cursor, `doctor` checks the maintained `~/.mstar/harness` checkout, that the Cursor plugin path is a **real git directory** (not a symlink), and that `agents/*.md` files use Cursor-first frontmatter.
- For Codex, `doctor` checks the local marketplace entry, the maintained `~/.mstar/harness` checkout, and custom-agent symlinks.

## Install path layout

Cursor **does not discover symlinked plugin directories**. Use real directories at the plugin paths below.

| Path | Host | Layout | Notes |
| --- | --- | --- | --- |
| `~/.mstar/harness` | Codex (marketplace `local` source), OpenCode dev bundle | git checkout | Codex agent `.toml` files are **symlinked** from here into `~/.codex/agents/` |
| `~/.cursor/plugins/local/morning-star-harness` | Cursor global plugin | **git checkout (real dir)** | **Not** a symlink to `~/.mstar/harness`; `init` clones or `git pull`s here |
| `.cursor/plugins/morning-star-harness` | Cursor project plugin | **git checkout (real dir)** | gitignored; same clone/pull behavior as global |

`init --target cursor` maintains **two** checkouts: `~/.mstar/harness` (shared with Codex) and the Cursor plugin path (independent clone, kept in sync via `git pull` on each init).

**Maintainers** editing this repository in a separate workspace should refresh the Cursor plugin checkout after merging:

```bash
cd ~/.cursor/plugins/local/morning-star-harness && git pull --ff-only
```

Or re-run `npx @mstar-harness/cli init --target cursor --scope global`.

## Options Reference

### Shared

- `--output <path>`: explicit config path (absolute or relative to project root)

### `init` options

- `--yes`: non-interactive mode
- `--target <opencode|cursor|codex>`
- `--scope <global|project>` (default: `project`)
- `--dry-run`
- `--pm-model <model>` (optional advanced override)
- `--strategic-models <a,b,c>` (optional)
- `--dev-models <a,b,c>` (optional)
- `--qc-models <a,b,c>` (optional)
- `--other-models <a,b,c>` (optional)

### `doctor` options

- `--target <agent>`
- `--scope <global|project>`
- `--output <path>`

## Development (Repository)

These are for contributors developing this repository:

- `bun run cli:dev -- --help`
- `bun run cli:build`

### Target Adapter Architecture

The CLI uses a target adapter layer so new code agents can be added without rewriting `init`/`doctor`.

- Adapter registry: `packages/cli/src/adapters/index.ts`
- OpenCode adapter: `packages/cli/src/adapters/opencode.ts`
- Cursor adapter: `packages/cli/src/adapters/cursor.ts`
- Codex adapter: `packages/cli/src/adapters/codex.ts`
- Shared contracts: `packages/cli/src/types.ts`

To add a new agent target, implement a new adapter with:

- config path resolution (`resolveConfigPath`) **or** install flow (`runInstallInit` / `runInstallDoctor`)
- init mutation (`mutateConfigForInit`) for config-mode targets
- doctor validation (`validateConfig`)
- optional model discovery (`getAvailableModels`) — OpenCode default init does **not** use this (avoids hanging on `opencode models`)
