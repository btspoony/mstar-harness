---
category: Harness
packages: dsh
---

- **dsh engine-status row**: the model-facing `<mstar_engine_status>` block no longer repeats the **watermark trio** — it renders only the iteration phase gate and the workspace-state digest. `mstar version:` / `harness dir:` / `enforcement:` stay in the persisted payload (the panel meta dock renders them) and stay model-visible once in the always-on system prompt (`mstar:engine-status` digest + `mstar:harness-rules`), so the row is now a projection of the payload rather than a byte-identical render.
- Emission is **change-driven instead of per-turn**: the row is appended on the first emission for a session+workspace and then only when its rendered text or the panel-relevant payload projection changes, so an unchanged session no longer accumulates an identical copy on every turn's first step. The projection excludes the store revision, which the emission's own write advances.
- A workspace with **no resolved `{HARNESS_DIR}` composes no row** (after the watermark removal it would be an empty wrapper).
- The no-active-lifecycle message now names the **execution authority** and a real recovery command instead of the retired `status.json` root, and the row's `leases` line became `row scope` — each plan row's own recorded worktree + branch, a scope rather than an ownership claim.
- Documented the resulting panel semantics: the stored emission is the last payload the model saw, so its freshness footer `turn` / `at` mean *last emission*; after host-side context compaction the row is not periodically re-anchored until the next change (the system-prompt digest still carries the version, the active workflow and its plans).

<!-- CN -->
- **dsh engine-status 行**：模型可见的 `<mstar_engine_status>` 块不再重复**水印三行**——只渲染迭代相位闸门与工作区状态摘要。`mstar version:` / `harness dir:` / `enforcement:` 保留在持久化 payload 中（面板 meta dock 渲染它们），并在常驻 system prompt（`mstar:engine-status` 摘要 + `mstar:harness-rules`）中模型可见一次，故该行现在是 payload 的投影，而非逐字节渲染。
- 发射改为**变更驱动、而非按 turn**：按会话+工作区首次发射后，仅当渲染文本或面板相关 payload 投影变化时才追加，长会话不再每 turn 首步堆积一份相同副本。投影排除 store revision——发射自身的写入会推进它。
- 未解析到 `{HARNESS_DIR}` 的工作区**不再组合该行**（去掉水印后它会是空包裹）。
- 无活跃生命周期消息改为指明**执行权威**并给出真实恢复命令，而非已退役的 `status.json` 根文档；该行的 `leases` 行改为 `row scope`——即各 plan 行自己记录的 worktree + branch，是范围而非所有权声明。
- 记录由此产生的面板语义：已存发射即模型最后看到的 payload，故其新鲜度页脚 `turn` / `at` 意为*最后发射*；宿主侧上下文压缩之后，该行在下一次变化前不会周期性重锚（system prompt 摘要仍携带版本、活跃工作流与其 plans）。
