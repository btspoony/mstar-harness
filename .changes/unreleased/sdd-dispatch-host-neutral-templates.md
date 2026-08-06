---
category: Harness
packages: root
---

- Made the SDD dispatch templates **host-neutral** so they no longer prime a single host's tool schema: `implementer-prompt.md`, `task-reviewer-prompt.md`, and `implementer-continuation-prompt.md` now use `Dispatch:` / `Role:` / `Name:` / `Prompt body:` labels with an inline host-field map (`omp agent / Cursor subagent_type / OpenCode subagent → mstar-host C5`) instead of Cursor-only fields (`subagent_type`, `description`, `prompt`). The L2 task reviewer template now states the omp `agent` value directly (`reviewer` or `task` + C5b), closing the mapping confusion that produced generic-worker fallbacks under SDD.
- Trimmed the **envelope-first** rationale repeated across `mstar-host/references/omp.md` and `parallel-dispatch.md` to a one-line mechanical rule + SSOT pointer (the long-body prose was itself contributing to attention crowding), and added the L2 reviewer `agent` mapping to the omp SDD section.

<!-- CN -->
- 将 SDD 派发模板改为**宿主中立**，不再固定引发单一宿主工具 schema：`implementer-prompt.md`、`task-reviewer-prompt.md`、`implementer-continuation-prompt.md` 改用 `Dispatch:` / `Role:` / `Name:` / `Prompt body:` 标签 + 内联宿主字段映射（`omp agent / Cursor subagent_type / OpenCode subagent → mstar-host C5`），替代 Cursor 专有字段（`subagent_type`、`description`、`prompt`）。L2 任务 reviewer 模板现直接给出 omp `agent` 取值（`reviewer` 或 `task` + C5b），消除 SDD 下导致 generic worker 回退的映射困惑。
- 精简 `mstar-host/references/omp.md` 与 `parallel-dispatch.md` 中**envelope-first** 的重复论述为单行机械规则 + SSOT 指针（长段散文本身会加剧注意力挤占），并在 omp SDD 段补充 L2 reviewer `agent` 映射。
