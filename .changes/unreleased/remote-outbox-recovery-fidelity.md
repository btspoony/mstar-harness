---
category: Fixed
packages: root
---

- **A pre-v3 remote cache is replaced only after its successor is verified.** `store collaboration remote bind`
  stages and admits the replacement first, then preserves the previous bytes under the same identity or refuses
  with the checkout's recorded generation untouched; a cache the checkout never recorded and a competing bind that
  publishes inside the release window are both left intact.
- **A confirmed repair finalizes only the work it actually proves.** A reviewed replacement that settles a fork but
  omits the requested outcome no longer registers a workflow or a binding; the receipt discloses the settled effect
  and the supported correction instead.
- **Abandonment, decline and partial outcomes name what is left to do.** An abandoned repair keeps the original
  conflict addressable, a confirmed component is preserved in a partial receipt, and a deterministic refusal before
  anything is frozen declines the plan rather than locking it.
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
- **pre-v3 远程缓存只有在后继缓存通过验证后才被替换。** `store collaboration remote bind` 先暂存并准入后继缓存，
  再在同一身份下保留旧字节，否则以「未改动」拒绝：检出从未记录的缓存、以及在本尝试释放窗口内抢先发布的其他 bind，
  都保持原样。
- **已确认的修复只落定它真正证明的工作。** 经审查的替换若解决了分叉却缺少所请求的成果，不再登记 workflow 或绑定，
  而是在 receipt 中披露实际落定的效果与受支持的修正路径。
- **放弃、拒收与部分成果都说明剩余步骤。** 被放弃的修复保留原本可寻址的冲突，部分场景保留已确认的组件，
  而任何冻结前的确定性拒绝只让计划 decline，不再把它锁死。
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
