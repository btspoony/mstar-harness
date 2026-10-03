---
category: Harness
packages: root
---

- Registration replay no longer answers over a **terminal lifecycle snapshot**: during the close window (terminal snapshot on disk, root entry still present) a committed registration refuses with `catalog.registration-terminal-lifecycle`; committed reconcile replays apply the same guard. Let an in-flight close finish; if it was interrupted, run `mstar status workflow-close --workflow <workflow-id> --harness '<harness-root>'` to finish unregistering, then retry the registration. Ordinary plan-row progress replays still replay the committed receipt (#323).

<!-- CN -->
- 注册重放不再对**终态生命周期快照**作出"已注册且活跃"的应答：close 窗口内（磁盘快照已终态、root 登记仍在）已提交的注册以 `catalog.registration-terminal-lifecycle` 拒绝；已提交的 reconcile 重放也应用相同守卫。让正在执行的 close 完成；若 close 中断，则运行 `mstar status workflow-close --workflow <workflow-id> --harness '<harness-root>'` 完成注销后重试注册。普通 plan 行进度重放仍照常返回已提交回执（#323）。
