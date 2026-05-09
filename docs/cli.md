# mstar-harness CLI Guide

This guide documents the standalone `@mstar-harness/cli` package (command: `mstar-harness`) for OpenCode and Cursor bootstrap.

## Fast Path

Use this sequence for the quickest user flow.

### OpenCode

1) Preview what will change:

- `npx @mstar-harness/cli init --target opencode --dry-run --yes --pm-model openai/gpt-5.5 --strategic-models openai/gpt-5.5 --dev-models openai/gpt-5.3-codex --qc-models openai/gpt-5.5,openai/gpt-5.4,openai/gpt-5.3-codex --other-models openai/gpt-5.5`

2) Apply the setup:

- `npx @mstar-harness/cli init --target opencode --yes --pm-model openai/gpt-5.5 --strategic-models openai/gpt-5.5 --dev-models openai/gpt-5.3-codex --qc-models openai/gpt-5.5,openai/gpt-5.4,openai/gpt-5.3-codex --other-models openai/gpt-5.5`

3) Verify the final config:

- `npx @mstar-harness/cli doctor --target opencode`

### Cursor

1) Install plugin to project (default scope):

- `npx @mstar-harness/cli init --target cursor`

2) Verify project install:

- `npx @mstar-harness/cli doctor --target cursor`

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

OpenCode non-interactive bootstrap:

- `npx @mstar-harness/cli init --yes --target opencode --scope project --pm-model openai/gpt-5.5 --strategic-models openai/gpt-5.5,openai/gpt-5.4 --dev-models openai/gpt-5.3-codex,openai/gpt-5.5-fast --qc-models openai/gpt-5.5,openai/gpt-5.4,openai/gpt-5.3-codex --other-models openai/gpt-5.5,openai/gpt-5.4`

Dry-run preview (no file write):

- `npx @mstar-harness/cli init --dry-run --scope project --output .tmp/opencode.json --yes --pm-model openai/gpt-5.5 --strategic-models openai/gpt-5.5 --dev-models openai/gpt-5.3-codex --qc-models openai/gpt-5.5,openai/gpt-5.4,openai/gpt-5.3-codex --other-models openai/gpt-5.5`

Cursor install:

- Global install (clone to `~/.cursor/plugins/local/mstar-harness`):
  - `npx @mstar-harness/cli init --target cursor --scope global`
- Project install (git submodule at `.cursor/plugins/mstar-harness`):
  - `npx @mstar-harness/cli init --target cursor --scope project`

### `mstar-harness doctor`

Check an existing config:

- `npx @mstar-harness/cli doctor --target opencode --scope project`
- `npx @mstar-harness/cli doctor --output ./opencode.json`
- `npx @mstar-harness/cli doctor --target cursor --scope global`
- `npx @mstar-harness/cli doctor --target cursor --scope project`

If validation fails, `doctor` exits with a non-zero status code.

## What `init` Ensures

OpenCode `init` enforces these baseline requirements in `opencode.json`:

- `"$schema": "https://opencode.ai/config.json"`
- `plugin` contains `@mstar-harness/opencode@latest` (legacy `morning-star@git+…` lines for `btspoony/mstar-harness` are stripped on init, including URLs without `.git`, `ssh://`, or `#tag`)
- all Morning Star roles have `agent.<role>.model`

## What `doctor` Checks (OpenCode)

- Same schema, role models, and presence of **either** `@mstar-harness/opencode…` **or** a recognized legacy `morning-star@git+…` line (so existing git-based configs still pass).
- If only legacy git is present, or legacy and npm are both listed, `doctor` prints **yellow recommendations** and still exits 0; run `init` to normalize to `@mstar-harness/opencode@latest`.

## Options Reference

### Shared

- `--output <path>`: explicit config path (absolute or relative to project root)

### `init` options

- `--yes`: non-interactive mode
- `--target <opencode|cursor>`
- `--scope <global|project>` (default: `project`)
- `--dry-run`
- `--pm-model <model>`
- `--strategic-models <a,b,c>`
- `--dev-models <a,b,c>`
- `--qc-models <a,b,c>`
- `--other-models <a,b,c>`

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
- Shared contracts: `packages/cli/src/types.ts`

To add a new agent target, implement a new adapter with:

- model discovery (`getAvailableModels`)
- config path resolution (`resolveConfigPath`)
- init mutation (`mutateConfigForInit`)
- doctor validation (`validateConfig`)
