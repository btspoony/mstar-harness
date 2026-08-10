---
packages: engine, cli
---

- **engine**: `resolveHarnessDir` now stops at the workspace root (roadmap §7c defect fix) — the upward probe keeps walking only while `dir` is at or below `opts.workspaceRoot`, so a harness dir above the workspace (e.g. the global `~/.mstar` CLI-install root) is never returned. The default boundary is the git top-level of the start dir (sync `git rev-parse --show-cdup`; non-git start falls back to the start dir itself — probes only itself, never upward; deliberate tightening). Explicit overrides (`opts.harnessDir` / `MSTAR_HARNESS_DIR`) short-circuit before the boundary and keep their authority.
