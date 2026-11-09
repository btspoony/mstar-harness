---
module: @mstar-harness/engine
date: 2026-08-10
last_updated: 2026-11-09
problem_type: architecture_pattern
category: architecture-patterns
severity: high
plan_id: "20260810-harness-root-boundary, 20260810-dsh-entry-split, 20260810-dsh-concurrency-wording"
tags: [harness-dir, workspace-root, probe, resolve-harness-dir]
---

# resolveHarnessDir workspace-root boundary (roadmap §7c)

## Context

`resolveHarnessDir`'s walk-up probe had no stop boundary at the workspace root: it climbed past the workspace into `$HOME`, where the CLI installer created a global `~/.mstar` — any project under `~/...` without its own harness dir adopted `~/.mstar` as `{HARNESS_DIR}` (defect observed 2026-08-10, roadmap §7c). Fixed in iter-20260809-harness-root-fix.

## Guidance

- **Stop boundary is caller-passed**: engine `resolveHarnessDir(startDir, opts)` gains optional `opts.workspaceRoot` — the probe checks `.mstar/` → `.agents/` → `.plans/`/`plans/` only at-or-below the boundary; a harness dir above it is never returned. Boundary per caller: **CLI/engine default** = git top-level of `startDir` (via `git rev-parse --show-cdup` relative output walked lexically — avoids macOS `/var`→`/private/var` symlink mismatch; non-git start probes only itself — intentional tightening); **dsh** = the session workspace (`HarnessResolver.forWorkspace` passes `workspaceRoot = cwd`; empty cwd → null, never a `process.cwd()` fallback).
- **Explicit overrides keep authority**: `opts.harnessDir` / `MSTAR_HARNESS_DIR` / dsh `config.harnessDir` short-circuit BEFORE the boundary check — an override outside the boundary still wins.
- **dsh vs CLI boundaries intentionally diverge**: dsh = session workspace (probe start = boundary); CLI = git top-level. A project subdir opened as the dsh workspace degrades to null for the project-root harness — documented tradeoff (workspace UX, may be enhanced later via "walk up to nearest harness within git top-level").
- **Residual corner**: if the git top-level (or dsh session cwd) ITSELF is under `~/.mstar`'s ancestor (e.g. home is a git repo), the collision persists — the real fix is the tracked hygiene follow-up: relocate the CLI global install root off `~/.mstar`.
- **Version alignment**: dsh IS a `VERSION_SURFACES` entry (`scripts/release-surfaces.ts`, `packages/dsh/package.json`) and `release:validate` fails on any drift, so the historical "not in the release gate, manual sync" caveat no longer applies.

## Why This Matters

A project adopting `~/.mstar` silently gates/dispatches against the wrong harness — the worst kind of failure (correct-looking, wrong root). The boundary makes harness resolution deterministic per workspace.

## When to Apply

Any change to harness-root discovery (engine/CLI/dsh/other hosts); any new probe consumer must pass an explicit boundary. Regression surfaces: engine `path.test.ts`, cli `path-resolve.test.ts`, dsh `workspace-resolution.spec.ts` (fixtures all-temp, never touch the real `~/.mstar`).

## Examples

- Engine: probe from a workspace whose parent chain contains a `~/.mstar`-like fixture → `null`; override outside the boundary still resolves.
- dsh: session workspace parent has `.mstar` → the probe stops at the session workspace (null or workspace-local harness only).
