---
packages: root, engine, cli
---

- Added the **Phase 6 post-merge close engine gate** (`evaluatePostMergeClose`): a pure, additive local-state check over the terminal snapshot shape, leftover leases and root-status unregister, with stable `PHASE6_*` codes; `mstar iteration gate --phase 6 --workflow <id>` evaluates it without `--compass`.
- The Phase 6 gate now validates the root `status.json` with the full v2 root validator (`validateStatusV2`, structure-only): a malformed registry (non-v2 version, missing `updated_at`, malformed `workflows[]` entries) fails closed as `PHASE6_INVALID_ROOT` instead of false-PASSing when the workflow id is absent; `/iteration-start` and the README commands table now state the auto-continue completion at Phase 6 post-merge close (same Done definition as `/iteration-drive`).

<!-- CN -->
- 新增 **Phase 6 post-merge close 引擎门禁**（`evaluatePostMergeClose`）：纯函数、增量式校验本地终态（快照终态合法性、悬挂 lease、根 `status.json` 已注销），稳定码 `PHASE6_*`；`mstar iteration gate --phase 6 --workflow <id>` 无需 `--compass` 即可评估。
- Phase 6 门禁现在以完整 v2 根校验器（`validateStatusV2`，仅结构）校验根 `status.json`：畸形 registry（非 v2 版本、缺 `updated_at`、畸形 `workflows[]` 条目）一律 fail-closed 报 `PHASE6_INVALID_ROOT`，不再因 workflow id 缺席而误判 PASS；`/iteration-start` 与 README 命令表的自动推进完成定义对齐到 Phase 6 post-merge close（与 `/iteration-drive` 同一 Done 定义）。
