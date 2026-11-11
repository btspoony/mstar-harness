---
module: packages/dsh
date: 2026-08-16
last_updated: 2026-11-12
problem_type: architecture_pattern
category: architecture-patterns
severity: high
tags:
  - dsh-llm-fallbacks
  - seeds
  - replacement-registry
  - merge-preserve
  - presets
  - apply-window
  - advisory-latch
related_components:
  - packages/dsh/src/gates/fallbacks-seeds.ts
  - packages/dsh/src/gates/fallbacks-advisory.ts
  - packages/dsh/src/index.ts
  - dsh-llm-fallbacks src/seeds.ts
applies_when:
  - declaring seeds into dsh-llm-fallbacks >= 0.1.5 from a companion plugin
  - coexisting with the upstream bundled preset roles
  - reviewing any declareSeeds call site for idempotency, convergence, or latch honesty
  - consuming `getEffectiveRoles()` in tests or dispatch-time code (config-loop readback)
plan_id: <plan-id>
---

# dsh-llm-fallbacks seeds: full-replacement registry, merge-preserve, and apply-window convergence

## Context

`dsh-llm-fallbacks` 0.1.5 grew a seeds surface for companion plugins: `declareSeeds([{id, persona}])`, `getEffectiveRoles()`, `revertSeededPersona(id)` — service 6→9 keys. The B4 adoption (plan `<plan-id>`) had to declare mstar's subagent roles **without** clobbering the upstream preset roles. Neither count is a constant to trust: the mstar side is the `mode`-eligible shell set under `packages/dsh/harness-agents/` (`subagentRoleIds`) and the preset side is the installed `presetRoles` export (5 ids as of `dsh-llm-fallbacks` 0.7.0). Source verification (upstream `src/seeds.ts`, `dist/index.js`) surfaced the three load-bearing semantics:

1. **`declareSeeds` is full-replacement.** A declare commits `this.registry` = the declared batch after its own write; it does NOT union. A mstar-only batch strips the preset ids' seeded annotations.
2. **The registry is per-apply in-memory state.** A fallbacks HMR/fiber swap builds a fresh empty registry; both the mstar inject child and the upstream preset child (self-declares at apply tail via `ctx.inject(['settings'])`) re-fire against it — last committer wins, order nondeterministic.
3. **`EffectiveRole.seedPersona` is present iff seeded.** That is the readback key for preservation.

**Readback fact (0.7.0, verified 2026-11-09):** `getEffectiveRoles()` reads through the provider's own `seedsIo()` (`{ read: () => source(), writeRoles }`), and `source()` is the Loader's live config ref, else the merged `settings` descriptor for the `llm-fallbacks` namespace, else the entry — re-derived on the `settings/document-updated` listener. The `installSection` `setSource`/`onChange` contract this page originally described is GONE in 0.7.0 (upstream `dist/index.d.ts`), so a test fake that installs a settings section the old way can still read `[]` forever — a fake-api-absence red, not the real defect. Read the rows the provider actually exposes and preserve what `read()` returns.

## Guidance

- **Readback merge-preserve before every declare.** Read `getEffectiveRoles()`; carry every seeded NON-self id forward as `{ id: row.id.trim(), persona: row.seedPersona }` (seed default, NOT the operator-overridden `row.persona` — overrides must keep flowing through the operator's row). Union with the freshly-derived own batch, then declare. Unseeded foreign rows are left alone (rows persist independently of annotations — upstream R2).
- **Convergence is the consumer's job inside the provider's apply window (entry-side bounded retry).** The provider's seed write channel (`writeRoles`) starts as a thrower and binds one macrotask AFTER its apply (upstream `:635-641`); a consumer declaring the moment the service appears loses that race. Since iter-20260908 (`<plan-id>`, merge `7cc5a8e9`) the entry retries the declaration on a bounded schedule — exactly 3 attempts at ≈0/50/250 ms, fixed delays, timers owned by the `ctx.inject(['llm-fallbacks'])` child closure and cleared by its teardown (disposed guard: a late attempt is a silent no-op). A successful attempt stops the loop; ultimate failure logs at most ONE terminal error and never throws out of apply.
- **Latch honesty: the advisory reports `{ ran, converged }` and the entry arms only on `ran && converged`.** `runFallbacksAdvisory` returns `AdvisoryPassReport`; a rejected re-declare yields `{ ran: true, converged: false }` and must never arm the one-shot latch — the `subagent/start` decision-point retry stays available (the single-boot terminal state: the decision point re-declares idempotently, so both boot orders still converge). Per-path `converged`: unmounted `{false,false}`; aborted pass `{true,false}`; loader-fallback/unreadable-config `{true,true}`; service-present reflects the re-declare result. The degraded-abort warn is deduplicated to one per apply (`resetAdvisoryAbortWarn()` at apply + inject-child teardown).
- **Consumer contract (what you may/may not assume, promoted from iter-20260908 `specs/seeds-convergence-contract.md`):** you MAY assume a declaration converges within the bounded budget on any boot ordering and that a failed re-declare never suppresses the later decision-point retry. You MAY NOT assume the write channel is bound at the service-appear tick, that a rejected declare persisted anything, or that the advisory "ran" implies it converged.
- **Empty own-batch must skip the upstream call.** `declareSeeds([])` still commits the (possibly preserved-only) registry and can strip a concurrent earlier declarer in the readback→commit window. If `declared.length === 0`, return without declaring (mirror-absent dev checkout is the exposure).
- **Id disjointness is test-enforced, not construction-enforced.** A future agent shell named `scout` would collide with preset `scout`. Lock it with a `new Set([...presetIds, ...mstarIds]).size === PRESET_COUNT + MSTAR_COUNT` assertion where both sides are READ from the source that owns them (the installed `presetRoles` export and the packaged `harness-agents/` mirror, via `subagentRoleIds`) — never a literal count, so a preset-id or role-set change upstream fails the suite instead of drifting past it (`packages/dsh/tests/fallbacks-coexistence.spec.ts`).
- **Seed ids are immutable upstream (0.1.7)** — revert (`revertSeededPersona`) restores the currently-declared seed default; operators edit personas/chains, never seed ids.

## Why This Matters

Any second companion plugin (or an upstream preset addition) re-opens the same race. Merge-preserve + bounded apply-window retry + honest latch is the difference between "seeds work in the demo order" and "seeds converge regardless of apply order — and a failed convergence is loud, once, without suppressing the retry". The readback fact means a test harness whose settings fake does not model the entry-config resolver reports `[]` forever no matter what the consumer does — a fake-api-absence red, not the real defect.

## When to Apply

- New seed declarers, preset coexistence changes, or advisory reads of effective state.
- Reviewing `declareSeeds` calls for replacement-semantics safety.
- Building test harnesses that boot the real fallbacks package: model the Loader **entry-config resolver** (`FakeSettingsRegistry.entryResolver` in `packages/dsh/tests/harness.ts`, `bootApp({ settingsService: 'fake' | 'fake-deferred' })`) — the pre-0.6 `installSection` base-layer registration is retired upstream and deliberately not modeled.

## Source

- Dependency-boundary decision record (the two `dsh-llm-fallbacks` pin literals and the accepted dev-only nested `react` peer): [`docs/adr/implemented/architecture/2026-11-12-fallbacks-dependency-boundaries.md`](../../adr/implemented/architecture/2026-11-12-fallbacks-dependency-boundaries.md).
- QC evidence: `{HARNESS_DIR}/sdd/<plan-id>/review/qc3.md` (W-1 preset competition), `qc2.md` (S-1), fix wave `cadd416`.
- API anchors: `{HARNESS_DIR}/iterations/iter-<plan-id>/specs/architect-api-verification-20260816.md` Source 1.
- Promoted from: `iterations/iter-<plan-id>/specs/seeds-convergence-contract.md` (apply-window + bounded retry + latch-honesty contract, verified by plan `<plan-id>`; QA PASS 1062).
