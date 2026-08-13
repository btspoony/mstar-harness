---
packages: root
---

- **dsh plugin**: synced `packages/dsh` to the dsh `0.0.1-rc.2` rename wave — seam package renames consumed (`@deepseek-ai/dsh-skill-local` → `@deepseek-ai/dsh-skill-filesystem`; test-only `dsh-tasks`/`dsh-tasks-fake` → `dsh-jobs`/`dsh-jobs-fake`), peerDependencies bumped `^0.0.1-rc.1` → `^0.0.1-rc.2`, and renamed API symbols (`SkillService` → `SkillRegistry`; the optional background-seam surface `ctx.tasks`/`onTaskDone`/`TaskId`/`TaskDoneListener`/`TaskSnapshot` → `ctx.jobs`/`onJobDone`/`JobId`/`JobDoneListener`/`JobSnapshot`; client `LocaleService` → `LocaleRuntime`, `SlotsService` → `SlotRegistry`). Docs/README `skill-local` prose renamed to `skill-filesystem`.

<!-- CN -->
- **dsh 插件**：`packages/dsh` 同步到 dsh `0.0.1-rc.2` 重命名波——消费 seam 包改名（`@deepseek-ai/dsh-skill-local` → `@deepseek-ai/dsh-skill-filesystem`；测试专用 `dsh-tasks`/`dsh-tasks-fake` → `dsh-jobs`/`dsh-jobs-fake`），peerDependencies 从 `^0.0.1-rc.1` 升到 `^0.0.1-rc.2`，并同步 API 符号改名（`SkillService` → `SkillRegistry`；可选后台 seam 面 `ctx.tasks`/`onTaskDone`/`TaskId`/`TaskDoneListener`/`TaskSnapshot` → `ctx.jobs`/`onJobDone`/`JobId`/`JobDoneListener`/`JobSnapshot`；client `LocaleService` → `LocaleRuntime`、`SlotsService` → `SlotRegistry`）。文档/README 中 `skill-local` 措辞改为 `skill-filesystem`。
