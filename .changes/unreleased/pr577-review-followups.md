---
category: Changed
packages: engine, commands, cli, root
---

- **A launched child can no longer address a workflow its identity does not declare (I-000866).** `mstar session run` refuses when the inherited identity names another workflow, and the command now participates in the adapter's coordinator-seat scope gate, so the requested workflow must be the one the launch declares.
- **A launch requires a current-epoch coordinator binding (I-000867).** `mstar session run` compares the binding epoch with the authority epoch and refuses a superseded holder with a recovery pointing at `mstar session recover`.
- **A committed iteration registration replays after its documents change (I-000868).** The reviewed-compass and plan-document proofs now run after the operation replay lookup in both registration producers and in the CLI transport, so an identical retry returns its receipt even when the compass or plan markdown was emptied, removed or edited; a new operation id still refuses and writes nothing.
- **Saved registrations keep replaying after the upgrade.** The request identity canonicalizes the plan-row pointers exactly as the previous release did and keeps only the compass spelling lexical; replay accepts both that fingerprint and the pre-upgrade one, so an unchanged retry returns its saved receipt (explicit or derived operation id) instead of `execution.operation-conflict`.
- **A symlinked `--harness` no longer refuses a valid absolute compass.** `iteration register` hands containment to the producer's real-path proof, so an absolute `--compass-ref` under a symlinked harness and an external alias onto an in-root compass register, while an escaping pointer is still refused.

<!-- CN -->
- **被启动的子进程不能再寻址其身份未声明的工作流（I-000866）。** 当继承身份声明了另一个工作流时，`mstar session run` 会拒绝；该命令现在也纳入适配器的 coordinator-seat 范围门禁，因此请求的工作流必须与其启动身份一致。
- **启动要求当前纪元的 coordinator 绑定（I-000867）。** `mstar session run` 会比较绑定纪元与权威纪元；被取代的持有者会被拒绝，恢复路径指向 `mstar session recover`。
- **已提交的迭代注册在文档变化后仍可重放（I-000868）。** compass 与 plan 文档的存在性证明改为在注册生产者的 operation replay 查询之后执行（CLI 传输层同理），因此相同重试即使 compass 或 plan markdown 已被清空、删除或修改也会返回其收据；新 operation id 仍会被拒绝且不写入任何行。
- **升级后已保存的注册仍可重放。** 请求身份对 plan 行指针沿用旧版本的规范化，仅 compass 拼写保持调用方原样；重放同时接受新指纹与升级前指纹，因此未变更的重试（显式或派生 operation id）会返回已保存的收据，而不是 `execution.operation-conflict`。
- **符号链接形式的 `--harness` 不再拒绝合法的绝对 compass。** `iteration register` 把包含性检查交给生产者基于真实路径的证明，因此符号链接 harness 下的绝对 `--compass-ref` 以及指向根内 compass 的外部别名都能注册，越界指针仍被拒绝。
