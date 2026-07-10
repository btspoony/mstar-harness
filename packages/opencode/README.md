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
| `harness-commands/` | `/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/mstar-bootstrap` |

The plugin resolves **only paths inside this package** — not `process.cwd()/skills`, so your app repo root does not affect harness loading.

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
