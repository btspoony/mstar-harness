# Execution H3 — native human admission and launcher

- Add the plugin-owned `/mstar-execution` closed-JSON human command for explicit adopt, clear, and native argv execution.
- Refuse known leaf/subagent seats on every operation before any harness probe; derive identity from the carrying DSh session and overwrite execution identity transport in shell-free child launches.
- Adopt only after current C1 session resume succeeds; model tool paths consume persisted bindings and never gain authority from human command payloads.

<!-- CN -->

# Execution H3 — 原生人类准入与 launcher

- 新增 plugin-owned `/mstar-execution` closed-JSON 人类命令，支持显式 adopt、clear 与原生 argv 执行。
- 在任何 harness 探测之前对已知 leaf/subagent seat 的全操作 fail-closed 拒绝；身份仅来自承载事件的 DSh session，并在无 shell 的子进程启动中覆盖 execution identity transport。
- 仅在当前 C1 session resume 成功后 adopt；模型工具路径只消费已持久 binding，不从人类命令 payload 获得隐式 authority。
