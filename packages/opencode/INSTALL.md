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
- The plugin loads **only paths inside the `@mstar-harness/opencode` package**:
  - **`harness-skills/`** — copy of Morning Star `skills/` from the release build (`prepublishOnly` runs `bundle-assets` before `bun build`).
  - **`skills/`** — packaged OpenCode host adapter (e.g. `mstar-host`).
  - **`harness-agents/`** — copy of repo `agents/` from the same build.
- It does **not** read `<cwd>/skills` or `<cwd>/agents`, so OpenCode’s `process.cwd()` (your app project root) does not affect harness resolution.
- Bootstrap prompt entry is injected once with `<IMPORTANT_FOR_HARNESS>`.

## Monorepo / git checkout of this repository

After `bun install` or `npm install` at the repo root, **`postinstall`** runs `packages/opencode`’s `bundle-assets` so `harness-skills/` and `harness-agents/` exist for the plugin entry `main` → `packages/opencode/src/mstar.ts`.

If you use `npm install --ignore-scripts`, run once manually:

`bun run opencode:bundle-assets`

(or `bun run --cwd packages/opencode bundle-assets`).

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
3. For **npm** installs, use a published build (tarball includes `harness-skills`). For **git** checkout, ensure install scripts ran (`postinstall` / `bun run opencode:bundle-assets`)
