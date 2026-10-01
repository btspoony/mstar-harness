---
category: Harness
packages: root
---

- Replaced the plan template's universal integration sequence with the lifecycle contract's three declared completion routes: iteration keeps its pinned integration, standalone development completes straight from the accepted handoff, and standalone report-only records its `completion_policy` fulfilment before `Done`. Absent integration anchors no longer falsely block report-only plans and never excuse genuinely missing registration facts.
- Updated `mstar-artifacts/templates/plan.main.md` (Engine lifecycle block) and `mstar-artifacts/references/plan-quality-bar.md` (item 8, Engine lifecycle ownership) to match the authority.
- Rewrote the `mstar-use-cli` sparse-intent guidance around the verified active transport: attempt the sparse intended action and let the engine derive the caller-owned session binding and the plan's current token before requiring a separate read; explicit operator `--session-id` stays mandatory for fresh plan-PM binds, caller-owned operation ids stay required, and ambiguous coordinator plan selection, unavailable authorization and foreign live holders are never derived or auto-selected.
- Replaced the blanket "refusals are mutation-free" rule with action-local refusal semantics: a refusal's commit state is read from its receipt — the engine's coordinated plan-route refusals are transactional (no row, receipt or counter change), action-local partial receipts preserve already-committed components, and only the documented remaining action is replayed; a stale explicit token recovers by re-reading and retrying fresh.
- Removed the stale decision rule that the argument parser can exit 1 for a missing required argument: a probe of the current built CLI answers a missing positional argument with the usage envelope (`command.invalid-input`, exit 2).
- Aligned `mstar-use-cli/references/preconditions.md`'s active-route identity and token guidance with the verified transport: the CLI/MCP transports carry no ambient identity, so the independently acquired caller identity is supplied per call as the verbs' own `--session-id`/`sessionId` (never read from a session file, never carried by or derived from the session reference), and for plan operations an execution token is supplied only as an explicit constraint — omitted, the engine derives the current token from the plan's own read.

<!-- CN -->
- 将计划模板中的通用集成序列替换为生命周期契约声明的三条完成路由：iteration 保留固定集成，standalone development 从已接受交接直接完成，standalone report-only 在 `Done` 之前记录其 `completion_policy` 履行。缺失集成锚点不再错误阻断 report-only 计划，也绝不豁免真正缺失的注册事实。
- 更新 `mstar-artifacts/templates/plan.main.md`（Engine lifecycle 块）与 `mstar-artifacts/references/plan-quality-bar.md`（第 8 条 Engine lifecycle ownership）以与权威契约保持一致。
- 以已验证的活跃传输为中心重写 `mstar-use-cli` 的稀疏意图指导：直接尝试稀疏的意图动作，让引擎先推导调用方自己的会话绑定与计划当前令牌，再考虑单独读取；全新 plan-PM 绑定仍必须显式提供操作者 `--session-id`，调用方自有的 operation id 仍是必填项，而协调者计划选择的歧义、授权不可用与外部活跃持有者冲突绝不被推导或自动选择。
- 用动作局部语义替换笼统的"拒绝即无变更"规则：拒绝的提交状态以回执为准——引擎协调的 plan 路由拒绝是事务性的（不写任何行、回执或计数器），动作局部部分回执保留已提交的组件，且只重放文档记载的剩余动作；过期显式令牌通过重读后以新令牌重试恢复。
- 删除了"参数解析器可能因缺失必需参数而退出码 1"的过期决策规则：对当前构建 CLI 的探测表明，缺失位置参数会以 usage 信封（`command.invalid-input`，退出码 2）应答。
- 将 `mstar-use-cli/references/preconditions.md` 的活跃路由身份与令牌指导对齐到已验证传输：CLI/MCP 传输不携带环境身份，独立获取的调用方身份以动词自身的 `--session-id`/`sessionId` 按调用提供（绝不读自会话文件，绝不由会话引用携带或推导）；对 plan 操作，执行令牌仅在作为显式约束时提供——省略时引擎从计划自身的读取推导当前令牌。
