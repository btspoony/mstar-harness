---
category: Harness
packages: root
---

- **dsh host**: mstar progress on dsh is now defined as **native-workflow driving** — the workflow snapshot phases, the dispatch gates, and subagent settle notifications — and the goal bridge is **advisory-only**, so a human `/goal pause` can no longer be overridden by mstar's own dispatch edges. `mstar-host` scopes its host-agnostic `/goal` rule with an explicit dsh exception (other hosts keep the complete-flow objective rule), `mstar-host/references/dsh.md` gains a progress-discipline section (a dispatched child owning the critical path means wait for its settle notification, not another work unit), and PM required reading carries a dsh pointer.
- **dsh host**: shared steering helpers (`isRootLikeAgent`, `rootAgentOf`, `steeringCompass`) moved to `gates/steering.ts` in the dsh plugin — planMode behavior unchanged.

<!-- CN -->
- **dsh 宿主**：mstar 在 dsh 上的推进方式现为**原生 workflow**——workflow 快照相位、派发门禁与 subagent settle 通知；goal bridge 收敛为**纯 advisory**，人类 `/goal pause` 不再会被 mstar 自身的派发边重新 arm。`mstar-host` 的宿主无关 `/goal` 规则加入显式 dsh 例外（其他宿主保留完整流程目标规则），`mstar-host/references/dsh.md` 新增推进纪律小节（子代理占据关键路径时等待其 settle 通知，而非在同一 worktree 上再开工作单元），PM 必读增加 dsh 指引。
- **dsh 宿主**：共享 steering 辅助函数（`isRootLikeAgent`、`rootAgentOf`、`steeringCompass`）迁至 dsh 插件的 `gates/steering.ts`——planMode 行为不变。
