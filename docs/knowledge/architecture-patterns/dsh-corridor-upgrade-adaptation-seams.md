---
module: packages/dsh
last_updated: 2026-11-07
date: 2026-11-06
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: 20261106-dsh-0.2.2-rc1-upgrade
tags:
  - dsh
  - corridor-upgrade
  - tool-executor
  - batch-api
  - cordis-peer
  - agent-presets
  - dsh-llm-fallbacks
related_components:
  - packages/dsh/src/gates/role-persona.ts
  - packages/dsh/tests/harness.ts
  - packages/dsh/tests/fixtures/cordis.yml
  - deepseek-harness packages/core/tools
  - deepseek-harness packages/core/tool-executor-native
applies_when:
  - raising the @deepseek-ai/dsh peer corridor in packages/dsh
  - adapting to a dsh release that rewrites the tool-execution layer
  - diagnosing TOOL_EXECUTOR_UNAVAILABLE in a hand-built dsh test composition
  - raising the dsh-llm-fallbacks pin (both pins move together; see seam 6)
---

# dsh corridor upgrade adaptation seams (tool execution, augmentation visibility, cordis family)

## Context

The dsh `0.2.1-rc.5 → 0.2.2-rc.1` corridor bump (plan `20261106-dsh-0.2.2-rc1-upgrade`) rewrote the tool-execution layer, stopped merging one Cordis `Context` augmentation into consumer types, and moved the `@deepseek-ai/cordis` family. Each change surfaced at a different gate (runtime test failure, `typecheck:src`, silent peer-resolution drift), so no single check catches them all. This page records the five seams a future dsh corridor bump must re-check, using the verified facts of the rc.1 hop as the reference instance. Lock regeneration, phantom-import compensation, and baseline-first attribution for corridor bumps generally are owned by `tooling-decisions/dsh-peer-corridor-lock-regen-and-phantom-deps.md` — read both pages for a corridor bump.

## Guidance

**1. Tool execution requires a mounted executor.** Since `0.2.2-rc.1`, `ToolsService.execute()` delegates to an executor provided by a mounted plugin. A composition without `@deepseek-ai/dsh-tool-executor-native` (or `-ptc`) throws `ToolExecutorUnavailableError: TOOL_EXECUTOR_UNAVAILABLE` from dsh-tools `selectExecutor`. The shipped `dsh-base` bundle layer already mounts the executor, so production profiles are unaffected; only hand-built compositions — this package's test harness — lack one. The failure is runtime-only: `bun test` fails per call with no compile-time signal.

**2. `ToolsService.execute` is a batch contract.** Input: `ToolBatchInput = { calls: ToolCallBlock[], signal, maxParallelToolCalls?, agent? }`. Output: `ToolBatchResult = { results: ToolCallResult[], additionalContexts, concluded }` with `ToolCallResult = { callId, result: ToolExecutionResult }`. The pre-rc.1 single-call shape is gone in both directions: `callId`/`name`/`arguments` are no longer top-level input fields (a call is one `ToolCallBlock` entry with JSON-stringified `arguments`), and `isError`/`value`/`error` live on the unwrapped `ToolExecutionResult`, not on the batch result. A call site still passing the old object fails typecheck with TS2353 (`'callId' does not exist in type 'ToolBatchInput'`); assertions reading `result.isError` off the batch result fail with TS2339.

**3. Cordis `Context` augmentations from dsh services do not reach this package's `Context`.** The `agent-preset-registry` augmentation no longer merges, so `Context['agentPresets']` is a compile error (TS2339, four sites in `src/gates/role-persona.ts`). The fix pattern is a local structural view read through the service accessor — `interface AgentPresetsView { readDocument(agentPreset: string): Promise<unknown> }` with `ctx.get('agentPresets') as AgentPresetsView | undefined` — the house pattern already used in `plan-mode-bridge.ts` and `fallbacks-probe.ts`. Read the shape the code actually consumes (`readDocument` is the only member used; presence checks degrade silently when the service is absent) and never re-add a type-only import of the upstream package just to pull an augmentation upstream does not owe consumers.

**4. The cordis family moves with the corridor.** Every `0.2.2-rc.1` package declares peer `@deepseek-ai/cordis ~4.1.0` (loader/include `~1.1.0`). The plugin's own `@deepseek-ai/cordis` peer must move with it (`^4.0.5` → `~4.1.0`); bun auto-installs peers, so a stale range silently resolves `cordis@4.0.5` and leaves the whole cohort unsatisfied — no install error. With the corrected range the lockfile resolves `cordis@4.1.0` plus loader/include at `1.1.0`. Nested `cordis@4.0.5` copies under the rc.5-era subtrees pulled in by the third-party `dsh-llm-fallbacks` are correct — those packages still peer on `~4.0.5`; do not chase them to one version. `tests/peer-deps.spec.ts` asserts every `@deepseek-ai/*` name appears only in `peerDependencies`, so anything the tests need at runtime (the executor) goes to `devDependencies` — which also keeps the packaged plugin from requiring an executor it does not own.

**5. Hand-built test compositions have two mount points.** `tests/harness.ts` (inline rows + module map) and `tests/fixtures/cordis.yml` (the fixture composition that replaces the inline rows for `e2e-session.spec.ts`) each need the executor row immediately after `@deepseek-ai/dsh-tools`, plus the module-map entry and the `devDependencies` pin. One shared helper (`executeToolCall(ctx, { name, arguments, callId?, agent?, signal? })`) builds a one-call batch, asserts exactly one settled result, and returns `results[0].result`; `callId` stays optional because ledger assertions depend on stable call identities. Both mount points change together — adapting only `harness.ts` leaves the fixture-driven spec failing on `TOOL_EXECUTOR_UNAVAILABLE`.

**6. `dsh-llm-fallbacks` upgrades are two pins in one change set (0.7.0 follow-up, plan `20261107-dsh-fallbacks-0.7.0`).** The package is pinned twice: `packages/dsh/package.json` `devDependencies["dsh-llm-fallbacks"]` and `packages/cli/package.json` `mstar.dshLlmFallbacks` (what `mstar init --target dsh` installs and what `dshFallbacksVersion()` compares against). They must move together in the same commit — issue `I-000956` records the invariant; `I-001047` is the 0.7.0 follow-up this closes. The 0.7.0 rewrite (only the virtual `FallbacksChain/Auto` adapter remains a fallback path; `agent/request` / `agent/request-error` listeners and the `automatch` / `override` / `authorized-route` modules removed) is entirely upstream: this repo consumes only `FallbacksService` members (`resolveRole`, `resolveChain`, `validateFallbacksConfig`, `detectLegacyKeys`, `declareSeeds`, `getEffectiveRoles`, `revertSeededPersona`), `presetRoles`, and the seed types — all unchanged, with additive `getAgentRole` — so the upgrade was a pin-only patch and the structural type gate passed untouched. Lockfile consequence: 0.7.0 peers `@deepseek-ai/dsh-*` at `^0.2.2-rc.1` (0.6.13 pinned `^0.2.1-rc.4`), so bun dedupes the ~380 nested `dsh-llm-fallbacks/<peer>` and old plugin-manager `0.2.0-rc.2` entries onto the corridor the workspace already resolves (`bun.lock` shrank ~762 lines) — expected dedupe, not collateral damage. Evidence: plan `20261107-dsh-fallbacks-0.7.0` Current state; QC `review/qc.md` (Approve, lockfile delta independently counted); QA `review/qa.md` (Pass; 54/54 specs, both type gates exit 0, adapter 35/35 at `376d2e96`).

**Probe order for the next bump.** Pin the cohort → `bun install` (regenerate the lock per the tooling-decisions page) → `typecheck:src` → `typecheck:tests` → `bun test`, and read the error class, not the count: augmentation-visibility errors land only in `typecheck:src`, batch-contract errors only in `typecheck:tests`, executor absence only at runtime. A missing cordis-family range lands nowhere — a lockfile grep for the old cordis version is the only guard.

## Why This Matters

These seams are corridor contracts, not local bugs: upstream moves them on its own schedule, and three of the five fail in different gates — one fails nowhere. The silent one is the worst: a stale cordis peer range produces a green install whose cohort is unsatisfied, and only a lockfile grep or the peer-deps contract test notices. Treating the five as a fixed re-check list turns the next corridor bump from a probe-debug loop into a checklist pass.

## When to Apply

- Any `@deepseek-ai/dsh-*` corridor bump in `packages/dsh` (together with `tooling-decisions/dsh-peer-corridor-lock-regen-and-phantom-deps.md`).
- Diagnosing `TOOL_EXECUTOR_UNAVAILABLE` in any hand-built cordis composition that mounts `dsh-tools`.
- `Property '<service>' does not exist on type 'Context'` after a dsh bump — switch to a structural `ctx.get` view instead of importing for the augmentation.
- Reviewing a dsh release diff for consumer-visible contract changes before upgrading.

## Examples

- The `0.2.1-rc.5 → 0.2.2-rc.1` run (plan `20261106-dsh-0.2.2-rc1-upgrade`; QC consolidated and QA reports under `{HARNESS_DIR}/sdd/20261106-dsh-0.2.2-rc1-upgrade/review/`): `cf736c1f` corridor pins + structural `AgentPresetsView`; `6dc1e2d2` executor mounted in both compositions + the `executeToolCall` batch helper; `5ee4fd46` cordis peer `^4.0.5` → `~4.1.0` after QC seats 2/3 flagged the corridor mismatch (F-001) — the one seam no type gate catches.
- Consolidation review candidate: this page plus `tooling-decisions/dsh-peer-corridor-lock-regen-and-phantom-deps.md` together form the full corridor-bump checklist (lock + phantom imports + adaptation seams).
- The `dsh-llm-fallbacks` `0.6.13 → 0.7.0` follow-up (plan `20261107-dsh-fallbacks-0.7.0`; commit `376d2e96`, branch `feat/dsh-fallbacks-0.7.0`): pin-only patch of four files (two manifests, `bun.lock`, `.changes` fragment), zero source edits — the routing rewrite never crossed the consumed service/seeds surface.
