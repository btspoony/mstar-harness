---
category: Fixed
packages: root
---

- **A pre-v3 remote cache is replaced only inside one critical section, by one atomic rename.** `store collaboration
  remote bind` re-proves the lane's ownership and schema where the replacement is published, stages and admits the
  successor, preserves the previous bytes by hard link, then swaps the name without ever unlinking it: a cache the
  checkout never recorded, a lane another binder advanced while the successor was staged, and a v3 outbox row a
  writer froze in it are all left intact, and an interrupted publication leaves the predecessor readable.
- **A confirmed repair finalizes only the work it actually proves.** The finalizer compares the required normalized
  portable fields AND links of the confirmed journal with the reviewed delta, so a settlement that keeps every id but
  changes a title or drops a `belongs-to` link registers no workflow and no binding; the refusal names the operation
  and record the provider actually settled, and re-registering the same workflow under a new operation id adopts the
  rows already published identically instead of tripping their create-only check.
- **Abandonment, decline and partial outcomes name what is left to do.** A live repair is the recovery the composite
  names — dispatched with its fork observation, or reconciled when its send is uncertain — instead of a second
  `outbox-resolve` the live link refuses; a withdrawn repair points at repairing the original fork, which still fences
  every later send. Every entry is scanned: one confirmed component without a readable receipt keeps the reservation
  instead of permitting a mixed, effect-free decline, and re-observation names the supported
  `store collaboration remote observe --harness <abs> --input <file|->` form.
- **Remote capture and closure decide against the observation they freeze.** A dedupe or a plan-scoped closure is
  proved inside the freeze transaction, so a snapshot installed between the read and the write can no longer create
  or append an issue twice, or close one whose canonical target is missing.
- **Remote and outbox `--input` documents are published as typed contracts.** `mstar schema --command <id>` now
  describes the frozen event, its project/issue subject and every history row with closed, typed members, and each
  verb's `--help` names its own registered schema command. A receipt accepts `not-sent`; a reconciliation, which
  reports what a lookup saw, no longer advertises an arm it always rejects.
- **One structural refusal answers the whole document.** A receipt or reconciliation submission reports every unknown
  member, every unreadable field and every nested outcome defect together, and names the published document to
  consult and the corrected `--input` to resubmit.
- **A verified older collaboration image restores by advancing a private copy.** The recovery receipt records the
  digest sampled from that staged copy before the ladder runs, so the source image is never migrated, the retry across
  a publication gap recognises its own generation, and an image from a newer schema names the compatible build or
  another verified pair as its recovery.
- **A roadmap export with no usable `created_at` round-trips.** The field is optional: absent when no stored date can
  fill it, real `YYYY-MM-DD` when present, and the exported document is accepted by `roadmap replace` as written.
- **Recoveries name the command the operator can actually run.** A pre-v3 remote cache points at
  `store collaboration remote bind --harness <abs> --input <file|->` with its verified batch and published document,
  a stale remote write points at `store collaboration remote status` for the observation revision `--expect-store`
  needs, and a remote milestone recovery names the exact stored operation with `--operation`.

<!-- CN -->
- **pre-v3 远程缓存只在一个临界区内、以一个原子 rename 被替换。** `store collaboration remote bind` 在发布处
  重新证明该 lane 的归属与 schema，暂存并准入后继缓存，以硬链接保留旧字节，然后在不 unlink 名称的前提下完成替换：
  检出从未记录的缓存、后继暂存期间被其他 bind 推进的 lane、以及写入者已冻结在其中的 v3 outbox 行都保持原样，
  发布中断时仍留下可读的旧缓存。
- **已确认的修复只落定它真正证明的工作。** finalizer 会同时比较已确认 journal 中必需归一化可移植字段与链接，
  因此保留全部 ID、却改动标题或丢掉 `belongs-to` 链接的结算不再登记 workflow 或绑定；拒绝会指明 provider 实际
  落定的 operation 与 record，而以新 operation id 重新登记同一 workflow 会采纳已一致发布的记录，不再撞上其
  create-only 检查。
- **放弃、拒收与部分成果都说明剩余步骤。** 仍在链路中的修复就是 composite 给出的恢复路径（带 fork observation
  派发，发送不确定时改为 reconcile），而不是再次对被活链拒绝的 `outbox-resolve`；被撤回的修复则指向修复原始分叉，
  该分叉仍然阻断其后的一切发送。所有条目都会被扫描：任一已确认组件缺少可读 receipt 时保留预约，绝不允许
  混入的无效果 decline；重新观测时会给出受支持的 `store collaboration remote observe --harness <abs> --input <file|->`
  形式。
- **远程捕获与关闭都以实际冻结的观测为准。** 去重与计划内的关闭在冻结事务内证明，因此在读取与写入之间安装的快照
  既不能重复创建或追加 issue，也不能关闭一个规范目标缺失的 issue。
- **远程与 outbox 的 `--input` 文档以强类型契约发布。** `mstar schema --command <id>` 现完整描述冻结事件、
  其 project/issue subject 与每一行历史记录（封闭且有类型），每个动词的 `--help` 都会给出自己注册的 schema 命令。
  receipt 接受 `not-sent`；reconciliation 只报告查询所见，不再宣称一个它始终拒绝的分支。
- **一次结构性拒绝回答整份文档。** receipt 或 reconciliation 提交会同时列出所有未知成员、不可读字段与嵌套 outcome
  缺陷，并指明应查阅的已发布文档与需要重新提交的修正 `--input`。
- **经验证的旧版协作镜像通过推进私有副本恢复。** 恢复 receipt 记录的是该暂存副本在迁移前采样的摘要，
  因此源镜像永不被就地迁移，跨越发布缺口的重试能识别自己的代，来自更新 schema 的镜像会指出兼容的构建或另一份
  经验证的镜像对。
- **没有可用 `created_at` 的 roadmap 导出可往返。** 该字段可选：无可填充的存储日期时省略，存在时必须是真实
  `YYYY-MM-DD`，且导出的文档可原样被 `roadmap replace` 接受。
- **恢复路径给出操作者真正能运行的命令。** pre-v3 远程缓存指向
  `store collaboration remote bind --harness <abs> --input <file|->` 及其验证批次与已发布文档；过期的远程写入指向
  `store collaboration remote status` 以取得 `--expect-store` 所需的观测修订；远程 milestone 恢复会带上
  `--operation` 指明确切的已存操作。
