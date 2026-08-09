---
category: Harness
packages: root
---

- omp plugin: engine-version compatibility — the blocking hook and `mstar_dispatch_validate` no longer statically import `composeDispatchGate`; on engines predating the export the task dispatch gate (Gate 2) is skipped with a one-time warning while the status gate stays active, and the dispatch tool reports an explicit upgrade error instead of silently vanishing (parity with `mstar_iteration_gate`).

<!-- CN -->
- omp 插件：engine 版本兼容 —— 阻断 hook 与 `mstar_dispatch_validate` 不再静态导入 `composeDispatchGate`；在早于该导出的 engine 上，任务派发 gate（Gate 2）跳过并打印一次性警告（状态 gate 保持生效），派发工具返回显式升级错误而非静默消失（与 `mstar_iteration_gate` 对齐）。
