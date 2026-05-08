# mstar-harness CLI Guide

This guide documents the standalone `mstar-harness` CLI for OpenCode bootstrap.

## Fast Path

Use this sequence for the quickest user flow:

1) Preview what will change:

- `npx mstar-harness init --dry-run --scope project --yes --pm-model openai/gpt-5.5 --strategic-models openai/gpt-5.5 --dev-models openai/gpt-5.3-codex --qc-models openai/gpt-5.5,openai/gpt-5.4,openai/gpt-5.3-codex --other-models openai/gpt-5.5`

2) Apply the setup:

- `npx mstar-harness init --scope project --yes --pm-model openai/gpt-5.5 --strategic-models openai/gpt-5.5 --dev-models openai/gpt-5.3-codex --qc-models openai/gpt-5.5,openai/gpt-5.4,openai/gpt-5.3-codex --other-models openai/gpt-5.5`

3) Verify the final config:

- `npx mstar-harness doctor --scope project`

## Install

Use one of the following:

- `npx mstar-harness --help`
- `bunx mstar-harness --help`

Tip: If your network/npm mirror is slow, you can run the same commands with `bunx`.

## User Commands

### `mstar-harness init`

Interactive bootstrap:

- `npx mstar-harness init`
- `bunx mstar-harness init`

Non-interactive bootstrap:

- `npx mstar-harness init --yes --target opencode --scope project --pm-model openai/gpt-5.5 --strategic-models openai/gpt-5.5,openai/gpt-5.4 --dev-models openai/gpt-5.3-codex,openai/gpt-5.5-fast --qc-models openai/gpt-5.5,openai/gpt-5.4,openai/gpt-5.3-codex --other-models openai/gpt-5.5,openai/gpt-5.4`

Dry-run preview (no file write):

- `npx mstar-harness init --dry-run --scope project --output .tmp/opencode.json --yes --pm-model openai/gpt-5.5 --strategic-models openai/gpt-5.5 --dev-models openai/gpt-5.3-codex --qc-models openai/gpt-5.5,openai/gpt-5.4,openai/gpt-5.3-codex --other-models openai/gpt-5.5`

### `mstar-harness doctor`

Check an existing config:

- `npx mstar-harness doctor --target opencode --scope project`
- `npx mstar-harness doctor --output ./opencode.json`

If validation fails, `doctor` exits with a non-zero status code.

## What `init` Ensures

`init` enforces these baseline requirements in `opencode.json`:

- `"$schema": "https://opencode.ai/config.json"`
- `plugin` contains `morning-star@git+https://github.com/btspoony/mstar-harness.git` (deduplicated)
- all Morning Star roles have `agent.<role>.model`

## Options Reference

### Shared

- `--output <path>`: explicit config path (absolute or relative to project root)

### `init` options

- `--yes`: non-interactive mode
- `--target <opencode>`
- `--scope <global|project>`
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
- `bun run cli:publish:dry-run`
- `bun run cli:publish`

### Target Adapter Architecture

The CLI uses a target adapter layer so new code agents can be added without rewriting `init`/`doctor`.

- Adapter registry: `packages/cli/src/adapters/index.ts`
- OpenCode adapter: `packages/cli/src/adapters/opencode.ts`
- Shared contracts: `packages/cli/src/types.ts`

To add a new agent target, implement a new adapter with:

- model discovery (`getAvailableModels`)
- config path resolution (`resolveConfigPath`)
- init mutation (`mutateConfigForInit`)
- doctor validation (`validateConfig`)
