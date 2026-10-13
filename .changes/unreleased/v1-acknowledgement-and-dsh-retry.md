---
category: Harness
packages: engine, commands
---

- **A duplicated v1 plan id is a refused, skippable source instead of a whole-conversion abort.** `convertLegacyV1Tree` orders the competing `plans[]` rows by plan id, then by the owning lifecycle id (the iteration compass registering that id; empty when unregistered), then by row ordinal; the first row survives and every later duplicate is reported. `store upgrade` refuses naming that plan id, and `--ack-skip-workflow <id>` acknowledges losing exactly the duplicate rows: the surviving row and every other source still import, and the receipt reports each skipped duplicate with its `plans[]` ordinal and with the status, progress and notes that stay only in the legacy `status.json`. `docs/commands.md` carries the ordering rule beside the acknowledgement prose.
- **The Dsh retry recovery names the delivery declarations it needs.** When a refused legacy Dsh phase runs after the execution import already committed, the refusal and the command's structured recovery name every acknowledgement the retry needs — the `--ack-skip-dsh` selectors, `--ack-skip-workflow <id...>` for the committed ids (native collisions on the next invocation) and, for a v1 root, the exact `--delivery <json>` declaration(s) that invocation used — so the advertised retry is reachable in one invocation instead of refusing in declaration application first.

<!-- CN -->
- **重复的 v1 plan id 现在是可跳过的被拒源，而不再中断整个转换。** `convertLegacyV1Tree` 按 plan id、拥有该 id 的生命周期 id（注册它的 iteration compass，未注册则为空）、行序号对竞争行排序；第一行保留，后续重复行全部上报。`store upgrade` 会点名该 plan id 拒绝，`--ack-skip-workflow <id>` 即确认仅丢失这些重复行：保留行与其他所有源照常导入，回执按 `plans[]` 序号逐条报告每个被跳过的重复行，以及只留在旧 `status.json` 中的状态、进度与备注。`docs/commands.md` 在既有确认说明旁记录该排序规则。
- **Dsh 重试恢复文本会点名所需的 delivery 声明。** 当 legacy Dsh 阶段在执行导入已提交之后才拒绝时，拒绝文本与该命令的结构化恢复字段会列出重试所需的全部确认项——`--ack-skip-dsh` 选择器、本次调用已提交 id 对应的 `--ack-skip-workflow <id...>`（下次调用会视其为原生冲突），以及 v1 root 情况下本次调用所用的确切 `--delivery <json>` 声明——使所宣告的重试一次调用即可到达，而不会先卡在声明应用阶段。
