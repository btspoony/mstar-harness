---
module: @mstar-harness/engine
date: 2026-08-10
last_updated: 2026-11-20
problem_type: architecture_pattern
category: architecture-patterns
severity: high
plan_id: "<plan-id>, <plan-id>, <plan-id>"
tags: [harness-dir, workspace-root, probe, resolve-harness-dir]
---

# resolveHarnessDir workspace-root boundary (roadmap §7c)

## Context

`resolveHarnessDir`'s walk-up probe had no stop boundary at the workspace root: it climbed past the workspace into `$HOME`, where the CLI installer created a global `~/.mstar` — any project under `~/...` without its own harness dir adopted `~/.mstar` as `{HARNESS_DIR}` (defect observed 2026-08-10, roadmap §7c). Fixed in iter-<plan-id>.

## Guidance

- **Stop boundary now scopes only the local probe**: the fixed root comes from Git; `opts.workspaceRoot` still bounds `localProbe` diagnostics and the dsh session workspace, but it cannot move the process root.
- **Explicit overrides are retired**: `MSTAR_HARNESS_DIR` and a `.mstarc` `harness_dir` no longer select a root — they are read and ignored. `opts.harnessDir` survives only as a validated assertion: the value the transport already derived must equal the Git-derived root, and a mismatch is refused. A CLI outside Git names the root with `--harness`. dsh `config.harnessDir` follows the same rule.
- **dsh vs CLI boundaries**: dsh still derives its session workspace, but the harness root it reports is the Git main worktree's `.mstar`; a project subdir opened as the workspace no longer changes the harness answer.
- **Residual corner resolved**: the fixed root never walks above the main worktree, so the historical `~/.mstar` adoption cannot recur.
- **Version alignment**: dsh IS a `VERSION_SURFACES` entry (`scripts/release-surfaces.ts`, `packages/dsh/package.json`) and `release:validate` fails on any drift, so the historical "not in the release gate, manual sync" caveat no longer applies.

## Why This Matters

A project adopting `~/.mstar` silently gates/dispatches against the wrong harness — the worst kind of failure (correct-looking, wrong root). The boundary makes harness resolution deterministic per workspace.

## When to Apply

Any change to harness-root discovery (engine/CLI/dsh/other hosts); any new probe consumer must pass an explicit boundary. Regression surfaces: engine `path.test.ts`, cli `path-resolve.test.ts`, dsh `workspace-resolution.spec.ts` (fixtures all-temp, never touch the real `~/.mstar`).

## Examples

- Engine: probe from a workspace whose parent chain contains a `~/.mstar`-like fixture → `null`; an explicit selector that disagrees with the Git-derived root is refused, while a retired config value is ignored — the fixed root is Git-derived.
- dsh: session workspace parent has `.mstar` → the probe stops at the session workspace (null or workspace-local harness only).
