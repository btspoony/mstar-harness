---
category: Harness
packages: root
---

- Registration replay no longer answers over a **terminal lifecycle snapshot**: during the close window (terminal snapshot on disk, root entry still present) a committed registration now refuses with `catalog.registration-terminal-lifecycle` naming the cause and the operator recovery, while ordinary plan-row progress replays still replay the committed receipt (#323).

<!-- CN -->
- 注册重放不再对**终态生命周期快照**作出"已注册且活跃"的应答：close 窗口内（磁盘快照已终态、root 登记仍在）已提交的注册现在以 `catalog.registration-terminal-lifecycle` 拒绝并指名原因与操作者恢复路径；普通 plan 行进度重放仍照常返回已提交回执（#323）。
