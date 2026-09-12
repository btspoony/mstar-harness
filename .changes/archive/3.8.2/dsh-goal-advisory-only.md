---
packages: dsh
---

- **dsh plugin**: the goal bridge is now **advisory-only** — mstar writes **zero goal state** (no `create`, `edit`, `complete`, `pause` or `resume`), so the plugin can no longer re-arm a goal an operator paused: a human `/goal pause` stays paused across mstar's own dispatch and session edges (the mirrored-iteration-objective writer, its drift rebuild and its registration edges are removed, not gated).
- **dsh plugin**: the retained bridge is ONE `session/event` listener that reports a **blocked goal** — one `mstar/goal-bridge` warn per qualifying envelope, carrying the `blockedReason.code`, a bounded objective summary and the project-register residual pointer — and it reads envelope/workspace attribution only, calling neither the goals service nor any harness write.
- **dsh plugin**: `Config.maxGoalRounds` is removed from the plugin schema — its only consumer was the removed mirror writer. A legacy raw key stays an inert unknown option, never an arming path, and the plugin adds no compatibility parser and no flag that re-enables the removed behavior.
- **dsh plugin**: the shared steering helpers (`isRootLikeAgent`, `rootAgentOf`, `steeringCompass`) now live in `gates/steering.ts`, consumed by the planMode bridge; the advisory imports none of them.

<!-- CN -->
- **dsh 插件**：goal bridge 现为**纯 advisory**——mstar 对 goal 状态**零写入**（不做 `create` / `edit` / `complete` / `pause` / `resume`），插件不再能重新 arm 已被人工暂停的 goal：人类的 `/goal pause` 在 mstar 自身的派发与会话边上保持暂停（镜像迭代目标的写入器、其漂移重建与注册边被移除，而非加开关）。
- **dsh 插件**：保留的 bridge 是**单一 `session/event` 监听器**，只报告**被阻塞的 goal**——每条符合条件的信封记一条 `mstar/goal-bridge` warn，含 `blockedReason.code`、有界的目标摘要与项目 register 的 residual 指针；它只读信封与工作区归属，既不调用 goals 服务也不写任何 harness 状态。
- **dsh 插件**：从插件 schema 中移除 `Config.maxGoalRounds`——其唯一消费者正是被移除的镜像写入器。遗留的原始 key 只是惰性未知选项，绝非 arm 路径；插件不新增兼容解析器，也不新增可重新启用被移除行为的开关。
- **dsh 插件**：共享 steering 辅助函数（`isRootLikeAgent`、`rootAgentOf`、`steeringCompass`）迁至 `gates/steering.ts`，由 planMode bridge 消费；advisory 不引用其中任何一个。
