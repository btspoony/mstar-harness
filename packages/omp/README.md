# @mstar-harness/omp

Morning Star (启明星) harness plugin for [omp (Oh My Pi)](https://omp.sh).

Install this package with `omp plugin install` — it bundles the engine **inline** (zero runtime `@mstar-harness/engine` dependency), plus `mstar-*` skills, role agents, iteration commands, and the omp runtime gates (status/dispatch/lease validation), so multi-role workflows (PM routing, SDD implement, QC tri-review, iteration lifecycle) work the same way as in the OpenCode, Cursor, and Codex plugins.

## Install

```bash
omp plugin install @mstar-harness/omp
# project scope:
omp plugin install @mstar-harness/omp --scope project
```

Restart / new session to pick up skills, commands, and agents.

Or use the installer CLI:

```bash
npx @mstar-harness/cli init --target omp
```

Maintainers / local checkouts: `omp plugin link /path/to/mstar-harness/packages/omp` — the linked package tree needs a local build first (`bun install && bun run engine:build && bun run --cwd packages/omp build`; the linked tree resolves the engine via the workspace member, whose `dist/` is gitignored). Linking the repo root no longer provides the runtime gates — hooks/tools moved into this package.

## What you get

| Path in package | Contents |
|-----------------|----------|
| `hooks/pre/mstar-gates.js` | `tool_call` pre-hook — blocking enforcement gate for harness coordination-document writes and task dispatches |
| `tools/mstar_*.js` | Six model-callable validator tools (`mstar_status_validate`, `mstar_dispatch_validate`, `mstar_lease_verify`, `mstar_path_resolve`, `mstar_iteration_gate`, `mstar_worktree_check`) |
| `skills/` | `mstar-harness-core`, `mstar-iteration`, `mstar-sdd`, roles, phase/dispatch gates, … |
| `commands/` | `/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit`, `/amazing-pr-review` |
| `agents/` | Role shells (`project-manager`, `fullstack-dev`, `qc-specialist`, …) |

The engine is **bundled inline** into every hook/tool bundle at build time — the installed package has no runtime `@mstar-harness/engine` resolution, so module link can never fail on a missing package.

## Quick start

1. Install the plugin (above).
2. In omp, enter PM with `/skill:pm`.
3. For a full iteration: run **`/iteration-start`** (Phase 1 grill-me → auto-continues Phase 2→5; add `pause` to stop after Phase 1), or one-shot **`/iteration-loop`** (autonomous Phase 1→5). Use **`/iteration-drive`** to resume an interrupted iteration.

Entry skill: **`mstar-harness-core`** (loaded before other `mstar-*` skills).

## Docs

- [Monorepo README](https://github.com/btspoony/mstar-harness#readme) — cross-host overview
- Host adapter: `mstar-host` → `references/omp.md` (`skill://mstar-host/references/omp.md`)

## Development (this monorepo)

From the repository root:

```bash
bun install
bun run omp:build   # bundle-assets + dist bundles + root discovery mirrors
```

Plugin sources: `packages/omp/src/hooks/pre/mstar-gates.ts` + `packages/omp/src/tools/mstar_*/index.ts` (moved here from the repo root 2026-09-03).

## License

MIT — see [LICENSE](https://github.com/btspoony/mstar-harness/blob/main/LICENSE).
