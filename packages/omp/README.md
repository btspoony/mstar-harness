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
| `extensions/model-handoff.js` | Coordinator model-handoff extension (native opt-in settings `modelHandoff` / `handoffTarget`, tool `mstar_model_handoff`) — off by default; see below |
| `tools/mstar_*.js` | Six model-callable validator tools (`mstar_status_validate`, `mstar_dispatch_validate`, `mstar_lease_verify`, `mstar_path_resolve`, `mstar_iteration_gate`, `mstar_worktree_check`) |
| `skills/` | `mstar-harness-core`, `mstar-iteration`, `mstar-sdd`, roles, phase/dispatch gates, … |
| `commands/` | `/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit`, `/amazing-pr-review` |
| `agents/` | Subagent role shells (`fullstack-dev`, `qc-specialist`, …) — no PM shell; the `mode: primary` project-manager seat is OpenCode-only |

The engine is **bundled inline** into every hook/tool/extension bundle at build time — the installed package has no runtime `@mstar-harness/engine` resolution, so module link can never fail on a missing package. The host package is the reverse: `extensions/model-handoff.js` keeps its one `@oh-my-pi/pi-coding-agent` import external and resolves it against the running host (the host provides that module for extensions), declared as an **optional peer** and developed against the host version pinned in `peerDependencies`.

## Model handoff (opt-in)

Coordinator sessions can start every new Morning Star iteration on `@slow` (Prepare) and continue that same session on a cheaper role once Phase 1 is complete.

1. `/settings` → **Plugins** → **`@mstar-harness/omp`** → set **`modelHandoff`** to `true` (default `false`) and pick **`handoffTarget`** — `@default` (default) or `@smol`. These are the host's native plugin-settings rows; there is no activation command and no second settings file.
2. Saved preferences persist across sessions in the host plugin-settings store. Merely installing or updating this package changes no model.
3. On a real **new iteration start** in the coordinator session, this session is armed with `@slow` before substantive Prepare work. Ordinary chat, unrelated commands, subagent/leaf sessions, plan-scoped (`/iteration-drive --assignment …`) sessions and other hosts stay untouched.
4. After a **complete Phase 1** — the specialist returns for that iteration, PM-locked Prepare, a distinct matching integration checkout and the required integration push — the same session switches once to `handoffTarget`.
5. Picking a model yourself while the switch is still waiting cancels that pending switch for this session; the saved preference stays and later iterations still apply it. Failures (unresolvable role, refused host selection, incomplete readiness) stay visible in the session, keep the model the session actually has, and are never retried in a loop. No role mapping, goal or workflow state is written — only the session's model.

**Scope limitation (host behaviour, not configurable here):** the native `/settings` → Plugins panel lists **user-scope** plugin installs. A `--scope project` install is used by omp but has no row in that panel; use the user-scope install above. The extension reads the saved preference through the host's exported settings helper, so a project-scoped runtime still honours the preference you saved there.

Requires omp's `@oh-my-pi/pi-coding-agent` (optional peer, `peerDependencies`) and Bun `>=1.3.14`. The peer is optional so the package installs on any host: the hooks, tools, skills and commands carry no runtime host import and are unaffected by this entry's host resolution.

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

Plugin sources: `packages/omp/src/hooks/pre/mstar-gates.ts` + `packages/omp/src/tools/mstar_*/index.ts` (moved here from the repo root 2026-09-03) + `packages/omp/src/extensions/model-handoff.ts` (model-handoff extension).

## License

MIT — see [LICENSE](https://github.com/btspoony/mstar-harness/blob/main/LICENSE).
