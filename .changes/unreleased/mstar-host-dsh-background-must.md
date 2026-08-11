---
category: Harness
packages: root
---

- **dsh host**: concurrent subagent dispatch now **requires** background mode — any N≥2 dispatch that needs parallel execution (QC tri-review, dual-track) MUST invoke every `subagent` call with `run_in_background: true` in one message; foreground N≥2 invokes run serially (fail-closed `exclusive` tool classification) and do not satisfy an N-parallel requirement (dispatch-incomplete / `Blocked`). Updated `mstar-host/references/dsh.md` (PM dispatch + QC default).

<!-- CN -->
- **dsh 宿主**：并发 subagent 派发现**强制要求 background 模式**——任何需要并行执行的 N≥2 派发（QC 三审、双轨实现）必须在同一条消息中对每个 `subagent` 调用都设置 `run_in_background: true`；前台（foreground）N≥2 调用会串行执行（工具为 fail-closed `exclusive` 分类），不算满足 N 并行要求（属派发未完成 / `Blocked`）。更新 `mstar-host/references/dsh.md`（PM dispatch + QC default）。
