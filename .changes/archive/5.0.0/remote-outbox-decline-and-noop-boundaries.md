---
category: Fixed
packages: root
---

- **A sampled refusal can no longer decline a reservation whose intent the winner froze.** Before the frame records a
  deterministic decline, it re-reads the composite's remote outbox rows under the freeze's own write lane
  (`remoteIds` on every remote composite: residual-add entries, residual-close and execution-register). A durable
  intent found there — or a lane that cannot be read, which proves nothing either way — keeps the reservation prepared,
  and the same-id replay settles from the winner's confirmed intent; a bounded regression freezes, dispatches and
  confirms the winner inside the loser's replay-admission gap and proves the refuse-then-resume journey end to end.
- **An established no-op answer is replay-first and observation-proven, like an insert.** At the decision boundary —
  inside the remote-cache write lane, the lock every freeze takes — the answer re-checks the outbox row under the
  operation id and the sampled observation revision: a different-payload capture that froze the same id in the overlap
  refuses as a collision instead of reporting a false established success, and a superseded sample refuses
  `collaboration.observation-stale`. A bounded no-op/operation-id overlap regression observes the refusal and the
  intact winner row.
- **One structural owner for the strict remote documents.** The published observe/receipt/reconcile/adoption/resolve/
  dispatch/bind descriptors move into the engine (`remote-documents`), built from the same vocabularies the runtime
  parsers enforce; the command package only re-exports them, so discovery can never drift from the document the
  runtime accepts. The engine's subject parsers (fields and every history row) now collect their defects in collector
  mode, so one receipt refusal names two bad subject fields and a malformed history row together — through the
  published descriptor and the runtime alike — before any outbox access; `remote.unsafe-fidelity` stays its own
  refusal class and is never flattened into the structural aggregate.

<!-- CN -->
- **采样拒绝不再 decline 一个赢家已冻结 intent 的预留。** 在 frame 记录确定性 decline 之前，它会在 freeze 自己的
  写车道（每个 remote composite 的 `remoteIds`：residual-add 条目、residual-close 与 execution-register）下重读
  composite 的 remote outbox 行；车道上发现的 durable intent——或一条无法读取、对任何一方都不构成证明的车道——
  保持预留为 prepared，同 id replay 从赢家的 confirmed intent 结算。一个有界回归在输家的 replay 准入间隙内
  freeze、dispatch 并确认赢家，端到端证明 refuse-then-resume 旅程。
- **established no-op answer 与 insert 一样 replay 优先、以 observation 证明。** 在决策边界——remote-cache 写车道，
  每个 freeze 都持有的锁——answer 按 operation id 与采样的 observation revision 重查 outbox 行：重叠期内冻结同一 id
  的不同 payload 捕获作为冲突拒绝，而不是报告虚假的 established 成功；被取代的样本拒绝
  `collaboration.observation-stale`。一个有界 no-op/operation-id 重叠回归观察该拒绝与完好的赢家行。
- **严格的 remote 文档有了唯一结构属主。** 已发布的 observe/receipt/reconcile/adoption/resolve/dispatch/bind
  描述符移入 engine（`remote-documents`），由 runtime 解析器强制的同一套词汇构建；command 包只 re-export，
  discovery 不会偏离 runtime 接受的文档。engine 的 subject 解析器（字段与每条 history 行）改为以 collector 模式
  收集缺陷，一条 receipt 拒绝同时点名两个坏 subject 字段与一条畸形 history 行——已发布描述符与 runtime 皆然——
  且发生在任何 outbox 访问之前；`remote.unsafe-fidelity` 保持自己的拒绝类，不会被压平进结构聚合。
