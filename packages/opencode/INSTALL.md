# Installing Morning Star for OpenCode

## Prerequisites

- [OpenCode.ai](https://opencode.ai) installed

## Installation

Add Morning Star to the `plugin` array in your `opencode.json` (global or project-level).

If you use Superpowers together, use:

```json
{
  "plugin": [
    "superpowers@git+https://github.com/obra/superpowers.git",
    "@mstar-harness/opencode@latest"
  ]
}
```

Restart OpenCode. The plugin installs from npm and registers Morning Star runtime paths.

## Usage

- Keep your role models and permissions in `opencode.json`.
- Morning Star plugin loads:
  - `<workspace>/skills/*` (your project checkout)
  - packaged host skills from `@mstar-harness/opencode`
  - `<workspace>/agents/*.md`
- Bootstrap prompt entry is injected once with `<IMPORTANT_FOR_HARNESS>`.

Run OpenCode from your **project root** (or ensure `process.cwd()` is the workspace that contains `skills/` and `agents/`) so those directories resolve correctly.

## Updating

Change the plugin specifier to pick a new dist tag, for example:

```json
{
  "plugin": ["@mstar-harness/opencode@latest"]
}
```

Restart OpenCode after edits.

## Legacy (git-based) installs

Older configs used:

`morning-star@git+https://github.com/btspoony/mstar-harness.git`

The `@mstar-harness/cli` package (`npx @mstar-harness/cli init`) migrates that entry to `@mstar-harness/opencode@latest`.

## Troubleshooting

### Plugin not loading

1. Check logs: `opencode run --print-logs "hello" 2>&1 | grep -i superpowers`
2. Verify the plugin line in your `opencode.json`
3. Make sure you're running a recent version of OpenCode

### Skills not found

1. Use `skill` tool to list what's discovered
2. Check that the plugin is loading (see above)
3. Confirm your current working directory is the repository root that contains `skills/`
