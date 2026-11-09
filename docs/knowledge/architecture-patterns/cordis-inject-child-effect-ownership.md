---
module: packages/dsh
date: 2026-08-16
problem_type: architecture_pattern
category: architecture-patterns
severity: high
tags:
  - cordis
  - inject-child
  - effect-ownership
  - hmr
  - dsh
related_components:
  - packages/dsh
  - deepseek-harness packages/core/scope
  - deepseek-harness packages/core/system-prompt
applies_when:
  - registering anything through ctx.inject(['<service>']) in a cordis plugin
  - designing one-shot latch or cache state that must survive or reset across service re-apply
  - reviewing HMR/fiber-swap behavior claims for plugin registrations
plan_id: iter-<plan-id>
---

# cordis inject-child does not own service-fiber effects — disposer capture and latch re-arm

## Context

Two independent QC findings in `iter-<plan-id>` converged on the same cordis lifecycle fact:

- **P1 QC3-W1** (`fallbacks-advisory`): a one-shot advisory latch armed at the first decision point never re-armed after `dsh-llm-fallbacks` HMR re-apply — the "re-fires on every apply" inject child did re-declare, but convergence (the advisory pass) was permanently stale.
- **P2 QC3-W1** (`system-prompt`): a module doc claimed "a re-apply disposes the old registrations before registering fresh ones" — false. `section()`/`context()` effects land on the **systemPrompt service fiber** (`ScopedLayers.effect(this.ctx)`), not the caller's inject child; re-apply produced a contained duplicate-name throw, new registrations lost, old closure (stale `harnessDir`) alive.

## Guidance

- **`ctx.inject(['svc'], cb)` gives you a child fiber, not effect ownership.** Registrations the *service* performs on your behalf are owned by the service's fiber. Unloading your plugin (or its inject child) does NOT remove them; unloading the service does.
- **Capture the disposers the service returns and collect them on YOUR child ctx.** `view.section(...)`/`view.context(...)` return exact disposers; wrap them in `systemPromptCtx.effect(function* () { yield () => { disposeSection(); disposeContext() } })` so your fiber's teardown runs them. Re-apply then re-registers cleanly (no duplicate-name throw, no stale closure). Double-path disposal is idempotent — both orders safe.
- **One-shot latches must reset when the service they guard disappears.** A latch armed against service state A survives into service state B (HMR re-apply builds a fresh empty registry in the fallbacks case). Reset the latch from an inject-teardown / service-disappearance hook so the next decision point re-runs the convergence pass. `Plan parallelism` of concerns: the *declare* path stays latch-free (re-fires per apply); only the *advisory/report* path is one-shot per apply generation.
- **Never document lifecycle claims from a probe you deleted.** P2's false claim traced to an HMR probe that was removed; the QC seat re-derived semantics from cordis source (`registry.ts`/`fiber.ts`, `scope/src/store.ts`). Source-verify lifecycle prose, keep the probe as a permanent regression test.

## Why This Matters

Every "wire into a dsh service via `ctx.inject`" feature (seeds declare, prompt sections, goals, planMode) shares this seam. Getting ownership wrong yields the worst failure class: contained warns, no crash, silently stale behavior that only surfaces after a config change or plugin hot-reload — exactly when the operator is not looking at mstar logs.

## When to Apply

- Any new `ctx.inject(['<service>'])` registration in packages/dsh.
- Adding latch/caching state keyed to a service that can re-apply.
- Reviewing HMR claims in module docs or changelog fragments.

## Source

- QC evidence: `{HARNESS_DIR}/sdd/<plan-id>/review/qc3.md` (W-1), `{HARNESS_DIR}/sdd/<plan-id>/review/qc3.md` (W1) + fix-wave reports (`cadd416`, `fa641c7`).
- API anchors: `{HARNESS_DIR}/iterations/iter-<plan-id>/specs/systemprompt-api-findings.md`, `architect-api-verification-20260816.md`.
