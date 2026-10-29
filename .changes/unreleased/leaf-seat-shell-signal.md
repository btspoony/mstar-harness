---
category: Harness
packages: root,cli,dsh,omp
---

- **Leaf-seat shell signal (#548):** a leaf/subagent session now carries its seat into the shell transport, closing the "leaf launches the CLI under the parent's ambient identity" gap for leafs that use their shell normally. The dsh plugin registers a `shellEnv` contributor exporting `DSH_MSTAR_LEAF_SEAT=1` on leaf executions (the shared `isLeafSeatHeader` predicate — one leaf rule), omp prefixes `export MSTAR_LEAF_SEAT=1;` onto a task session's bash calls, and the CLI reads either marker and attests `leafSeat: true` on every coordinator §3.1 identity it hands the engine, so the engine's `coordination.leaf-seat` refusal fires on the CLI transport. Boundary: the marker is an environment channel — a leaf that deliberately strips it (`env -u`) before invoking the CLI is still indistinguishable, and non-`1` values are ignored, never a leaf claim.

<!-- CN -->
- **Leaf-seat shell 信号（#548）：** leaf/subagent 会话现在能把自身 seat 带进 shell 传输层，弥补"leaf 以父级 ambient identity 启动 CLI"的缺口（对正常使用 shell 的 leaf 生效）。dsh 插件注册 `shellEnv` 贡献者，在 leaf 执行上导出 `DSH_MSTAR_LEAF_SEAT=1`（复用共享的 `isLeafSeatHeader` 判定——leaf 规则只有一份）；omp 在 task 会话的 bash 命令前加 `export MSTAR_LEAF_SEAT=1;`；CLI 读取任一标记，并在其交给引擎的每份协调者 §3.1 身份上声明 `leafSeat: true`，使引擎的 `coordination.leaf-seat` 拒绝在 CLI 传输层生效。边界：这是环境变量通道——leaf 若在调用 CLI 前主动去除标记（`env -u`）仍不可区分；非 `1` 的值一律忽略，不构成 leaf 声明。
