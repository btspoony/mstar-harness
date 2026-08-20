---
category: Harness
packages: root, dsh
---
- **CI runs dsh test + typecheck again**: the link-farm era `dsh:link` call and the source-tree availability gate (`DSH_SOURCE_DIR` / `~/.dsh/source/current`) are gone — the rc.8 seam packages resolve from the public npm registry, so the dsh suite runs unconditionally in CI. The install e2e specs keep their self-skip when no `dsh` bin is on PATH. Test fixtures updated for the v3.0.0 `MstarHarnessState.project` field (5 sites across 4 specs), which had left `typecheck:tests` red on main.

<!-- CN -->
- **CI 重新运行 dsh 测试与 typecheck**：删除 link-farm 时代的 `dsh:link` 调用与 dsh 源码树可用性 gate（`DSH_SOURCE_DIR` / `~/.dsh/source/current`）——rc.8 的 seam 包改从公共 npm registry 解析，dsh 套件在 CI 无条件执行；install e2e 在 PATH 无 `dsh` bin 时仍自行跳过。测试 fixture 补齐 v3.0.0 新增的 `MstarHarnessState.project` 字段（4 个 spec 共 5 处），修复 main 上 `typecheck:tests` 的既有红态。
