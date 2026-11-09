---
module: mstar worktree cleanup — evidence probing bounds and candidate scope (packages/commands/src/families/process.ts probe + packages/engine/src/cleanup.ts planner)
date: 2026-09-17
last_updated: 2026-11-09
problem_type: tooling_decision
category: tooling-decisions
severity: medium
plan_id: <plan-id>
applies_when:
  - "Changing the worktree-cleanup probe, its evidence rows, or its candidate universe"
  - "Diagnosing a slow `mstar worktree cleanup` dry run in a repository with many lifecycle snapshots or remote refs"
  - "Reviewing any probe whose cost looks like (inventory × anchors) rather than (anchors)"
  - "Relying on `bun test` as the only pre-merge gate for TypeScript changes"
tags:
  - worktree-cleanup
  - probe-cost
  - candidate-scope
  - fail-closed
  - typecheck-gate
---

# Context

`mstar worktree cleanup` plans guarded worktree/branch reclamation from immutable facts: ownership comes from snapshot rows, and every branch candidate must be justified by *merged evidence* bound to a recorded base ref. The planner (`packages/engine/src/cleanup.ts`) is pure and frozen; the probe that feeds it is CLI-side.

The pre-change probe resolved evidence the expensive way: for every remote ref it ran `git merge-base --is-ancestor <tip> <base>` once per base ref, with one stderr note per pair. Two multipliers turned that into a stall:

1. **Evidence bases are a cross-lifecycle union.** The probe collects `branch.base` + `branch.integration` + `branch.target` from *every* snapshot under the harness root, including terminal ones (`packages/commands/src/families/process.ts`, the `bases` set built before the `input.remote` gate). In this repo that was 30 distinct bases, of which **28 no longer resolve** (their `iteration/*` branches were deleted after merge).
2. **Unresolvable bases were re-probed per candidate.** A dangling base makes every `merge-base` invocation exit non-0/1, so each pair logged an "indeterminate" note. On a consumer repo with 887 remote refs × 29 bases that is ~25.7k subprocess spawns and 19,183 note lines over 660 distinct branches — a dry run past 300 s.

# Guidance

**Bound the probe per resolved anchor, not per pair.**

1. **Resolve each distinct base once**, per probe pass: `git rev-parse --verify --quiet <base>^{commit}`. Keep both the original name and the resolved OID. An unresolvable base yields **one** note and **no** evidence row — the fail-closed outcome the planner already had (`cleanup.refuse.unmerged`), now without `refs × dangling_bases` spawns.
2. **Local membership stays unconditional**: one `git branch --merged <baseOid>` per distinct resolved OID (reused across base-name aliases). This is what local branch candidates are judged against, whatever else is skipped.
3. **Remote evidence is collected only when remote candidates exist.** `facts.remoteEvidence` is consumed exclusively by `target.kind === "remote-branch"`, and those targets are built only under `--remote`. Gating the probe there is a **doc-precision fix, not a safety relaxation**: local membership and every guard/safety fact are unchanged. The owning skill sentence that said the "safety probe runs regardless of `--remote`" conflated the two — keep the local/remote distinction explicit.
4. **Prune, then batch, then attest per candidate.** Per resolved base: one positive sweep (`git for-each-ref --merged <oid>`) attests reachability; the residual pairs are answered by one negative sweep (`--no-merged <oid>`). Decide **every candidate from its own ref incarnation** — present as `refs/remotes/origin/<branch>` with the exact inventory tip in the positive sweep ⇒ `true`; else that way in the negative sweep ⇒ `false`; else no row. Do **not** memoize the graph answer across candidates or ref names: a cache keyed on `(tipOid, baseOid)` answers the same reachability question but skips the ref attestation, so two refs sharing a tip inherit each other's verdict and a branch whose ref moved can receive positive evidence — an external review caught exactly that as a delete-an-unmerged-branch path. The sweeps are already per resolved base, so per-candidate map lookups cost nothing extra.
5. **A failed sweep is indeterminate, never negative.** `ancestor: false` requires an explicit successful `--no-merged` attestation; partial stdout from a failed process is unusable; no per-pair fallback that reintroduces the quadratic path.
6. **Bound the notes by candidates + bases.** Default output carries one aggregated line per candidate (separating `not-an-ancestor` from `indeterminate`); per-pair detail lives behind `--verbose`, which adds diagnostics only — no extra Git work, no decision change.

**Keep candidate scoping and ownership separate.**

- **Selection is a filter, never a grant.** The default universe is the selected workflow's recorded claims; `--all-workflows` restores the full inventory sweep; `--worktree <path>` intersects asserted paths for worktrees and narrows *branch* candidates to the asserted worktrees' exact owner identities `(workflowId, planId-or-absent)` — including the row's retained `track_branches`, excluding sibling rows. Ambiguous claims stay visible but unowned.
- **The safety universe is never narrowed.** `CleanupFacts` keeps every snapshot (degraded siblings included), every worktree record, every lease and every protected anchor; only candidate *inclusion* changes.
- **Retention is a filter, not a cache.** Across `--apply` re-probes, keep the initially asserted-owner keys so branches stay in scope after their worktree is removed, but recompute attribution, tips and all safety facts on every pass.
- **Always ship a recovery path.** A mis-scoped candidate is discovered by re-running `--all-workflows` without `--worktree`; state that in the help text so the narrower default never becomes a dead end.

**Verify the bound deterministically, and do not treat `bun test` as a typecheck.**

- Observe Git invocations with a `PATH`-shimmed `git` recorder that appends `{cwd, argv}` JSONL and forwards to the real binary; assert argv histograms (zero `merge-base --is-ancestor`; base resolutions = B; sweeps ≤ 2V) and note counts (≤ B + R). Do not assert wall-clock.
- `bun test` runs TypeScript without typechecking: an accumulator typed via a **readonly** engine field (`CleanupFacts["remoteEvidence"]`) compiled fine at runtime and failed only under `bun run --cwd packages/cli typecheck:src`. Keep the package typecheck in the post-integration gate set for CLI changes.

# Why This Matters

The cleanup tool's whole value is that it refuses when it cannot prove eligibility. Cost work here is therefore *not* free to "optimize away" evidence: every removed spawn had to be replaced by an equivalent-or-stronger attestation, and every narrowed candidate set had to leave the safety facts intact. The failure mode being fixed was not a wrong decision but an unaffordable one — and the two were entangled, because unresolvable bases produced both the wasted spawns and the misleading note flood.

# When to Apply

- Any change to the cleanup probe, its evidence rows, its notes, or its candidate universe.
- Any new probe in this codebase whose cost is `inventory × anchors`.
- Any TS change in `packages/cli` heading for review: run the package typecheck, not just the test file.

# Examples

- Dangling-base measurement (this repo, HEAD `6c7ffa1f`): 30 distinct bases, 28 unresolved → the pre-change tool paid `remoteRefs × 30` spawns for evidence that could never exist.
- Positive/negative control for the sweep mechanism: `git for-each-ref --merged HEAD --format='%(refname)%09%(objectname)' refs/heads/main` → the ref+OID row; the same command with `--no-merged` → empty; against `HEAD^` the two swap. Proven direction, and cheap, on Git 2.55.
- Scope recovery: `--worktree <path>` on a path claimed by another workflow omits it in default mode; rerun with `--all-workflows --worktree <path>`, or point `--workflow` at its real owner.

Related: `tooling-decisions/worktree-dependency-dist-isolation.md` (feature worktrees carry no dependencies or dist builds). The dirty-worktree gate now reads plain `git status --porcelain` (`packages/commands/src/families/process.ts` worktree records), so ignored build output no longer blocks removal — the earlier `--ignored=matching` behaviour was retired with issue #279.
