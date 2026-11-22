---
category: Fixed
packages: root
---

- **A same-ID overlap can no longer release the winning reservation.** A `remote.operation-conflict` that READ a durable
  outbox row proves the failure happened AFTER a freeze, so the losing identical attempt reports a partial and retains
  the shared reservation instead of declining it; the winner's frozen intent settles by the same-id replay, which a
  bounded same-ID overlap regression observes end to end (one frozen intent, one resumable reservation).
- **Remote capture decides against the observation it freezes.** The write's sampled observation revision is re-proved
  inside the freeze transaction, so a scope that moves after the last sample refuses
  `collaboration.observation-stale` instead of freezing decisions about a superseded base; the occurrence-key dedupe is
  project-wide (another subject's key answers the established receipt, a conflict, or an identity refusal — never a
  second append), and the established no-op answer sits inside the replay boundary. A confirmed append receipt names
  the eventId of the occurrence actually in the confirmed event.
- **Closures enforce their gates on the freeze revision.** An ordinary closure and a plan-scoped residual-close re-prove
  the sampled base inside the freeze transaction and keep the reservation when the scope moved; a terminal refusal's
  inspect command is valid for the addressed alias (a provider UUID names its `--project`), and reopening a terminal
  issue is stated as a deliberate change with its required inputs, never a default next step.
- **One structural contract drives the observe documents and the engine's recursive refusals.** The published
  `portableSubject` accepts the `fields` member the engine requires, so a marked observation the runtime accepts is no
  longer refused by discovery; the engine's identity, event and observed-records parsers collect unknown keys and every
  nested defect into ONE refusal before any outbox access, while authority, freshness and exact-event checks stay the
  engine's own.
- **Cache-recovery and roadmap evidence no longer assume a three-migration layout or an empty template.** The
  destination ledger assertion reads the whole migration registry, and the undated roadmap round-trip authors a
  Direction and proves its semantic survival, the absent `created_at`, and the re-export's own success status.

<!-- CN -->
- **同 ID 重叠不再释放赢家的预留。** 读取到 durable outbox 行的 `remote.operation-conflict` 证明失败发生在 freeze
  之后，因此落败的相同 attempt 报告 partial 并保留共享预留而不是 decline 它；赢家的冻结 intent 通过同 id replay
  结算，一个有界同 ID 重叠回归端到端观察全程（一个冻结 intent、一个可恢复预留）。
- **remote capture 针对它所冻结的 observation 做决策。** 写入采样的 observation revision 在 freeze 事务内重新证明，
  因此最后一个样本之后移动的 scope 拒绝 `collaboration.observation-stale`，而不是基于被取代的基础冻结决策；
  occurrence-key 去重是 project 级的（另一个 subject 的 key 以 established receipt、冲突或身份拒绝回答——绝不是
  第二次 append），established no-op answer 位于 replay 边界内。确认的 append receipt 点名确认事件中实际存在的
  occurrence 的 eventId。
- **closure 在 freeze revision 上执行自己的门禁。** 普通 closure 与 plan 作用域的 residual-close 在 freeze 事务内
  重新证明采样的基础并在 scope 移动时保留预留；terminal 拒绝的 inspect 命令对被寻址的 alias 有效（provider UUID
  点名它的 `--project`），重新打开 terminal issue 被表述为需要所需输入的有意变更，绝不是默认的下一步。
- **一个结构契约同时驱动 observe 文档与 engine 的递归拒绝。** 已发布的 `portableSubject` 接受 engine 要求的
  `fields` 成员，runtime 接受的标记 observation 不再被 discovery 拒绝；engine 的 identity、event 与
  observed-records 解析器在任何 outbox 访问之前把未知键与每个嵌套缺陷收集进 ONE 条拒绝，而 authority、freshness
  与 exact-event 检查仍是 engine 自己的。
- **cache 恢复与 roadmap 证据不再假设三次 migration 布局或空模板。** 目标 ledger 断言读取整个 migration registry，
  undated roadmap round-trip 撰写一个 Direction 并证明其语义存活、`created_at` 缺失，以及 re-export 自身的成功
  状态。
