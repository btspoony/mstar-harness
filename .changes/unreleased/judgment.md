---
category: Harness
packages: root, cli, commands
---

- Added the finite `judgment review-advice` CLI and bundled private judgment runtime for bounded, non-authoritative synthetic review advice.
- Exposed judgment runtime, audit, evaluator-channel, and shadow-supervisor APIs; made the shadow runner available as `@mstar-harness/judgment/shadow`.
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
- Repaired the first red runs of the newly registered `test-judgment` / `test-commands` jobs: the shadow-supervisor confinement case probes its declared environment (Linux platform, listable `/proc`, writable `/mnt/output`, which the CI job pre-creates runner-writable) and a capability guard fails the CI run with the named missing capability instead of silently skipping the witness; the study-closure cases now run everywhere through the supervisor's public controlled-provider inputs over the real mailbox protocol (the live-provider witness remains a documented gap), two latent assertion defects they had never exercised were fixed (missing assessor evidence fields and unbalanced receipt accounting), and the synthesis-pack tests assert `validatePack` content equality (`toEqual`) since validation intentionally returns a normalized derived copy, not the same reference. The container/mount isolation semantics the study-closure cases used to exercise are NOT exercised by this rewrite (the test job has no configured container worker image/namespace launcher); what remains verified is the host-side capability probe and loud guard plus the supervisor's mailbox closure over valid requests and the assessor's refusals of failed or run-identity-mismatched study results. The controlled-mailbox integration test widens its worker poll budget (1s→6s), child cap (2s→the pilot's 10s ceiling) and test timeout, which a loaded CI runner outran (observed 1.1s round trip) without changing the lifecycle contract it witnesses.
- **Development calibration** recognizes a genuinely fresh frozen qualification root as a first run and loads prior-run manifests and request hashes from the newest per-run directory, preserving freeze identity checks.
- **Freeze validation** now rejects annotated corpus variants that lack a gold row instead of silently excluding their labels from coverage checks.
- **Security:** Removed worker CLI attestation based on caller-controlled environment values and filesystem shape. Unauthenticated `review-advice` calls now fail before pilot/pack collection; worker-side submission remains unavailable until an authenticated launch adapter exists.
- Added **CI test routes for the `commands` and `judgment` packages**: both package manifests now declare `test: "bun test"`, and CI runs each surface as an independent `test-commands` / `test-judgment` job alongside the existing per-package jobs.

<!-- CN -->
- 新增有限的 `judgment review-advice` CLI，并打包私有 judgment runtime，用于有界、非权威的合成评审建议。
- 导出 judgment runtime、审计、评估器通道与 shadow supervisor API；通过 `@mstar-harness/judgment/shadow` 提供 shadow runner。
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
- 修复新注册的 `test-judgment` / `test-commands` 任务首轮红榜：shadow-supervisor 禁闭用例探测其声明环境（Linux 平台、可列出 `/proc`、可写 `/mnt/output`——CI 任务预置 runner 可写目录），能力守卫在 CI 缺失能力时以点名原因红榜而非静默跳过见证；study 闭环用例改经 supervisor 公开受控 provider 输入与真实 mailbox 协议全平台执行（live provider 见证仍为显式记录缺口），并修复其中两个从未被执行到的断言缺陷（缺失评估证据字段、receipt 记账不平衡）；synthesis-pack 测试改为断言 `validatePack` 内容相等（`toEqual`），因为校验有意返回规范化的派生副本而非同一引用。study 闭环用例原先行使的容器/挂载隔离语义在本重写中不被行使（该测试任务未配置容器 worker 镜像/namespace 启动路径）；仍然验证的是宿主侧能力探测与响亮守卫，以及 supervisor 对有效请求的 mailbox 闭环和对失败或 run 身份不匹配 study 结果的 assessor 拒绝。受控邮箱集成测试放宽其 worker 轮询预算（1s→6s）、child 上限（2s→pilot 的 10s 上限）与测试超时：高负载 CI runner 的往返实测 1.1s 会超出旧预算，其见证的生命周期契约不变。
- **开发校准**将真正全新的冻结资格根目录识别为首次运行，并从最新的单次运行目录加载先前的清单和请求哈希，同时保留冻结身份校验。
- **冻结校验**现在会拒绝存在标注但缺少 gold 行的语料变体，不再静默排除其标签覆盖检查。
- **安全性：**移除基于调用方可控环境变量和文件系统形状的 worker CLI 认证。未认证的 `review-advice` 调用会在收集 pilot/pack 前失败；在提供认证启动适配器前，worker 侧提交不可用。
- 新增 **`commands` 与 `judgment` 包的 CI 测试路由**：两个包清单现在声明 `test: "bun test"`，CI 以独立的 `test-commands` / `test-judgment` 任务运行这两个测试面，与现有按包任务并列。
