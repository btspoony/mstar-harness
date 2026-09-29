---
category: Harness
packages: root
---

- **`@mstar-harness/judgment`**: add shard-scoped author pre-dispatch gate (`author-gate.ts`, `author-sink.ts`, `scripts/author-gate.ts`) reusing the shadow supervisor Docker launcher pattern — provisions tool-less author inputs, runs deny probes for forbidden qualification paths, validates create-only sink scoping, and records supervisor access transcripts before Q2 shard dispatch.
- **`@mstar-harness/judgment`**: add seat-scoped annotation pre-dispatch gate (`annotation-seat-gate.ts`, `annotation-sink.ts`, `scripts/annotation-seat-gate.ts`) reusing the author gate Docker probe launcher — provisions tool-less seat inputs (brief + projected shard view), deny-probes forbidden qualification paths (other seat, crosswalk, gold, sources, authoring, protocol artifacts, tuner, model output), validates create-only annotation sink scoping, and records supervisor access transcripts outside seat reach.
- **Judgment runtime:** observing `jev_mode=off` during input collection now aborts active file and stdin reads, prevents further collection, and discards late read results.
- **Judgment**: Reject TypeSafe responses whose reported model does not match the requested native model.
- **Fixed calibration shadow staging** so citation files, inventory identifiers, and confined readonly runtime assets match the supervisor's contracts.
- Made the annotation projection test use a generated local fixture instead of maintainer-specific qualification evidence.
- **Fixed shadow receipt reconciliation** so required receipts are enforced while frozen-inventory omissions remain visible as incomplete work, without rejecting valid cancellation dispositions or treating zero-work runs as incomplete.
- Documented an **optional, finite A05 shadow step** in PR-review synthesis, preserving original vet, deduplication, rejected-candidate record, tally and posting authority when evaluation is off or unavailable.
- Added account-free component exercise guidance and an explicit synthetic-only evidence boundary; component receipts grant no Jev work credit and never count as named-host/W5 verification.
- Fixed strict TypeScript errors in the judgment package and aligned its declaration root with its engine import.

<!-- CN -->
- **`@mstar-harness/judgment`**：新增分片级作者派发前隔离门（`author-gate.ts`、`author-sink.ts`、`scripts/author-gate.ts`），复用 shadow supervisor Docker 启动边界——在 Q2 分片派发前配置无工具作者输入、执行禁止路径拒绝探测、校验仅创建输出 sink，并记录监督方访问 transcript。
- **`@mstar-harness/judgment`**：新增座位级标注派发前隔离门（`annotation-seat-gate.ts`、`annotation-sink.ts`、`scripts/annotation-seat-gate.ts`），复用作者门 Docker 探测启动器——配置无工具座位输入（brief + 投影分片视图）、对禁止的 qualification 路径执行拒绝探测（另一座位、crosswalk、gold、sources、authoring、协议工件、tuner、模型输出）、校验仅创建标注 sink，并在座位不可达处记录监督方访问 transcript。
- **Judgment runtime：**在输入收集期间观察到 `jev_mode=off` 时会中止正在进行的文件和标准输入读取、阻止后续收集，并丢弃迟到的读取结果。
- **Judgment**：拒绝响应模型与请求的原生模型不匹配的 TypeSafe 响应。
- **修复校准 shadow 暂存**：引用文件、清单标识符和受限只读运行时资产现与 supervisor 契约一致。
- 注释投影测试改用生成的本地 fixture，不再依赖维护者专属的 qualification 证据。
- **修复 shadow receipt reconciliation**：强制核对必需回执，同时将冻结清单中遗漏的工作保留为未完成；不再拒绝有效取消处置，也不再将零工作运行误判为未完成。
- 在 PR 审查合成阶段记录**可选、有限的 A05 影子步骤**；评估关闭或不可用时，原有核证、语义去重、否决记录、计数和发布职责保持不变。
- 补充无账户组件演练指引和仅限合成数据的证据边界；组件收据不授予 Jev 工作量，也不能替代具名宿主/W5 验证。
- 修复 judgment 包中的严格 TypeScript 错误，并将声明输出根目录对齐到其 engine 导入路径。
