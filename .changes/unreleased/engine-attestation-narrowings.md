---
category: Harness
packages: root,engine
---

- **Settled retired claims record the authorization they were settled under.** A schema cutover that settles several retired plan-PM holders keeps ONE document-level `authorizationRef` (`retired-plan-pm-seat:` plus the sorted unique holders) and every tombstone copies it verbatim into `release_reason`, while `prior_holder` keeps the holder's identity — so each tombstone still matches the document that authorized it.
- **One stop row per settled holder.** A holder that left more than one integration claim is attested once: the settlement emits one stop row per holder in sorted order instead of one per claim.
- **The activation operator is required before the recovery point.** An activation that generates its own operator document now refuses a missing `--operator` before the backup is written, so a refused activation never leaves an orphan recovery point behind. The refusal keeps its code, message and recovery.
- **One transaction clock stamps the generated documents.** `store upgrade`, `store init` and `store activate` accept an optional clock; the settling transaction reads it once, the generated document attests that instant, and every claim window and activation stamp is measured against the same one.
- **The `processFacts` seam is a recorded limit, not installed-consumer evidence.** It stays an optional direct-engine/test provisioning input that production CLI callers omit; the limit is documented at `ProvisionProcessFacts` and referenced from the activation barrier, with no second injection seam.

<!-- CN -->
- **被处置的退役租约记录其授权依据。** 一次模式切换若同时处置多个退役 plan-PM holder，只保留一个文档级 `authorizationRef`（`retired-plan-pm-seat:` 加排序去重后的 holder），每个墓志铭原样复制到 `release_reason`，holder 身份仍保留在 `prior_holder`——因此每个墓志铭都与授权它的文档一致。
- **每个被处置 holder 只产生一条 stop 行。** 同一 holder 遗留多个集成租约时只认证一次：处置过程按排序后的 holder 逐条生成 stop 行，而不是按租约逐条生成。
- **激活 operator 在恢复点之前校验。** 自动生成 operator 文档的激活在写入备份之前就拒绝缺少 `--operator`，被拒绝的激活不会留下孤立恢复点。拒绝码、消息与恢复方式保持不变。
- **生成的文档使用同一个事务时钟。** `store upgrade`、`store init` 与 `store activate` 接受可选时钟；处置事务只读取一次，生成的文档记录该时刻，租约时间窗口与激活时间戳都以同一时刻衡量。
- **`processFacts` 接缝是已记录的限界，而非已安装消费方证据。** 它仍是可选的直连引擎/测试注入输入，生产 CLI 调用方不传；该限界记录在 `ProvisionProcessFacts` 并由激活屏障引用，不新增第二个注入接缝。
