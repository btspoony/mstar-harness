---
category: Harness
packages: commands, cli
---

- Command admission now returns **grouped structured diagnostics**: every schema violation carries its safe field path, stable issue code, message and array index in `details.diagnostics`, so one call reports all missing or malformed fields instead of flattened messages alone.
- **CLI parser errors name the field**: missing arguments and option values identify the input field and the leaf help route (`mstar <path> --help`) when deterministic; unknown flags keep the honest parser diagnostic without a guessed field. Usage responses stay `usage`/exit 2, distinct from engine refusals.

<!-- CN -->
- 命令准入现在返回**分组结构化诊断**：每条 schema 违规都在 `details.diagnostics` 中携带安全字段路径、稳定 issue code、消息与数组索引，一次调用即可报告全部缺失或畸形字段，而非仅拼接消息。
- **CLI 解析错误指名字段**：缺失参数与选项值在可确定时标明输入字段与叶子帮助路由（`mstar <path> --help`）；未知旗标保留诚实的解析诊断，不猜测字段。usage 响应保持 `usage`/exit 2，与引擎拒绝相区分。
