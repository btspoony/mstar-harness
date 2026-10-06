# @mstar-harness/omp

Morning Star harness plugin for [omp (Oh My Pi)](https://omp.sh).

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

Maintainers / local checkouts: `omp plugin link /path/to/mstar-harness/packages/omp` — the linked package tree needs a local build first (`bun install && bun run engine:build && bun run --cwd packages/omp build`; the linked tree resolves the engine via the workspace member, whose `dist/` is gitignored). Linking the repo root no longer provides the runtime gates; those are built into this package. The stdio MCP server now launches through the CLI `mcp` subcommand, not an OMP-native bridge.

## What you get

| Path in package | Contents |
|-----------------|----------|
| `hooks/pre/mstar-gates.js` | `tool_call` pre-hook — blocking enforcement gate for harness coordination-document writes and task dispatches. Its issue-authority refusals are **unconditional** in every enforcement mode: a direct write to `{HARNESS_DIR}/store.db` (`-wal`/`-shm` included), a write to a retired project register while the store is the active authority, and an unreadable authority (below-floor runtime, missing `node:sqlite`, corrupt or busy store — fails closed) |
| `extensions/model-handoff.js` | Coordinator model-handoff extension (native opt-in settings `modelHandoff` / `handoffTarget`, tool `mstar_model_handoff`) — off by default; see below |
| `extensions/phase2-orchestration.js` | Bounded Phase-2 coordinator scheduling observer, tool `mstar_phase2`; no extra-primary transport/settings |
| `mcp.json` | Launch configuration for `npx @mstar-harness/cli mcp` (requires a published CLI release containing `mcp`) |
| `skills/` | `mstar-harness-core`, `mstar-iteration`, `mstar-sdd`, roles, phase/dispatch gates, … |
| `commands/` | `/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit`, `/amazing-pr-review`, `/amazing-test-audit` |
| `agents/` | Subagent role shells (`fullstack-dev`, `qc-specialist`, …) — no PM shell; the `mode: primary` project-manager seat is OpenCode-only |

The engine and command runtime are bundled inline into the hook and extension bundles at build time. MCP is launched separately through the packaged `mcp.json` config with `npx @mstar-harness/cli mcp`, so the published CLI containing `mcp` and Node.js >=24.18.0 are required. The host package itself keeps its `@oh-my-pi/pi-coding-agent` imports external and resolves them against the running host, declared as an **optional peer** `^18.3.0` (any 18.x host) and developed against the host version pinned in `devDependencies`.

## Model handoff (opt-in)

Coordinator sessions can run Prepare for every new Morning Star iteration on `@slow` and continue that same session on a cheaper role once Phase 1 is complete.

1. `/settings` → **Plugins** → **`@mstar-harness/omp`** → set **`modelHandoff`** to `true` (default `false`) and pick **`handoffTarget`** — `@default` (default) or `@smol`. These are the host's native plugin-settings rows; there is no activation command and no second settings file.
2. Saved preferences persist across sessions in the host plugin-settings store. Merely installing or updating this package changes no model.
3. On a real **new iteration start** in the coordinator session — `/iteration-start`, `/iteration-loop`, or a natural-language / skill-driven start — this session is armed with `@slow` once the direction is locked and before the Phase 1 draft is written; the arm is deliberately early, when the iteration still has no register row, no snapshot and no compass, and it takes the unregistered reservation path. Arming is the PM's explicit action in that coordinator session: the `mstar_model_handoff` tool with `{operation:"start", workflowId:"<id>"}` called once the direction is locked and before the draft (the observed entry route only labels that binding — no setting, command or prose arms by itself), and the later switch happens only through the `{operation:"phase1-complete", …}` checkpoint with the frozen Phase 1 evidence. Ordinary chat, unrelated commands, subagent/leaf sessions, plan-scoped (`/iteration-drive --assignment …`) sessions and other hosts stay untouched.
4. After a **complete Phase 1** — the specialist returns for that iteration, PM-locked Prepare, a distinct matching integration checkout and the required integration-branch push (upstream setup only; no harness artifacts are committed) — the same session switches once to `handoffTarget`.
5. Picking a model yourself while the switch is still waiting cancels that pending switch for this session; the saved preference stays and later iterations still apply it. Failures (unresolvable role, refused host selection, incomplete readiness) stay visible in the session, keep the model the session actually has, and are never retried in a loop. No role mapping, goal or workflow state is written — only the session's model.

**Scope limitation (host behaviour, not configurable here):** the native `/settings` → Plugins panel lists **user-scope** plugin installs. A `--scope project` install is used by omp but has no row in that panel; use the user-scope install above. The extension reads the saved preference through the host's exported settings helper, so a project-scoped runtime still honours the preference you saved there.

Requires omp's `@oh-my-pi/pi-coding-agent` (optional peer, `peerDependencies`) and **Bun `>=1.4.0`** for this plugin. The peer is optional so the package installs on any host: the hooks, MCP bridge, skills and commands are self-contained and unaffected by host resolution. This is a Bun-hosted plugin; do not add a Node floor here just because the CLI also has an explicit `node` invocation.
The engine and command/MCP runtime are bundled inline into the hook and extension bundles at build time. The model-handoff and Phase-2 extensions retain their host APIs as external imports resolved by omp.

## Phase-2 scheduling observation

The single primary coordinator uses native background task dispatch for ordinary leaf work. The Phase-2 extension provides a bounded reminder to run the shared rescheduling checkpoint, never a ready list, polling loop or duplicate native completion notification.

At phase-2-entry call `mstar_phase2` with `{operation:"bind",workflowId}`; native identity and authority are derived, no session path is supplied. At each checkpoint call `{operation:"checkpoint",reason,decision,note}` with the shared reason vocabulary. Read-only export-history remains source evidence, not operational quiescence proof.

There is no per-plan primary launch, terminal transport, capacity setting or launch journal. Model-handoff preferences remain unchanged. `/iteration-drive` accepts no arguments and resumes the coordinator's workflow; unsupported input refuses before boot.

Rows advance directly through revisable prepare, progress and complete, preserving isolated worktrees, SDD/QC/QA, CAS/receipts and actual serial integration. Standalone development retains its compound/PR/verified-merge/close tail; report-only retains explicit policy fulfilment before Done and evidence-backed close without invented Git/PR.

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

Plugin sources: `packages/omp/src/hooks/pre/mstar-gates.ts` + `packages/omp/src/extensions/model-handoff.ts` (model-handoff extension).
Plugin sources: packages/omp/src/extensions/phase2-orchestration.ts and packages/omp/src/phase2-orchestration.ts (bounded observation only; extra-primary launch module removed).

## License

MIT — see [LICENSE](https://github.com/btspoony/mstar-harness/blob/main/LICENSE).
