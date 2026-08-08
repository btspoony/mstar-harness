# @mstar-harness/opencode

Morning Star (启明星) harness plugin for [OpenCode](https://opencode.ai).

Install this package via OpenCode’s `plugin` array — it bundles `mstar-*` skills, role agents, and iteration commands so multi-role workflows (PM routing, SDD implement, QC tri-review, iteration lifecycle) work the same way as in the Cursor and Codex plugins.

## Install

Add to `opencode.json` (global or project):

```json
{
  "plugin": ["@mstar-harness/opencode@latest"]
}
```

Restart OpenCode.

Or use the installer CLI:

```bash
npx @mstar-harness/cli init --target opencode
```

## What you get

| Path in package | Contents |
|-----------------|----------|
| `harness-skills/` | `mstar-harness-core`, `mstar-iteration`, `mstar-sdd`, roles, phase/dispatch gates, … |
| `harness-agents/` | Role shells (`project-manager`, `fullstack-dev`, `qc-specialist`, …) |
| `harness-commands/` | `/iteration-start`, `/iteration-drive`, `/iteration-loop` |

The plugin resolves **only paths inside this package** — not `process.cwd()/skills`, so your app repo root does not affect harness loading.

## Status write lint (hook coverage)

The plugin registers a non-blocking `tool.execute.before` lint for `write`/`edit` tools that target `{HARNESS_DIR}/status.json`: the about-to-be-written (or current on-disk) document is validated against the engine `status.validateStatus` schema and violations are logged as warnings. The hook never blocks and never modifies the write.

Hook coverage follows the engine `resolveHarnessDir` probe order (`.mstar/` → `.agents/` → `.plans/`/`plans/` walking up from the target file). Repos whose harness root is not one of those names — e.g. the `.harness/` layout used by this monorepo itself — are **not** auto-discovered: set **`MSTAR_HARNESS_DIR`** in the OpenCode server environment (absolute path to the harness root) to enable the lint for such repos.

## Dispatch presence lint (hook coverage)

The plugin registers a non-blocking `tool.execute.before` lint for the `task` tool (subagent dispatch): the prompt is parsed for the three core Assignment header fields — `Execute as: <role-id>`, `Delegation: allowed|forbidden`, `Task category: <category>` — and each missing field is logged as a warning (`assignment.presence.missing-*`, `high` for `Execute as`, `medium` otherwise). The hook never blocks and never modifies the prompt; prompts that are not Assignment-shaped (no `## Assignment` heading and none of the three fields) stay silent. Field **presence** only: value-level Assignment validation (Working-branch forms, N→seat mapping, tri identity) is a later-slice extension via `dispatch.validateAssignmentFields`.

## Quick start

1. Install the plugin (above).
2. In OpenCode, start with the **Project Manager** agent (`project-manager`).
3. For a full iteration: run **`/iteration-start`** then **`/iteration-drive`**, or one-shot **`/iteration-loop`** (autonomous Phase 1→5).

Entry skill: **`mstar-harness-core`** (loaded before other `mstar-*` skills).

## Docs

- [INSTALL.md](./INSTALL.md) — setup, monorepo checkout, migration from legacy git plugin, troubleshooting
- [Monorepo README](https://github.com/btspoony/mstar-harness#readme) — cross-host overview
- [CHANGELOG.md](./CHANGELOG.md) — package release notes

## Development (this monorepo)

From the repository root:

```bash
bun install          # postinstall bundles harness-skills/ + harness-agents/
bun run opencode:bundle-assets   # if you used --ignore-scripts
```

Plugin entry: `packages/opencode/src/mstar.ts` → `dist/mstar.js`.

## License

MIT — see [LICENSE](https://github.com/btspoony/mstar-harness/blob/main/LICENSE).
