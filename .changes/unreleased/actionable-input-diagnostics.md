---
category: Harness
packages: commands, cli
---

- Command admission now returns **grouped structured diagnostics**: every schema violation carries its safe field path, stable issue code, message and array index in `details.diagnostics`, so one call reports all missing or malformed fields instead of flattened messages alone.
- **CLI parser errors name the field**: missing arguments and option values identify the input field and the leaf help route (`mstar <path> --help`) when deterministic; unknown flags keep the honest parser diagnostic without a guessed field. Usage responses stay `usage`/exit 2, distinct from engine refusals.
- **Plan write verbs resolve sparse ACTIVE-route intents through the engine**: the caller owns only the operation id and runtime session identity (`--session-id`); the plan token and plan address derive from the trusted caller's own binding, and an unresolvable target refuses with grouped recovery facts instead of a flat usage guess. Stale tokens, live foreign holders and unbound references still refuse at the engine authority boundary (`execution.stale-token`, `coordination.session-mismatch`, `execution.session-unavailable`); the legacy file route keeps its own session and revision requirements.

<!-- CN -->
- 命令准入现在返回**分组结构化诊断**：每条 schema 违规都在 `details.diagnostics` 中携带安全字段路径、稳定 issue code、消息与数组索引，一次调用即可报告全部缺失或畸形字段，而非仅拼接消息。
- **CLI 解析错误指名字段**：缺失参数与选项值在可确定时标明输入字段与叶子帮助路由（`mstar <path> --help`）；未知旗标保留诚实的解析诊断，不猜测字段。usage 响应保持 `usage`/exit 2，与引擎拒绝相区分。
- **Plan 写命令的 ACTIVE 路由稀疏意图交由引擎解析**：调用方只需提供操作 id 与运行时会话身份（`--session-id`）；plan 令牌与 plan 地址由可信调用方自身绑定推导，无法解析目标时以分组恢复事实拒绝，而非笼统 usage。过期令牌、活体外部持有者与未绑定引用仍在引擎权限边界拒绝（`execution.stale-token`、`coordination.session-mismatch`、`execution.session-unavailable`）；legacy 文件路由保留自身的会话与修订要求。
