---
category: Fixed
packages: root
---

- **The settled-effect correction is now runnable as printed.** The changed-field refusal of a remote registration names
  the journal's own `--project` on its `mstar catalog update` route (a remote catalog write refuses without it), and the
  structured refusal carries that same ordered route as `recovery` plus the durable `confirmed_components`, so a replayed
  decline never reports an effect-free operation. A command-surface regression proves the flag is both required and
  accepted.
- **The empty outbox probe and the durable decline share one lane.** The composite decline checks for the same-id durable
  intent INSIDE the remote-cache write lane and commits the execution decline while holding it, while a composite freeze
  proves the reservation is still `prepared` in that same lane before inserting. A freeze that lands between the sampled
  refusal and the decline therefore retains the reservation, and a decline that wins refuses an already-admitted
  attempt's freeze instead of leaving a durable intent it can never finalize. Two bounded overlaps cover both orderings.
- **One malformed history entry no longer truncates a receipt refusal.** Every subject-history row is its own collection
  boundary in the runtime parser (and the project journal's rows too), so a null entry and a later entry with a bad field
  are named together with the subject's own field defects; the engine-owned descriptors already report per entry, and
  both paths are asserted on one receipt before any outbox access.

<!-- CN -->
- **settled-effect 修正现在可按印刷原文直接执行。** 远程 registration 的 changed-field 拒绝在其 `mstar catalog update`
  路由上点名 journal 自己的 `--project`（远程 catalog 写入缺它会拒绝），结构化拒绝携带同一条有序路由作为
  `recovery`，外加 durable 的 `confirmed_components`，因此 replay 出的 decline 不会报告一个无效果的 operation。
  命令表面回归证明该 flag 既必需也被接受。
- **空的 outbox 探测与 durable decline 共享一条车道。** composite decline 在 remote-cache 写车道内检查同 id durable
  intent 并在持锁时提交 execution decline；composite freeze 在插入前于同一条车道证明预留仍为 `prepared`。落在
  采样拒绝与 decline 之间的 freeze 因此保留预留，而赢得竞争的 decline 拒绝一个已获准 attempt 的 freeze，而不是
  留下一个永远无法 finalize 的 durable intent。两个有界重叠覆盖两种顺序。
- **一条畸形 history 条目不再截断 receipt 拒绝。** 运行时解析器中每条 subject-history 行都是自己的收集边界
  （project journal 的行同样如此），null 条目与更靠后的坏字段条目会同 subject 自身的字段缺陷一起被点名；
  engine 拥有的描述符本就按条目报告，两条路径在同一条 receipt 上、任何 outbox 访问之前得到断言。
