---
module: mstar-workflow/dsh
date: 2026-09-24
problem_type: tooling_decision
category: tooling-decisions
severity: medium
plan_id: "20260924-dsh-rc2-upgrade"
last_updated: 2026-11-09
tags:
  - dsh
  - peer-dependencies
  - bun-lock
  - corridor-upgrade
  - phantom-imports
  - lock-regeneration
  - cohort-scan
---

# dsh peer cohort upgrades: lock regeneration + upstream phantom runtime imports

## Context

Every dsh corridor upgrade (`^0.1.5-rc.2 → ^0.1.7-rc.1 → ^0.1.7-rc.2`, measured in iteration `iter-20260924-dsh-rc2-upgrade`) hits the same two hazards, both caused by upstream dsh's prerelease publishing model: (a) a peer-range bump that is only **partially** reflected in `bun.lock` leaves a stale, self-pinning resolution graph that a plain `bun install` cannot heal; (b) upstream client packages runtime-import packages they declare only in their own `devDependencies`, so external consumers must compensate or their test/runtime module graph fails to load.

## Guidance

**1. Regenerate the lock on cohort bumps — never plain-install.** After rewriting the `@deepseek-ai/dsh-*` peer ranges in `packages/dsh/package.json`, run `rm bun.lock && bun install` at the repo root. A plain `bun install` after a partial refresh keeps the stale rc.N graph alive: existing `0.1.5-rc.2` resolutions satisfy the old peers' own `^0.1.5-rc.2` self-demands, so bun considers the graph consistent and re-pins it (probe-verified: `rm`-regeneration shed the stale subtree and re-resolved 62 peers to one version; plain install left 59 stale + 3 new and kept `typecheck:src` red). Verify with the cohort scan — `grep -nE '@deepseek-ai/[^"]*0\.1\.(<old-versions>)' bun.lock` filtered to `@deepseek-ai` must return 0 lines — and confirm a single distinct dsh version across the lock. Expect lock churn beyond the cohort (in-range re-resolutions, stale subtree shed); record the churn summary for the PR description.

  *Cohort line as of 4.3.0 is `^0.2.2-rc.1` (the `0.1.x` version token in the scan above is the pattern's historical example — substitute the line you are leaving), and the current lock resolves one version, `@deepseek-ai/dsh-*@0.2.2-rc.1`, with zero `0.1.` remnants. The per-seam re-check list for the current hop lives in `architecture-patterns/dsh-corridor-upgrade-adaptation-seams.md`.*

**2. Compensate upstream phantom runtime imports consumer-side.** Upstream client packages (`dsh-client-ui-primitives` et al.) runtime-import packages declared only in their own devDependencies. The plugin's `devDependencies` are the sanctioned compensation layer — it already carries `anser`, `shiki`, `katex`, `mdast-*`, `clsx`, `react` for exactly this reason. On each corridor hop, enumerate the barrel's import surface, diff against installed/dev-declared packages, and add the missing ones with **upstream's own pins** (exact versions for upstream-exact pins like `simple-icons: 16.31.0`, upstream ranges for caret pins like `diff: ^9.0.0`, exact cohort pins for new `@deepseek-ai/*` packages like `dsh-util-code-language@0.2.2-rc.1`). rc.2 added three: `simple-icons`, `@deepseek-ai/dsh-util-code-language`, `diff` — all three still present in `devDependencies` at 4.3.0, at the shapes that rule prescribes (`simple-icons: 16.36.0` exact, `diff: ^9.0.0` caret, `@deepseek-ai/dsh-util-code-language: 0.2.2-rc.1` cohort-exact). Symptom when missed: spec files that mount real client bundles register **0 tests** with unhandled `Cannot find module` load errors — full-suite pass counts can hide this (tests vanish instead of failing), so always compare registered-test counts, not just pass/fail.

**3. Baseline-first attribution on the integration state.** Record typecheck/build/test output on the pre-bump branch state before touching peers, and diff post-bump failures against that recorded table — fresh-worktree artifacts (missing workspace builds, transient SQLite opens) otherwise masquerade as upgrade breakage. Expected rc.2-segment deltas were ~3 src + ~39 test type errors, all mechanical, dominated by one root cause each (removed `JobSnapshot`/`JobDoneListener` exports; `SidebarRightGuideEntry.id` required; a schemastery 3.18.4 `Volatile` typing drift that is a **baseline-carried** error but still blocks CI and needs its mechanical fix).

## Why This Matters

The half-open-corridor state (peers bumped in `package.json`, lock stale) is exactly what a "simple version bump" produces, and its CI symptom (one unrelated-looking schemastery type error) gives no hint that 59 resolutions are stale. The phantom-import class fails silently (tests disappear rather than fail). Both hazards cost probe rounds to diagnose from scratch on every corridor; this doc turns that into a checklist.

## When to Apply

- Any `@deepseek-ai/dsh-*` peer range change in `packages/dsh/package.json`.
- After any upstream dsh tag that adds client-facing packages or client-barrel imports.
- When panel/client-bridge spec files report unhandled load errors or suspiciously low registered-test counts.
- After any future lock regeneration: rerun the single-version cohort scan + `packages/dsh` `peer-deps.spec.ts` (issue I-000227).

## Examples

- Iteration `iter-20260924-dsh-rc2-upgrade` (plan `20260924-dsh-rc2-upgrade`): Task 1 recorded the mixed-lock baseline, regenerated the lock (commit `d2bab157`); Task 2 fix rounds F1–F3 added the three phantom-import shims (`bd7e161c`, `091cc2b8`) and a test-double stub (`7d308666`); full suite went 1212 tests / 5 unhandled load errors → 1394 / 0.
- Related knowledge: `tooling-decisions/dsh-peer-stub-dev-strategy.md` (superseded link-farm history; registry peer resolution is the current baseline), `tooling-decisions/dsh-llm-fallbacks-version-ssot.md` (exact-pin SSOT pattern for versioned literals).
