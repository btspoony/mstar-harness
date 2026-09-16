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
| `extensions/phase2-orchestration.js` | Phase-2 orchestration extension (native launch opt-in `phase2PlanInstances` / `maxPlanInstances`, tool `mstar_phase2`) — extras off by default; see below |
| `tools/mstar_*.js` | Six model-callable validator tools (`mstar_status_validate`, `mstar_dispatch_validate`, `mstar_lease_verify`, `mstar_path_resolve`, `mstar_iteration_gate`, `mstar_worktree_check`) |
| `skills/` | `mstar-harness-core`, `mstar-iteration`, `mstar-sdd`, roles, phase/dispatch gates, … |
| `commands/` | `/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit`, `/amazing-pr-review` |
| `agents/` | Subagent role shells (`fullstack-dev`, `qc-specialist`, …) — no PM shell; the `mode: primary` project-manager seat is OpenCode-only |

The engine is **bundled inline** into every hook/tool/extension bundle at build time — the installed package has no runtime `@mstar-harness/engine` resolution, so module link can never fail on a missing package. The Phase-2 extension follows the same host pattern as the model entry: its one runtime host dependency, `getPluginSettings` from `@oh-my-pi/pi-coding-agent/extensibility/plugins`, stays external and is resolved by the running host, declared as an **optional peer** and developed against the pinned host version.

## Phase-2 plan instances (opt-in)

During an iteration's **Phase 2** the coordinator can be reminded about an overlooked rescheduling check, and — when you explicitly opt in and your terminal environment supports it — launch an **extra plan-scoped primary session** for a plan it already prepared. Native background `task` concurrency stays the default task transport in every mode.

1. `/settings` → **Plugins** → **`@mstar-harness/omp`** → set **`phase2PlanInstances`** to `true` (default `false`) and, if you want a different limit, **`maxPlanInstances`** (default `2`, minimum `1`, no ceiling of 2). These are the host's native plugin-settings rows — no activation command, no second settings file.
2. **The opt-in is launch-only.** `phase2PlanInstances` gates extra primary launches and nothing else: native background tasks and the bounded Phase-2 reminder keep working while it is off, and it adds no new reminder toggle.
3. **Capacity** counts concurrently active plan-scoped primaries **plus owned pending launch intents** (union by plan id, each counted once); the iteration coordinator and task subagents are excluded. **Lowering `maxPlanInstances` stops new launches and never kills running sessions.** A present-but-malformed value fails visibly and authorizes no launch — it is never coerced to the default and never becomes an unbounded mode.
4. **The reminder is bounded**: at most one advisory per *changed* opportunity observation, in the Phase-2 coordinator session only, emitted at a turn boundary — never a timer loop, never identical unchanged re-nudging, never a duplicate of the native completion notice. It only points at the shared Phase-2 rescheduling checkpoint; it asserts nothing about a plan being ready.
5. **PM records everything explicitly.** In that coordinator session the tools are: `bind` (`{operation:"bind", workflowId, coordinatorSessionPath}`) as the first Phase-2 action, `checkpoint` (`{operation:"checkpoint", reason, decision, note}`) to acknowledge the scheduling check against the sample taken then, and `reserve-launch` / `record-launch` for each launch step. Only `applied:true` authorizes the matching side effect, and each transition is recorded **before** its pane/OMP-start/prompt action.
6. **Launching is optional skill work, not a compiled feature.** A launch requires all of: the matching skill actually present in the catalog and read (`herdr` today; a tmux skill only if one exists), the CLI available, and this session actually inside the matching managed environment (`HERDR_ENV=1`; `TMUX` for tmux). Herdr's sequence is `herdr pane split --current --direction <chosen> --cwd <prepared-worktree> --no-focus` → reuse the returned pane id → `herdr agent start <unique-name> --kind omp --pane <returned-id>` → one `herdr agent prompt <unique-name> "/iteration-drive --assignment <absolute-prepared-assignment>"`, with no waiting for plan completion and no coordinator credentials passed. A missing skill, CLI or environment is a **visible no-op** — no process starts, no substitute plan is used, native scheduling keeps working. No tmux skill ships today, so tmux is unavailable rather than half-implemented.
7. **Uncertainty is terminal**: `agent_not_ready`, blocked UI, a timeout or a stalled submission is reported and never retried or re-sent; a returned opaque target is used verbatim and never fabricated. Pane idle/ready/done is never plan completion or ownership — the child binds its own plan and stops at a durable handoff, and only the coordinator integrates and closes.

The transport guidance above is backed by **simulated** scripted skill/CLI observation traces, not by a native end-to-end Herdr/tmux run or a real OMP child process.

**Scope limitation (host behaviour, not configurable here):** the native `/settings` → Plugins panel lists **user-scope** plugin installs. A `--scope project` install is used by omp but has no row in that panel; use the user-scope install above. The runtime still reads the saved preference through the host's exported settings helper.

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

Plugin sources: `packages/omp/src/hooks/pre/mstar-gates.ts` + `packages/omp/src/tools/mstar_*/index.ts` (moved here from the repo root 2026-09-03) + `packages/omp/src/extensions/phase2-orchestration.ts` (the published entry; its runtime modules are `packages/omp/src/phase2-orchestration.ts` and `phase2-launches.ts`).

## License

MIT — see [LICENSE](https://github.com/btspoony/mstar-harness/blob/main/LICENSE).
