---
category: Harness
packages: root
---

- Added a **bounded-resolution scenario ledger** with deterministic call-depth witnesses for the command registry: every published command and every supported slash-command document now carries a semantic scenario disposition (witnessed or explicitly unverified), enforced against the live registry and document enumeration.
- Real-handler fixtures over isolated local stores prove exact-missing-field refusals, executable selected routes, explicit/derived revision constraints, foreign-holder lease receipts, retired-command refusals, and a **store-upgrade retirement failure** whose partially applied state is evidenced from persisted files and completed by a replay within the three-call budget — the refusal envelope exposes no partial-applied facts, so envelope/state agreement stays explicitly unverified.
- A retained **negative control** records a known >3-call cold-start interaction as noncompliant; the aggregate ≤3-call compliance gate stays unverified until an unchanged scenario set supplies post-change evidence.
- Extended the **skill-eval evaluator** with bounded-resolution accounting (no second evaluator): raw-event scans deduplicate start/completed invocations by invocation identity, count failed attempts, keep identity-less records as explicit unknowns (never zero-filled), and carry each case's declared warm/cold bootstrap context; new `calls_within` / `mutation_withheld` / `grouped_facts_final` assertions keep a grouped-facts or withheld-effect outcome distinct from an applied mutation, and reports render declared contexts and invocation totals under the same unknown-stays-unknown honesty rules.

<!-- CN -->
- 新增**有界解析场景台账**与确定性调用深度见证：每个已发布命令与每个受支持的斜杠命令文档都具备语义化场景处置（已见证或显式未验证），并对注册表与文档枚举做运行时强制校验。
- 基于隔离本地存储的真实处理器夹具，证明精确缺失字段拒绝、可执行选中路由、显式/派生修订约束、外部持有者租约回执、退役命令拒绝，以及 **store upgrade 退役失败**的持久化部分状态与三调用预算内的重放完成——拒绝信封不暴露任何部分落库事实，信封与状态的一致性保持显式未验证。
- 保留一条**阴性对照**：已知超过三次调用的冷启动交互被如实记为不合规；聚合 ≤3 调用合规门禁保持未验证状态，直至同一场景集提供变更后证据。
- 为 **skill-eval 评估器**扩展有界解析核算（不另建第二评估器）：原始事件扫描按调用身份对 start/completed 去重、计入失败尝试、把无身份记录保留为显式未知（绝不补零），并携带每个用例声明的 warm/cold 引导上下文；新增 `calls_within` / `mutation_withheld` / `grouped_facts_final` 断言，将分组事实或暂扣效应结果与已执行变更明确区分，报告按同一"未知仍是未知"的诚实规则渲染声明上下文与调用总量。
