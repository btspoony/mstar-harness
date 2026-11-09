---
module: packages/engine/src/coordination.ts + packages/engine/src/workflow.ts + the plan-workflow lifecycle contract
date: 2026-09-17
problem_type: architecture_pattern
category: architecture-patterns
severity: high
applies_when:
  - "A workflow kind cannot reach a terminal state because a shared precondition assumes the wrong route"
  - "Deciding whether a blocking guard should be relaxed or a missing path should be added"
  - "Persisted state records an identity that contradicts the Git facts it was derived from"
  - "Verifying a gate-class change with a tool that predates it"
plan_id: 20260917-plan-lifecycle-unblock
tags:
  - route-predicate
  - completion-path
  - identity-repair
  - fail-closed
  - published-cli-lag
---

# Route-specific completion predicates, and the identity repair that unblocks history

## Context

A plan-level lifecycle contract declared two kinds of workflow: an **iteration** whose child rows are integrated onto a dedicated branch, and a **standalone development plan** that delivers its own PR with no integration stage. The engine implemented the iteration route faithfully and reused its completion writer for both. Standalone registration wrote only `branch.source` / `branch.target`, while the sole row-`Done` writer hard-required `branch.integration` + `integration_worktree_path`. The result was a deadlock with no repair hatch: a standalone plan whose PR was already merged could not reach `Done`, so the workflow could never close, and when a sibling change later refused to record delivery evidence before a row was `Done`, the route became blocked mid-flight rather than only at close.

Two facts made the repair instructive rather than mechanical. First, the obvious fix — accept an optional anchor — would have silently weakened the iteration route, whose entire guarantee is that a merged row sits on an integrated branch. Second, once the completion path existed, the historical snapshots still could not close: they had registered `branch.source = main` while their accepted handoffs named feature branches, and the close-time evidence check requires the recorded PR head to equal the recorded source branch. Git truth existed; the snapshot's identity was simply wrong.

## Guidance

**Split the predicate by route; never widen one predicate to cover two routes.** Classify the route from declared facts (`type`, delivery kind, row cardinality), not from which anchors happen to be present. Doing it the other way — "if integration is absent, treat it as standalone" — lets a mis-registered iteration silently take the standalone path, which is the failure mode the original guard existed to prevent. Two predicates, one writer, one branch point is the shape that survives review; `source ?? integration` is not.

**A missing path is a bug; a relaxed guard is a regression.** When a legal state cannot be reached, first check whether the *path* is absent rather than the *guard* being wrong. Here the contract already described a lifecycle with no integration stage, so the implementation contradicted a frozen decision and the guard was doing its job.

**Repair instruments must be identity-only and evidence-pinned.** The unblock for history was a coordinator-only operation that derives a replacement value *solely* from an already-accepted, evidence-sealed handoff, under the snapshot lock and an expected revision, changing exactly one field plus the revision and timestamp. Everything else — delivery evidence, statuses, leases, target, handoff pins — is copied byte-for-byte, and the operation can never produce `Done`. A repair that can also complete, or that accepts a caller-supplied replacement, is a fabrication channel wearing a fix's clothes.

**Enumerate the refusals that keep a repair narrow.** A guard list is what makes a new verb reviewable. The set that worked: unsupported workflow shape; terminal snapshot; no accepted handoff; already aligned (including a second application with a fresh revision); not the legacy shape; conflicting stored delivery identity; absent or unreachable ref; Git unavailable. Every refusal must be mutation-free, and the tests assert the bytes as well as the code.

**Provider evidence must be the provider's, and a mismatch must be stated, not smoothed.** One historical workflow's provider head equalled its accepted pin; the other's head was one commit later — a post-handoff CI fix — while the provider's own PR commit list contained the pin. The defensible rule is to say exactly that, in the durable evidence, rather than to reason from local ancestry: "the pin is a commit this PR merged" is a provider fact, "the pin is an ancestor of the head" is a local one.

**A gate-class change cannot be validated by the published tool.** After the fix, the two adopted snapshots validated `OK` under the CLI built from the reviewed revision and `FAIL` under the globally installed published CLI, which predated it. The same lag makes unrelated commands read adopted state as malformed and degrade conservatively. Any verification of gate behaviour must name the artifact revision it used; a green light from a published binary is evidence about the published binary.

## Why This Matters

Route conflation and guard relaxation both fail late and quietly: they surface as "the workflow will not close" weeks later, on state nobody remembers creating. The split costs one predicate and one branch point. The repair costs one narrowly specified verb and buys back every already-delivered workflow that would otherwise stay permanently open, holding leases that block cleanup.

## When NOT To Apply

Do not add a repair verb when the state can be re-derived or the workflow can simply be abandoned through the existing `failed` / `stopped` path — a repair instrument that grows a second purpose stops being reviewable. Do not split predicates when the two workflows genuinely share one completion semantic; the cost is duplicated proof, and divergence between two copies of the same rule is its own defect class. And do not treat a conservative degraded read (a consumer that protects more than it removes when a sibling is unreadable) as damage to be fixed in the same round.

## Examples

- The deadlock: `registerPlanWorkflow` wrote `branch.source` + `branch.target`; the only row-`Done` writer required `branch.integration` + `integration_worktree_path`, refusing with `coordination.integration-unresolved`.
- The surviving regression: after the split, the iteration route still refuses a workflow without those two anchors, asserted through the public writer rather than a private predicate.
- The repair's delta, asserted as bytes: `branch.source`, the row coordination revision and the snapshot timestamp changed; delivery evidence, statuses, leases, target and handoff pins identical.
- The verification trap, observed: workspace-built CLI `OK` versus published CLI `FAIL` on the same two snapshots.
