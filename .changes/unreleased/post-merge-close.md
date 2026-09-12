---
packages: root, engine, cli
---

- Added the **Phase 6 post-merge close engine gate** (`evaluatePostMergeClose`): a pure, additive local-state check over the terminal snapshot shape, leftover leases and root-status unregister, with stable `PHASE6_*` codes; `mstar iteration gate --phase 6 --workflow <id>` evaluates it without `--compass`.

<!-- CN -->
- 新增 **Phase 6 post-merge close 引擎门禁**（`evaluatePostMergeClose`）：纯函数、增量式校验本地终态（快照终态合法性、悬挂 lease、根 `status.json` 已注销），稳定码 `PHASE6_*`；`mstar iteration gate --phase 6 --workflow <id>` 无需 `--compass` 即可评估。
