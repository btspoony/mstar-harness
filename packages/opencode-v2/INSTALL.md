# Installing Morning Star for OpenCode 2.x

This package (`@mstar-harness/opencode-v2`) is the OpenCode 2.x entry. OpenCode 1.x hosts install [`@mstar-harness/opencode`](../opencode/INSTALL.md) instead; the generation-aware CLI picks the right one for you (see below).

## Prerequisites

- [OpenCode.ai](https://opencode.ai) **2.x** installed — the `opencode` CLI must be on `PATH` for a real (non-`--dry-run`) install: the installer refuses a real install when the host binary is missing, naming the OpenCode install, before any config is written.
- **Runtime:** the published plugin runs in OpenCode's Node process and needs **Node >=24.18.0** (`node:sqlite`). Monorepo `bundle-assets` / `bun build` need **Bun >=1.4.0**. Users who only install from npm do not need Bun in addition to OpenCode. The CLI's Bun shebang is a different entrypoint — it needs **Bun >=1.4.0** on PATH even when invoked through `npx`.

## Installation

Run the generation-aware installer:

```bash
npx @mstar-harness/cli init --target opencode --opencode-generation v2
```

`--opencode-generation v2` states the generation explicitly and always wins. Without it, the installer probes `opencode --version` and selects this package when the host major is 2 or later; probe failure refuses with the failure mode and this flag as the recovery — there is no silent fallback.

The command edits `opencode.json` (global or project scope; `init` defaults to `--scope project`), then installs the matching `@mstar-harness/cli` globally unless `--no-global-cli` is passed. Preview the write set without touching the config or the host binary:

```bash
npx @mstar-harness/cli init --target opencode --opencode-generation v2 --dry-run
```

Alternatively, add the plugin entry by hand — the same key the installer writes:

```json
{
  "plugins": ["@mstar-harness/opencode-v2@latest"]
}
```

Restart OpenCode. The plugin installs from npm and registers Morning Star runtime paths.

## What the installer writes

One `init` pass for the V2 generation produces, in the resolved `opencode.json`:

```json
{
  "plugins": ["@mstar-harness/opencode-v2@latest"],
  "agents": {
    "project-manager": { "model": "<your override>" }
  },
  "mcp": {
    "servers": {
      "morning-star": {
        "type": "local",
        "command": ["npx", "@mstar-harness/cli", "mcp"]
      }
    }
  }
}
```

- `plugins` — the owned `@mstar-harness/opencode-v2@latest` slot is appended after dedupe; every unrelated entry keeps its position and shape.
- `agents.<role>.model` — written **only** for overrides you supplied (`--pm-model`, `--strategic-models`, `--dev-models`, `--qc-models`, `--other-models`); without them the key is left to OpenCode's default model.
- `mcp.servers["morning-star"]` — merged non-destructively; an existing morning-star entry is never rewritten, and other servers and `mcp` keys survive.
- `$schema` — preserved if your config already has one and never invented (the pinned `2.0.26` schema tag publishes no V2 `$schema` id).

Repeat runs are idempotent, and the other generation's key (`plugin`, singular) is never deleted or rewritten — see coexistence below.

Verify the result:

```bash
npx @mstar-harness/cli doctor --target opencode --opencode-generation v2
```

`doctor` validates the plural-key contract, reports MCP configuration as `aligned` / `mismatch` / `unavailable`, and checks Node >=24.18.0. Without the flag it resolves the generation the same way `init` does (probe, or both keys validated on a dual-host config).

## Usage

- Keep your role models and permissions in `opencode.json` (`agents.<role>`).
- The plugin loads **only paths inside the `@mstar-harness/opencode-v2` package**:
  - **`harness-skills/`** — copy of repo `skills/` from the release build (`prepublishOnly` runs `bundle-assets` before `bun build`), including **`mstar-host`**.
  - **`harness-agents/`** — copy of repo `agents/` from the same build, plus this package's OpenCode-only primary-seat overlay.
  - **`harness-commands/`** — copy of repo `commands/`.
- It does **not** read `<cwd>/skills` or `<cwd>/agents`, so OpenCode's `process.cwd()` (your app project root) does not affect harness resolution.
- Bootstrap prompt entry is injected once with `<IMPORTANT_FOR_HARNESS>` on the first user message; `system` content is never touched.

## Monorepo / git checkout of this repository

After `bun install` or `npm install` at the repo root, run once so `harness-skills/`, `harness-agents/`, and `harness-commands/` exist for the plugin entry in `packages/opencode-v2/src/entry.ts`:

```bash
bun run opencode-v2:bundle-assets
```

(or `bun run --cwd packages/opencode-v2 bundle-assets`). To produce the published `dist/mstar.js` bundle as well:

```bash
bun run opencode-v2:build
```

## Updating

Change the plugin specifier to pick a new dist tag, for example:

```json
{
  "plugins": ["@mstar-harness/opencode-v2@latest"]
}
```

Or re-run the installer CLI. Restart OpenCode after edits: the running plugin keeps serving its installed build until that restart, and a harness **source** edit is not an install.

## Coexistence with the V1 package

The two generations use different config keys, so one `opencode.json` can carry both:

- **V2** — plural `plugins`, owned slot `@mstar-harness/opencode-v2@latest`, MCP nested under `mcp.servers`.
- **V1** — singular `plugin`, owned slot `@mstar-harness/opencode@latest` (or the legacy `morning-star@git+…` entry), MCP at the top level of `mcp`.

The installer writes only the generation it selected and never rewrites the other key. Running both host generations against one config path is a supported state: `doctor` without an explicit generation validates both and reports per-generation results, and passing `--opencode-generation <v1|v2>` scopes it to one generation. A config whose markers disagree with the resolved generation only produces a warning — markers are a consistency guard, not the selection path.

## Troubleshooting

### Plugin not loading

1. Check logs: `opencode run --print-logs "hello" 2>&1 | grep -i mstar`
2. Verify the `plugins` line in your `opencode.json` (plural key — the singular `plugin` key is the V1 surface and is not read by this package)
3. Make sure you're running OpenCode **2.x**; on 1.x install [`@mstar-harness/opencode`](../opencode/INSTALL.md) instead

### Skills not found

1. Use `skill` tool to list what's discovered
2. Check that the plugin is loading (see above)
3. For **npm** installs, use a published build (tarball includes `harness-skills`). For **git** checkout, run `bun run opencode-v2:bundle-assets` once after install

### Installer refuses the install

A real install requires the `opencode` binary on `PATH` and a resolvable generation. Both refusals name their own recovery: install OpenCode for the presence refusal, and pass `--opencode-generation <v1|v2>` when `opencode --version` cannot be probed. `--dry-run` skips both probes and always previews.
