---
module: dsh-workflow-gate
date: 2026-08-15
problem_type: architecture_pattern
category: architecture-patterns
last_updated: 2026-11-09
severity: high
tags:
  - dsh
  - workflow-gate
  - pre-tool-decision
  - ask-cache
  - lease-attribution
  - policy-composition
related_components:
  - packages/dsh/src/gates/workflow-policy.ts
  - packages/dsh/src/gates/dispatch.ts
  - packages/dsh/src/gates/workflow-ledger.ts
  - deepseek-harness packages/core/tools
applies_when:
  - implementing a PreToolDecision gate over workflow/ralph or non-prompt-args tools
  - designing human-in-the-loop ask tiers with observation-based answer caching
  - composing multiple policy axes (allowlist / lease / ask) into one verdict
  - deriving cache identity from model-controlled strings across seams
---

## Context

W-B3 (iter-20260815-fallbacks-personas-workflow, plan `20260815-dsh-workflow-gate`) implemented the four-tier `workflowGate` (off/warn/ask/hard) with P-a name allowlist, P-b lease attribution, P-c first-seen ask. Three composed-behavior defects survived task review and were only caught at plan QC — each is a pattern-level lesson. Capability model (what channels exist): `architecture-patterns/dsh-workflow-composition-gate-coverage.md`; this doc is the implementation-pattern companion.

## Guidance

1. **Observation-based answer caching must be gated by the question being asked.** P-c caches "allow" when a run-start is observed (an allowed call necessarily starts). The hole: a run observed WITHOUT a prior ask (mode switched later, pre-ask runs) pre-authorizes the name forever. Fix: `markAsked(name)` on EVERY ask decision; the observation records allow ONLY for `wasAsked(name)` entries. Generalizes: an inference-based answer channel must prove the question was posed, not just that the outcome occurred.

2. **One identity function at EVERY seam that keys, compares, or records the same model-controlled string.** The gate keys the ask cache on `meta.name`; the run-start observation keys on the ledger row's name; the allowlist compares entries; the verdict row records it. Four seams, one `normalizeWorkflowName` (control chars stripped, length never capped on the identity axis — display truncates separately). Any asymmetry (sanitize at one seam, raw at another) produces re-ask-forever or silent-miss bugs invisible to single-seam tests. Test with control-char names and >cap names at the SEAM PAIR level.

3. **Policy preemption order is a product decision — write it down.** P-b (lease red line) preempts P-a/P-c: an allowlisted name in an uncovered writable workspace is still denied under hard. The orphan-`InProgress`-without-lease red line outranks deployment convenience. Ralph (no `meta.name`): P-b only — P-a/P-c are undefined for it, not defaulted.

4. **Fail-open vs fail-closed is per-edge, never global.** Mandated directions for a gate over untrusted args: malformed args → fail-OPEN (pass + one warn); unreadable/shape-invalid status → fail-OPEN for P-b (a broken status read must not brick fan-out) with a parity warn; un-answered ask → fail-CLOSED (dsh's approval waterfall denies without an answerer — never build a plugin-side default-allow). Audit each edge explicitly at plan QC; inversions pass happy-path tests.

5. **`off`/degraded modes must be side-effect-free.** Mode `off` short-circuits before any ledger row, warn, or cache mutation. A degraded policy (unreadable status) skips that axis but still runs the others — partial evaluation, not all-or-nothing.

6. **Verdict vocabulary may need an `ask` member.** "One row per gated call" forces recording pending-decisions: `ok | advisory | denied | ask`. The ask-resolved lifecycle then spans rows: ask-row → (answer) → run rows/W-B2 → next call's ok row.

7. **Per-call source reads are the correct cost for lease attribution.** One read per gated fan-out call (not per tool call) buys decision-point freshness. The coverage check (`writableFanOutUncovered` in `dispatch.ts`) walks every `InProgress` row of the resolved lifecycle and treats a row WITHOUT a recorded scope (`metadata.worktree_path` + `metadata.working_branch`) as uncovered — per-row `execution_lease` is gone (store migration 9 settled retired holders into row metadata), so the red line survives as `workflow.lease.uncovered` over recorded row scope. Assignment-keyed helpers don't compose — iterate rows directly.

## Why This Matters

Defects 1 and 2 are structurally invisible: single-seam tests pass, positive controls pass, and the failure only manifests as a security bypass (1) or an infinite re-ask loop (2) in composed production behavior. Both were Warning-severity QC finds against an approved-at-L2 implementation.

## When to Apply

- Any `{kind:'ask'}` gate tier with an observation-based answer channel.
- Any cache/allowlist/record keyed by a model-controlled string crossing ≥2 modules.
- Any multi-axis tool gate (allowlist × lease × human-approval) — preemption order + per-edge fail direction need explicit design + QC probes.

## Examples

- `packages/dsh/src/gates/workflow-policy.ts` (four-tier policy, `WorkflowAskCache` with `markAsked`/`wasAsked`/normalized record, `WORKFLOW_LEASE_UNCOVERED_CODE` / `WORKFLOW_NAME_UNKNOWN_CODE`).
- `packages/dsh/tests/workflow-gate.spec.ts` (tests 13-18: control-char congruence, uncapped identity, ask-deny fail-closed, un-asked-run no-bypass).
- QC evidence: `.mstar/sdd/20260815-dsh-workflow-gate/review/qc2.md` (W-1/W-2) + `qc-consolidated.md`.
