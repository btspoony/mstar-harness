---
module: sdd-workspace
date: 2026-08-08
last_updated: 2026-11-20
problem_type: config_error
category: config-errors
severity: high
plan_id: <plan-id>
symptoms:
  - "bash sdd-workspace resolved .agents/ as the harness root in a repo whose local harness root is not a probed name"
  - "SDD workspace trees created under the wrong harness directory"
  - "a linked feature worktree carrying a stray status.json resolved and created a second SDD tree under the feature checkout"
root_cause: "harness-root discovery only probed the conventional names ({HARNESS_DIR}/.agents) and returned the first existing candidate; no explicit override existed for non-default harness roots, and the status.json probe ran before any linked-worktree guard"
resolution_type: code_fix
tags: [harness-root, path-resolution, sdd-workspace, worktree, fail-closed, override]
---

# Harness-root discovery override

> **Superseded (2026-11-20):** the explicit override this record introduced is retired. The harness root is fixed at `<git main worktree root>/.mstar/`; see `docs/adr/proposed/architecture/2026-11-20-fixed-harness-root.md`. The fail-closed linked-worktree ordering below remains in force.

## Problem

The bash `sdd-workspace` script discovered the harness root by probing `.mstar` → `.agents` and picking the first existing candidate. In a repository whose local harness root is not one of the probed names, the probe found `.agents/` and created SDD trees there — the wrong root. The TS port needed an **explicit harness-root override** so non-conventional roots resolve correctly, plus a fail-closed guard so linked worktrees can never create a second SDD tree under a feature checkout.

## Symptoms

- `sdd-workspace` placed `{SDD_DIR}` under `.agents/` (or another probed-but-wrong root) instead of the repository's actual harness root.
- SDD runtime artifacts (briefs, reports, progress ledgers) split across two harness roots, breaking the "control-path harness SSOT" invariant (`mstar-branch-worktree` 「Harness path SSOT under default gitignore」).
- A `git worktree add` feature checkout containing a stray `{HARNESS_DIR}/status.json` resolved an SDD tree under the feature checkout — the exact "second SDD tree" hazard.

## What Didn't Work

- **Probing additional ad-hoc names as candidates**: rejected on purpose — the probe covers only consumer conventions (`{HARNESS_DIR}/` → `.agents/` → `.plans/`/`plans/`); repos with another harness root use the explicit override. Growing the probe list would make consumer behavior ambiguous.
- **Status.json-first probing**: the bash order (probe `status.json` *first*) resolved a linked worktree with a stray status file and created the second SDD tree. Any ordering that lets a probe win before the worktree guard fails closed is unsafe.
- **Relying on `CONTROL_ROOT` alone**: pinning the root to the control worktree helps the common case but doesn't cover repos whose harness root name is simply not in the probe list — the root itself must be overridable.

## Solution

The explicit override this record introduced is retired. The harness root is now one fixed location.

1. **Fixed root.** `resolveHarnessDir` derives `<git main worktree root>/.mstar/` from Git; `harness_dir`, `MSTAR_HARNESS_DIR` and the legacy candidates are refused rather than honored. A CLI outside Git names the root with `--harness`.
2. **Fail-closed FIRST (retained).** In `sddWorkspace`, the linked-worktree guard runs before any resolution: a linked worktree without an established main root refuses instead of creating a second SDD tree.
3. **Refusals name recovery.** A `harness_dir` declaration names the line to delete; a legacy-only checkout names `mstar harness scaffold` / `mstar store upgrade`; `MSTAR_HARNESS_DIR` names `unset`.
4. **Historical ordering.** The old rung chain (override → `.mstarc` → `.mstar` → `.agents`) is gone; only the fail-closed guard ordering survives.

```ts
// current sddWorkspace resolution
const main = readMainWorktree(cwd);   // fail-closed FIRST
if (main === null) throw failClosed(/* usage hint */);
const harnessDir = join(main.root, ".mstar"); // fixed; retired selectors refuse
```

## Why This Works (retained ordering)

- The guard-first order makes the safety property unconditional — a probe can never resurrect the second-SDD-tree hazard, regardless of stray files in feature checkouts.
- The override this record introduced is retired (2026-11-20); the historical bullets above describe the old mechanism, not a supported route.
- Pinning the fail-closed ordering in a test means a future maintainer "fixing" the port back toward probe-first behavior trips the test and re-reads the rationale.

## Prevention

- Any tool that resolves `{HARNESS_DIR}` must derive it from Git and refuse the retired selectors; no config or environment override is accepted.
- Linked-worktree guards must run before any resolution — never probe-first in a worktree context.
- When a port intentionally hardens behavior vs its shell original, add a dedicated test + comment; do not leave silent divergences.
- The control-path SSOT invariant this bug protects is restated in `mstar-branch-worktree` 「Harness path SSOT under default gitignore」; the old `{HARNESS_DIR}/docs/` ADR tree no longer exists.
