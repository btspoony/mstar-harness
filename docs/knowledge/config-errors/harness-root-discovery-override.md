---
module: sdd-workspace
date: 2026-08-08
last_updated: 2026-11-09
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

1. **Explicit override wins over probing.** `resolveHarnessDir` (and `sddWorkspace`) accept `opts.harnessDir` / the `MSTAR_HARNESS_DIR` env var, resolved against the start dir; the explicit root is authoritative even when it does not exist yet (caller may scaffold it). Default discovery is the dir-existence fallback (`{HARNESS_DIR}/` → `.agents/`), not a `status.json` probe.
2. **Fail-closed FIRST.** In `sddWorkspace`, the linked-worktree guard runs before the override and the probe: a linked worktree without a control root (CLI 2nd arg / `MSTAR_CONTROL_ROOT`) refuses with a usage message (`Refusing to create a second SDD tree … or: mstar sdd workspace <plan> <control_worktree_path>`). No override or probe may bypass this guard.
3. **Ordering contract (current, verified 2026-11-09):** ① Git-main-worktree discovery / fail-closed guard → ② an explicit `controlRoot` must BE that main worktree (a linked checkout is refused) → ③ explicit harness-root override (`opts.harnessDir` / `MSTAR_HARNESS_DIR`) → ④ `.mstarc` `[config] harness_dir` → ⑤ directory-existence fallback (`.mstar` → `.agents` → `.mstar`). The `status.json` probe is retired (issue #428): a harness dir resolves by location, its authority is the store.
4. **Intentional divergence pinned.** The fail-closed-before-probe behavior intentionally diverges from bash (which probed status.json first); pinned by the test "stray status.json in a linked worktree" and documented in the port (qc2 F-004).

```ts
// sddWorkspace resolution order (paraphrased; packages/engine/src/sdd.ts)
const main = readMainWorktree(cwd);              // 1. fail-closed FIRST
if (main === null) throw failClosed(/* exit 1, usage hint */);
const harnessDir = opts.harnessDir ?? process.env.MSTAR_HARNESS_DIR   // 3. explicit wins
                   ?? findMstarc(root)?.harnessDir                    // 4. repo-declared
                   ?? (isDirectory(join(root, ".mstar")) ? join(root, ".mstar")
                                                        : join(root, ".agents")); // 5. location
```

## Why This Works

- The override breaks the false dichotomy of "probe names or fail": any repo with a documented non-default harness root gets deterministic resolution instead of silently picking the wrong candidate.
- The guard-first order makes the safety property unconditional — the probe can never resurrect the second-SDD-tree hazard, regardless of stray files in feature checkouts.
- Pinning the divergence in a test means a future maintainer "fixing" the port back toward bash behavior trips the test and re-reads the rationale.

## Prevention

- Any tool that resolves `{HARNESS_DIR}` must accept an explicit override and document override precedence over probing.
- Linked-worktree guards must run before any path probe that reads `status.json` — never probe-first in a worktree context.
- When a port intentionally hardens behavior vs its shell original, add a dedicated test + comment; do not leave silent divergences.
- The control-path SSOT invariant this bug protects is restated in `mstar-branch-worktree` 「Harness path SSOT under default gitignore」; the old `{HARNESS_DIR}/docs/` ADR tree no longer exists.
