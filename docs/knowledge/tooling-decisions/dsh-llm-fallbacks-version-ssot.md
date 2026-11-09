---
module: dsh-llm-fallbacks
date: 2026-09-12
problem_type: tooling_decision
category: tooling-decisions
severity: medium
tags:
  - dsh
  - dsh-llm-fallbacks
  - version-pin
  - single-source-of-truth
  - cli-init
  - drift-gate
related_components:
  - packages/dsh
  - packages/cli
  - packages/engine
source_plans:
  - 20260911-dsh-fallbacks-0-5-2
status: active
last_updated: 2026-11-09
---

# dsh-llm-fallbacks pin: two literals, everything else imports

## Context

The fallbacks version was hand-copied in five tracked places (`packages/dsh/package.json`, `fallbacks-probe.spec.ts`, `install-doctor-e2e.spec.ts`, `packages/cli/src/adapters/dsh.ts` `DSH_FALLBACKS_VERSION`, `packages/cli/test/dsh-adapter.test.ts`). A bump that missed one produced split pins: dev tests on the new version, `mstar init --target dsh` still installing the old one — whose peers no longer match the repo's `@deepseek-ai/dsh-*` line (0.4.1 peers `^0.1.2-rc.1`; the repo line is `^0.1.5-rc.2`; mismatched rc lines break installed-artifact boot).

## Guidance

Exactly **two literals** (as of 4.3.0):

1. `packages/dsh/package.json` `devDependencies["dsh-llm-fallbacks"]` (bun needs a real spec).
2. `packages/cli/package.json` → `mstar.dshLlmFallbacks`, read **at runtime** by `dshFallbacksVersion()` (`packages/commands/src/host-health/dsh.ts:38`, via `readCliManifestField` / `cliManifestCandidates` in `packages/commands/src/host-health/cli-manifest.ts`). This replaced the former `@mstar-harness/engine` `DSH_LLM_FALLBACKS_VERSION` export — the engine constant no longer exists anywhere in the repo. A compiled-in constant was never the only option: `packages/cli/tsconfig.json` has no `resolveJsonModule`, but a runtime `readFileSync` of the manifest beside the published bundle does work, and `commands` ships inlined into the CLI bundle so it resolves the CLI's own `package.json`.

Everything else imports/calls the resolver — `dshPluginSpecs()` / `dshFallbacksSpec()` supply the versioned spec to both `init` and `doctor`. `init --target dsh` / doctor are **version-aware**: a mounted fallbacks row whose version ≠ pin is a `drifted` doctor error (exit 1) and `init` re-runs the versioned `dsh plugin add` (`fallbacksVersionDrifted`) — never "already installed, skip".

**Known gap (no longer gated by a test):** the former drift test asserting the engine export === the package.json field is gone with the export. No test compares the literals in (1) and (2); the invariant is recorded externally instead — issue `I-000956` plus seam 6 of `architecture-patterns/dsh-corridor-upgrade-adaptation-seams.md` ("two pins in one change set"), and the 0.6.x → 0.7.0 moves were kept in lockstep by their release fragments alone (`git show 376d2e96`). Treat "the two hand-written literals move together" as a same-commit review obligation, not a red test; restore a lockstep test if this pin is bumped again.

## Why This Matters

"Upgrade to latest" is only real if existing profiles are upgraded too. Bare-name skip + five copied strings made the pin move cosmetic. The drift test converted "don't forget" into a red test — and its removal is why the current two-literal gap above is a review obligation rather than a gate.

## When to Apply

Any version that must stay in lockstep across a published CLI binary and workspace tests. The chosen shape is **manifest-carried literal + runtime reader** (`mstar.<key>` read by `readCliManifestField`) rather than a compiled-in engine constant or a bun catalog: the published CLI dist cannot import JSON at build time (`resolveJsonModule` off), but at runtime the manifest sits beside the bundle, so the value needs no codegen and no engine export.

## Examples

- `packages/cli/package.json` `mstar.dshLlmFallbacks` = `"0.7.0"` and `packages/dsh/package.json` `devDependencies["dsh-llm-fallbacks"]` = `"0.7.0"` — the two live literals today.
- `packages/commands/src/host-health/dsh.ts` (`dshFallbacksVersion`, `dshPluginSpecs`, `fallbacksVersionDrifted`, the `drifted (installed <v>, pinned <pin>)` rows) + `packages/cli/src/adapters/dsh.ts` (needsVersionAlign / versioned re-add) + `packages/cli/test/dsh-adapter.test.ts` (drift re-add, drifted error + exit 1).
- `packages/dsh/tests/install-doctor-e2e.spec.ts` cell 4: real `dsh plugin add dsh-llm-fallbacks@<old>` → doctor exit 1 `drifted (installed <old>, pinned <new>)` → `init --target dsh` repairs → doctor healthy.
- Historical peer facts stay literal in comments (`0.4.1` peers `^0.1.2-rc.1`) — never token-swap a true historical sentence into a false one.
