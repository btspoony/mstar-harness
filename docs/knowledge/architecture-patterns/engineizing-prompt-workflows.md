---
module: mstar-harness-engine
date: 2026-08-08
problem_type: architecture_pattern
category: architecture-patterns
last_updated: 2026-11-09
severity: high
plan_id: <plan-id>
applies_when:
  - splitting a prompt-harness (skills, role prompts) into deterministic rules vs judgment
  - adding machine-checkable gates to prose-only workflow docs without breaking standalone use
  - wiring host hooks (before-write / before-dispatch) that must degrade gracefully
tags: [programmatic-split, skill-ssot, engine, advisory-pointer, drift-control, enforcement-ladder]
---

# Engine-izing prompt workflows: the programmatic split

> **Applicability clarification (2026-09-07):** This records the v2 split. The no-content-moves condition in §1 and full-prose retention in §2 are superseded by the later [conditional sink convention](../conventions/skill-thinning-sink-convention.md). Preserve standalone access to the full contract, not duplicate full text in every runtime body. Its inventory, drift and refusal-channel lessons remain applicable. The v1 status examples below are historical shapes, not current schemas.

## Context

Morning Star's deterministic workflow rules (status schema, leases, SDD loops, dispatch fields, phase gates, path conventions) lived as prompt prose plus a few bash scripts. On customizable code agents, prose rules are easy to skip, reinterpret, or implement inconsistently — "should be checkable" work becomes judgment noise and cross-host drift. The v2.0.0 iteration (slices 1-5) turned the checkable subset into a shared TS engine (`@mstar-harness/engine`, 15 modules) with a thin CLI and host hooks, while keeping every skill fully usable without the engine (25 skills today).

The iteration's design document (`{PROJECT_DIR}/engine/references/skill-programmatic-roadmap.md`) records the program's architecture and decisions. This doc captures the **reusable method** and the **gotchas** — how to run such a split in any prompt-driven codebase, and what fails silently if you don't.

## Guidance

### 1. Inventory every content item as [P], [J], or [M] before designing the engine

Tag each rule in the prompt corpus: **[P]** programmatic (deterministic, checkable, enforceable: schemas, state machines, path conventions, pass/fail gates, ledger writes), **[J]** judgment (tone, escalation, role identity, subjective review, conversation), **[M]** mixed (checkable subset + judgment core). Then apply a product filter: only ship engine surfaces that (a) agents/CI can invoke without host-specific judgment, (b) preserve standalone skills, (c) avoid physical content moves, (d) exclude hosts whose plugin APIs don't exist yet.

Per-skill verdicts come out of this: **programmatic-first** (high drift cost if prose-only), **hybrid** (engine takes the checkable subset; judgment stays prompt), **judgment** (little or nothing moves; optional lints only).

### 2. Keep the skill as semantic SSOT; engine implements, never forks

The skill states every rule in prose; the engine implements the deterministic subset. Do **not** physically move programmatic content out of skills into engine docs — that makes the engine a load-order dependency and breaks standalone use. The skill body must remain fully usable with the engine uninstalled.

### 3. Pointer callouts are advisory, one format everywhere

Place a fenced blockquote callout immediately after the rule it enforces:

```markdown
> **Engine check (when available):** run `mstar status validate <path>` (or
> `import { validateStatus } from "@mstar-harness/engine"` in a host hook).
> On `fail` -> do not proceed; fix and re-run. Skill text below remains
> authoritative when the runtime is absent.
```

The callout names a **real** engine export + CLI subcommand (drift lint verifies both directions). It is a hint, not a `Read next` dependency.

### 4. Drift control is a test contract, not a hope

- Every engine unit test **cites the source skill section as its spec** (e.g. `status.validateStatus` test references `mstar-plan-artifacts/references/status-and-residuals.md § Basic structure`). Skill changes break the test until the engine matches; engine changes require the citation to still hold.
- A **drift lint** (CI) checks that every pointer callout references an existing engine export, and every spec-citation comment references an existing skill section. Fail closed when the export inventory can't be parsed.
- A **standalone smoke** (CI, no engine installed) loads every skill and asserts no engine import in load order. Guard it against false passes: check the load-order sections specifically, not the whole file.

### 5. Enforcement is a ladder, opt-in at the top

1. **Non-blocking lints** — validators return structured results (`{ ok, severity, code, message, fix? }`); callers surface as warnings. This is the default and the only depth most consumers need.
2. **Hard gates** — host hooks *refuse* the violating action, enabled **per Assignment/compass flag only, never global**. Rollback is unsetting the flag; the flag is inert when the engine is absent.

A host hook that cannot actually refuse (no refusal channel on the platform) must not claim "blocked" in its logs — log `hardBlocked` + the truth about the missing channel, or operators will believe an action was prevented when it wasn't.

## Why This Matters

- **[P]/[J]/[M] inventory is the scope boundary.** It decides what gets built as validators and what stays prompt; skipping it produces either an unenforceable engine or a full workflow rewrite.
- **Standalone is the hard invariant.** Skills that require the engine stop working for the majority of users who never install it — the split must be *additive*: removing the engine never removes capability.
- **Prose and code drift silently.** Without test-cites-skill-section + drift lint + standalone smoke, the engine and skills fork within one iteration, and nobody notices until a gate gives a different answer than the skill text.
- **Enforcement depth is a trust curve.** Warn-only first; blocking only behind an explicit per-dispatch/per-iteration flag. A global hard gate breaks workflows that were soft before and cannot be rolled back incrementally.

## When to Apply

- A prompt-harness (skills, commands, role prompts) contains deterministic rules that agents routinely skip or interpret inconsistently.
- You need the same pass/fail answer across multiple hosts and CI, while prose remains the semantic source.
- You are adding host lifecycle hooks (before-write, before-dispatch) and must not break the no-engine workflow.
- A workflow rule is claimed "enforced" but is only advisory prose — apply the ladder to make the claim honest.

## Examples

### Before

```text
status.json must contain version, updated_at, plans[] — and residual
findings live at root only. (Also, agents should validate this before
writing. See the schema table above.)
```

No machine can check it; every agent re-implements (or skips) the check differently; the "should validate" instruction is unverifiable.

### After

```text
status.json must contain version, updated_at, plans[] — and residual
findings live at root only (reject dual-write).

> **Engine check (when available):** run `mstar status validate <path>`
> (or `import { validateStatus } from "@mstar-harness/engine"` in a host
> hook). On `fail` -> do not proceed; fix and re-run. Skill text below
> remains authoritative when the runtime is absent.
```

Prose is unchanged and sufficient alone; the callout names the checkable surface; the engine test cites this section as its spec; CI drift lint keeps the export name real; the host hook warns (or blocks, behind the opt-in flag) on violations.
