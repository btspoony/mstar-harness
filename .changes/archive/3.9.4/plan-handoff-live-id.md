---
category: Harness
packages: root
---

- The `mstar plan` row verbs now act on the row's **live** handoff: `--handoff <id>` is validated against the handoff the engine reports (a *different* live id is refused as `coordination.handoff-mismatch`, exit `1`, nothing written) and `plan show --json` reports `handoff_id` alongside the row's `state` / `attempt`, so a recovery step can read the id after a crashed caller lost it.

<!-- CN -->
- `mstar plan` 的行级动词现在作用于该行的**实时**交接：`--handoff <id>` 会与引擎报告的交接 id 校对（传入*不同的*实时 id 时以 `coordination.handoff-mismatch` 拒绝，退出码 `1`，不写入任何内容），且 `plan show --json` 会连同行的 `state` / `attempt` 一起报告 `handoff_id`，因此崩溃的调用方丢失 id 后仍可在恢复步骤中读到它。
