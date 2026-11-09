---
module: mstar-workflow/dsh
date: 2026-08-08
problem_type: architecture_pattern
category: architecture-patterns
severity: high
plan_id: "20260808-dsh-package-core, 20260808-dsh-host-adapter, 20260808-dsh-seams-bundle"
tags:
  - dsh
  - mstar-engine
  - cordis
  - host-adapter
  - enforcement
last_updated: 2026-11-09
---

# dsh × mstar-engine cordis plugin integration

## Context

mstar-harness v2.0.0 shipped `@mstar-harness/engine` (zero-dep ESM bundle, 15 modules) making deterministic workflow rules machine-checkable. Its compass deferred pi/dsh host adapters until "those host plugin APIs exist". dsh (DeepSeek Harness SDK, vendored-Cordis plugin harness) has a plugin API, so the deferral matured into an integration: a cordis plugin (`@mstar-harness/dsh`) adopting the engine, developed on the mstar-workflow private mirror (`dev-dsh`).

## Guidance

**Placement** — the plugin lives with the engine's repo (mstar-workflow → upstreamable to mstar-harness as a permanent host-adapter package, mirroring `packages/opencode`). dsh-side distribution is an out-of-tree profile bundle (`dsh plugin --profile mstar add <package>`), NOT a package inside dsh-private.

**Dependency model (three slots)**:
- `dependencies`: pure external libs only (today `zod`) — the engine is NOT a runtime dependency. NEVER any `@deepseek-ai/dsh-*` (double-instance/type-split risk).
- `peerDependencies`: `cordis` + every consumed dsh seam, all at the ONE shared cohort range (today `^0.2.2-rc.1`; originally `^0.0.1`): dsh-tools, dsh-fs-policy, dsh-subagent, dsh-agent, dsh-llm, dsh-skill, dsh-skill-local. The engine (`^4.0.3`) is ALSO a peer — the host supplies it, the build bundles it. Runtime resolution is the host app's job.
- `devDependencies`: engine (build-time, per v2.0.0 first-party convention: exact pin + bun bundle into dist; never a runtime dep) + copies of the peers for tests (workspace:^ inside dsh-private; `file:` links or committed peer-stubs from outside).

**Enforcement model** — cordis has REAL refusal channels, unlike opencode's void `tool.execute.before`:
- `fs/write-intent` + `fs/edit-intent` (single-slot waterfall): veto = **throw**; allow = `next()`.
- `tools/pre-execute`: `PreToolDecision {kind:'deny', reason}` without `next()`.
- `agent/pre-step`: advisory only — must call `next()`; never reject/enter.
- `subagent/start` is `@mode emit` (observation), NOT a gate.
- `Enforcement: hard` per compass/Assignment flag; default warn-only; repair-escape (invalid on-disk doc → allow-as-repair) prevents veto deadlocks on content-blind slots.

**Module → seam mapping (delivered)**: path/status/lease → fs intents + subagent/start checks; dispatch (validateAssignmentFields/antiRecursion/branch gate) → tools/pre-execute with `assignmentHeaderRegion` scoping; worktree L1/L2 → dispatch gate; sdd/iteration/design-md/audit/compound/roles → defineTool wrappers + artifact-scoped fs gates; host → engine `host.ts` dsh row; skill-authoring → skill-root scoped SKILL.md lint; catalog → MessageSourceMap `mstar-engine` at pre-step (model-visible ⟺ logged; the pre-rename `plugin:mstar-engine-status` identity survives only in persisted V3 logs, which the panel anchor reader still accepts).

**Model-context surfaces and emission cadence** — the plugin feeds the model through two surfaces with different jobs, and they must not be duplicated:
- The **always-on system prompt** carries the small, stable facts: `mstar:harness-rules` (presence, enforcement, resolved `{HARNESS_DIR}`) and the `mstar:engine-status` digest (version, plus one `workflow … | plans: …` line only when the session's workspace has an ACTIVE workflow).
- The **pre-step `mstar-engine` catalog row** carries the changeable workspace state (iteration phase gate + workflow selection, plans, residuals, branch/policy, row scope, knowledge, direction, agent flow). It is a **renderer projection** of `MstarEngineStatusPayload`, not a byte-identical dump: the version/harness-dir/enforcement watermark stays payload-only (the web panel's meta dock renders it) because the system prompt already exposes those facts.
- **Emission is change-driven**: append (and persist the panel snapshot at the same gate) on first emission for a session/workspace, when the rendered text changes, or when the panel-relevant payload projection changes — never merely because a new turn started. The projection must normalize exactly the payload fields the emission's own store write perturbs (`state.storeFacts.storeRevision` is one: the write advances the store revision, so comparing raw payloads would re-emit every turn).
- Persistence stays inside the emission gate, so the stored row is "the last payload the model saw emitted" and panel freshness is change-driven; the freshness footer's `turn`/`at` mean last emission, not current turn. No `{HARNESS_DIR}` resolves → no row at all (an empty wrapper over an empty projection is noise).
- Rejected shapes, for the same reason: suppressing the row for idle sessions (loses the panel anchor and the only disclosure of why agent-flow attribution is refused) and periodic re-anchor after context compaction (it recreates the per-turn repetition; the digest still carries version + active workflow + plans, so the limitation is documented rather than worked around).

## Why This Matters

- First host with in-process hard-gate enforcement; parity discipline (same engine fns → same violation codes as opencode) keeps cross-host semantics identical.
- The peer-dep model keeps the plugin runtime-independent of dsh's private registry (host provides seams).
- Header-region scoping of Assignment parsers is a security boundary (body-quoted fields must not nullify branch protection).

## When to Apply

- Upstreaming this work to mstar-harness (engine host.ts + plugin) — keep the engine change minimal (HostId/DetectResult/ToolSignal/resolveSkillRoot case) + mirror docs (mstar-host skill, CLI HOST_SIGNALS) + `.changes` fragment.
- Any future host adapter (omp in-process, etc.).

## Examples

- `detectHost` dsh signal: ToolSignal `subagent` (dsh's delegation tool name); detection row after omp.
- `resolveSkillRoot('dsh', {skill})` → `$DSH_BUNDLED_SKILL_DIR/<name>[/<rel>]` (skill-local bundled root, frozen single canonical mount).
- Profile bundle: `dsh.bundle.patch` nested manifest + `cordis.patch.yml` insert op; enforcement absent (OFF by default); `bundledSkillDir ./skills` is cwd-anchored → production form = absolute override in profile layer.
