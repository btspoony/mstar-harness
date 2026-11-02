---
packages: engine
---

- **The sync watermark is split into copied and target.** Store migration 16 adds `pending_target` to
  `issue_sync_state`, because one column was carrying two meanings that disagree whenever a cycle is open: the revision
  whose fields were actually COPIED (what makes an import incremental) and the revision a re-plan cycle is TARGETING
  (what makes a replayed old page stale). `replanItem`/`planItem` now write only the target; `markApplied` promotes it
  to the copied watermark in the same commit as the fields and clears it.
- **A stale replayed page no longer closes the cycle.** Closing it recorded the target as copied, so when that
  revision finally arrived it read as zero-delta and the row kept stale content indefinitely. A page older than the
  open cycle is now skipped with the cycle left open, and the target revision is mirrored exactly once when it lands.
  The backup inventory carries the new column.

<!-- CN -->
- **同步水位拆成"已复制"与"目标"两列。** store 迁移 16 给 `issue_sync_state` 增加 `pending_target`：此前一列同时承担两种
  含义，而它们在循环打开时必定冲突——「字段实际已复制的版本」（增量导入的依据）与「重规划循环的目标版本」（判定重放旧页是否
  过期的依据）。现在 `replanItem`/`planItem` 只写目标；`markApplied` 在写入字段的同一提交里把目标提升为已复制水位并清空。
- **重放的陈旧页不再关闭循环。** 此前关闭会把目标当作已复制记录，等到该版本真正到来时会被读成零增量，行内容永远停留在旧版。
  现在早于打开中循环的页只跳过、循环保持打开，目标版本真正到达时恰好镜像一次。备份清单已包含新列。
