---
module: packages/dsh
date: 2026-08-17
last_updated: 2026-09-09
problem_type: testing_pattern
category: testing-patterns
severity: medium
plan_id: <plan-id>
applies_when:
  - e2e-testing a plugin through its real package-manager install path
  - composing installed artifacts into a cordis test harness
  - avoiding dual-instance of peer packages in tests
  - reproducing provider apply-window races in a harness composition
tags:
  - dsh
  - e2e
  - installed-deployment
  - single-instance
  - cordis
  - skip-guard
  - harness-fidelity
---

# Installed-deployment e2e — real install loop with single cordis instance

## Context

AC-3 required proof that "install the mstar dsh plugin + llm-fallbacks ⇒ 13 mstar roles exist zero-config in the fallbacks effective taxonomy". Existing composition specs booted the plugin from **src** (`bootApp` hardcodes `import * as plugin from '../src/index.ts'`), not from the installed artifact — the user path (real `dsh plugin add`) was unproven.

## Verification scope

Browser, device, real-install and GUI-restart methods below apply only inside an explicitly requested independent `mstar-e2e` workflow, executed by ops under its named environment/scenario scope. They are not iteration or routine QA gates; UI changes and missing screenshots do not activate them. Routine QA remains targeted unit-only. Historical in-loop acceptance describes past evidence, not current authorization. Reuse the technical findings for affected unit checks without rerunning broad scans or real environments.

## Guidance

- **Independent authorized install-E2E only — real install loop first**: temp `DSH_HOME` → the CLI (`init --target dsh`, plan `<plan-id>`) → verify rows via `--dump-config`. Skip-guard (no `dsh` bin / no registry) must `describe.skipIf` with a printed reason — a skip is **never** AC evidence; only a non-skip PASS proves that scenario passed; this is not an iteration QA gate.
- **bootApp minimal opt-in extension**: add `pluginModule` / `fallbacksModule` / `settingsService` override params, defaults unchanged (existing spec callers untouched). Row order must match the real profile entry list (mstar before llm-fallbacks).
- **Single-instance invariant (hard)**: the installed dists' bare imports (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-*`, …) must resolve to the **same physical instances** the test process (host) loaded. Mechanism: **real-directory copies** of the installed packages under the repo `node_modules` tree (`.mstar-e2e/<run>/`), so walk-up resolution lands in the host tree; `Bun.resolveSync` cross-check pins `cordis` equality; `afterEach` cleans up.
  - **Symlinks rejected**: Node/Bun realpath resolves them back into the pnpm store — a **second** cordis instance.
  - **Loader hooks rejected**: `Bun.plugin` `onResolve` is build-time only (probed).
- **Seeds convergence modeling (UPDATED iter-20260908): for boot-order regression tests, do NOT model convergence via dispose/re-apply re-composition — that re-composition is exactly what hides the boot-order race.** The single-boot standard (plan `<plan-id>`, Task 1): (a) make the fake settings **faithful to the real service's consumed contract** — `installSection` (base-layer registration + live `{...entry, ...stored}` source closure + synchronous `onChange`) and patch-merge `update`, modeled on `@deepseek-ai/dsh-settings/lib/index.js:327-347`/`:384-400` — so the provider's config loop CLOSES and `getEffectiveRoles()` readback works; (b) mount the settings row with realistic arrival timing via the opt-in `settingsService: 'fake-deferred'` (row AFTER the fallbacks row) so the live declare-vs-binding race reproduces **for the right cause**; (c) the RED run must match the live failure shape (7-preset readback + the 13 missing ids + the provider's own rejection string) — never the fake-api-absence shape (`[]` readback + an `installSection is not a function` TypeError), which means the fake, not the code under test, is broken. Dispose/re-apply modeling remains legitimate for installed-artifact e2e where the goal is the shipped composition, not the race.
- **Harness-fidelity red → green discipline**: a regression test is falsifiable only if it is red for the SAME cause as the live failure. Verify the red shape against the captured live evidence before implementing any fix; if the harness cannot reproduce the live cause, stop and redesign the harness (faithful fake + timing), never weaken the assertion.
- **Vintage-guarded artifact pins (iter-20260908 pattern)**: an installed-artifact probe for a surface that no published version carries yet arms via an explicit marker (`hasSeamProbeSurface`) checked BEFORE the host copy, so the armed surface and the booted surface are the same artifact (no deterministic-failure window while `minimumReleaseAge` holds the carrying version back); the disarm path prints its reason unconditionally (log-detected, not a fake green) and records the post-release hard-assert upgrade as a durable follow-up.
- **pinned re-add deviation**: pnpm `minimumReleaseAge` may resolve an older version lacking the surface under test — pin the explicit version (`add @mstar-harness/dsh@2.3.0`), record the deviation with evidence (never silently).

## Why This Matters

Without the installed-artifact path, tests can pass on src while the shipped package misses a bundling step (surface, mirror, or peer wiring) — the exact class this e2e caught (2.2.0 shipped no seeds surface). Dual cordis instances make composition tests meaningless (two registries, split state) while appearing green. And an unfaithful fake turns a race regression test into theater: red for the wrong cause, green for the wrong reason.

## When to Apply

- Explicitly requested independent plugin E2E that must prove the **published/installed** artifact, not the src build.
- Cordis composition tests where peers are host-provided (`autoInstallPeers: false` profiles).
- Explicitly requested verification of install-time capabilities after an npm publish.
- Boot-order / apply-window regression tests over the real upstream packages.

## Examples

### Copy-based single-instance resolution

```
installed pkg (temp DSH_HOME store)  --copy-->  <repo>/node_modules/.mstar-e2e/<run>/…
bare import '@deepseek-ai/cordis'  ──walk-up──▶  <repo>/node_modules (host instance)
Bun.resolveSync(cordis, distA) === Bun.resolveSync(cordis, distB)   # single instance pin
```

### Skip-guard

```
install-e2e: skip-guard probe ok (dsh bin + registry reachable)   # else describe.skipIf(reason)
```

Cross-links: `testing-patterns/mechanical-check-corpus-honesty.md` (fixture/probe honesty — no silent green) · `architecture-patterns/dsh-fallbacks-seeds-coexistence.md` (seeds semantics + config-loop readback under test) · `tooling-decisions/dsh-cli-install-surface-orchestration.md` (the CLI surface the loop rides).
