---
category: Changed
packages: cli, commands
---

- `plan complete` now advertises the argument shape its own parser accepts: the refusal recovery names `--file <absolute-evidence.json>`, so following it verbatim completes the plan instead of being rejected as invalid JSON.
- `session run` keeps the child exit code its admission assigned: a missing executable surfaces the admitted `127` in the `session.child-exit` envelope instead of a generic launcher exit 1.
- `status workflow-close` re-run against a lifecycle this control root already recorded as `completed` and unregistered is the documented idempotent re-run — exit 0 with an explicit nothing-to-close receipt — while a foreign scope and any recorded outcome other than the requested `completed` keep refusing.
- A dashboard service stopped by `SIGTERM` exits with the signal's own status (`128+15`) instead of the start receipt's `0`.
- The CLI stdin reader is bounded and self-cleaning: every settle path detaches its listeners and pauses the stream, and a non-interactive stream that delivers nothing refuses (`command.stdin-unavailable`) instead of holding the command open forever, while an interactive terminal keeps its read.

<!-- CN -->
- `plan complete` 现在只宣告其解析器真正接受的参数形态：拒绝信息的恢复指引给出 `--file <absolute-evidence.json>`，照此逐字执行即可完成计划，而不再被判为非法 JSON。
- `session run` 保留其准入流程已判定的子进程退出码：可执行文件缺失时以 `session.child-exit` 信封给出已准入的 `127`，不再退化为启动器通用的退出码 1。
- `status workflow-close` 对已被本控制根记录为 `completed` 且已注销的生命周期重复执行，即文档所述幂等重跑——退出 0 并给出明确的“无可关闭”收据；外部作用域以及记录结果并非所请求 `completed` 的情形仍然拒绝。
- 被 `SIGTERM` 停止的 dashboard 服务以该信号自身的状态退出（`128+15`），而不是启动收据的 `0`。
- CLI 的 stdin 读取现在有界且自清理：每条结算路径都会摘除监听并暂停流；非交互流在限期内没有输入时以 `command.stdin-unavailable` 拒绝，而不是让命令永久挂起；交互式终端仍保留其读取。
