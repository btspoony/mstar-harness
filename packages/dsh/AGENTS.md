# dsh 插件开发宗旨（Development Principles）

本目录是 dsh 的 Morning Star 插件包（`@mstar-harness/dsh`）——**不是 dsh 本体**。插件通过 dsh 官方扩展面工作（client plugin bundle：`window.__ModuleLoader__` / closure-factory CJS；catalog 单通道：`state.agentFlow` / `state.*` 是唯一证据源）。

## 硬性约束（HARD — 任何任务都不得违反）

- **绝不补丁修改 dsh 本体（upstream / dsh-private）**：不得 fork、patch、monkey-patch、或在本包内 workaround 去改 dsh 应用自身的源码、构建或运行时行为。
- **不清楚就去查上游源码**：dsh 上游开放性很好——对 dsh 行为、数据契约、扩展面有疑问时，先读上游源码与文档，再回来写插件；禁止猜测或「先 hack 再解释」。
- **零 dsh-private 修改；零引擎修改**（迭代 Global Constraints 同源）：插件只消费 catalog 与官方扩展面。
- 需要 dsh 提供新能力 → 通过上游协作 / 配置 / 扩展面实现，而不是补丁。

## 为什么

插件与本体解耦是可持续集成的根基：dsh 升级时插件 bundle 独立可重建；本体保持干净，插件问题定位收敛在本包内。违反此约束的改动即使功能正确也会被拒绝。
