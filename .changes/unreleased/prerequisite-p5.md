---
category: Changed
packages: omp
---

- The Phase-1 readiness checkpoint now consumes the **shared** prerequisite seams instead of its own path/base logic (prerequisite contract §4/§5): every registered plan row pointer is resolved through the ONE `resolveRegisteredPlanFile` resolver (the same one registration and the guarded Prepare correction use, including a `.mstarc`-declared or external `{PLAN_DIR}`), and the coordinator identity verdict is read through the engine's own read-only `showPrepareCoordinatorRecovery` view.
- Refusals keep the frozen broad codes callers depend on (`binding-invalid`, `prepare-not-locked`, …) and now carry a typed **diagnostic** that names the §5 subreason, the subject, the safe identity-source label, the public ids already in play, the canonical base/target of a plan pointer and the next supported operation. Identity detail distinguishes `identity-missing`, `identity-mismatch`, `foreign-owner`, `recovery-not-prepare`, `recovery-stale` and `recovery-unauthorized`; path detail distinguishes `plan-pointer-invalid`, `plan-identity-mismatch` and a genuinely `prepare-unlocked`.
- A stale stored pointer (the pre-contract `.mstar/plans/<id>.md` spelling) is therefore never rendered as an unlocked compass: it keeps its own path detail, and readiness never normalizes or repairs the row — the guarded Prepare plan-file correction remains the operation that repairs it.
- The registered model-handoff tool forwards those diagnostics verbatim into its `not-ready` details and names the typed reason and the next supported operation in the refusal text. Diagnostics render public ids, codes and canonical plan pointers only: never an envelope path, credential, session JSON or environment payload. A refused plan pointer is therefore classified by its **received form** (canonical absolute or harness-relative) instead of the value it held, and a receipt/row disagreement reports only the canonical expectations — a malformed stored row can no longer project an arbitrary absolute path.

<!-- CN -->
- Phase-1 就绪检查现在消费**共享**前置接口，而不再使用自己的路径/基准逻辑（前置契约 §4/§5）：每个已注册计划行的指针都经唯一的 `resolveRegisteredPlanFile` 解析器解析（与注册及受保护的 Prepare 修正同一解析器，包含 `.mstarc` 声明或外部 `{PLAN_DIR}`），coordinator 身份判定则读取引擎自有的只读 `showPrepareCoordinatorRecovery` 视图。
- 拒绝仍保留调用方依赖的冻结宽码（`binding-invalid`、`prepare-not-locked` 等），并新增类型化 **diagnostic**：指明 §5 子原因、主体、安全的身份来源标签、已在场的公开 id、计划指针的规范 base/target 以及下一步受支持操作。身份细因区分 `identity-missing`、`identity-mismatch`、`foreign-owner`、`recovery-not-prepare`、`recovery-stale`、`recovery-unauthorized`；路径细因区分 `plan-pointer-invalid`、`plan-identity-mismatch` 与真正未锁的 `prepare-unlocked`。
- 因此过期存储指针（契约前的 `.mstar/plans/<id>.md` 拼写）绝不会被渲染为“未锁指南针”：它保留自己的路径细因，且就绪检查从不规范化或修复该行——受保护的 Prepare 计划文件修正仍是唯一的修复操作。
- 已注册的 model-handoff 工具把这些 diagnostics 原样转发进 `not-ready` details，并在拒绝文本中点明类型化原因与下一步受支持操作。diagnostics 只渲染公开 id、代码与规范计划指针：绝不包含信封路径、凭据、session JSON 或环境负载。因此被拒绝的计划指针只按其**接收形态**（规范绝对路径或 harness 相对路径）分类，而不携带其持有的值；receipt 与行不一致时也只报告规范期望值——畸形存储行不再可能泄露任意绝对路径。
