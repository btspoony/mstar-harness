---
category: Harness
packages: root
---

- `mstar status workflow-close` closes a workflow through the engine's locked snapshot writer and takes `--session <absolute coordinator envelope>`: a coordinated workflow now refuses to close from a plan session (`snapshot <path> is coordinated — close requires --session <coordinator envelope>`, exit `1`, nothing written) before it judges the plan rows, so an unfinished-row refusal can no longer be mistaken for a session problem.

<!-- CN -->
- `mstar status workflow-close` 通过引擎加锁的 snapshot 写入器关闭工作流，并新增 `--session <绝对路径的 coordinator envelope>`：协调工作流现在拒绝由计划会话关闭（`snapshot <path> is coordinated — close requires --session <coordinator envelope>`，退出码 `1`，不写入任何内容），且该判断发生在判定计划行之前，因此"未完成行"拒绝不会再被误判为会话问题。
