---
packages: root, opencode
---

- **PR deep-review local report archive**: each `pr`-variant review now saves a durable markdown report under `{PROJECT_DIR}/reports/pr-review/` (`_default` when project-less) — YAML frontmatter metadata (PR, head SHA, verdict, score, tally, review URL) plus the posted GitHub Review body verbatim; bare branch/diff reviews archive the chat display instead. Saved before worktree cleanup; new `- report:` field in the Completion Report output shape.

<!-- CN -->
- **PR 深审本地报告留档**：`pr` 变体每次审查现会在 `{PROJECT_DIR}/reports/pr-review/`（无项目流程用 `_default`）落盘一份持久 markdown 报告 —— YAML frontmatter 元数据（PR、head SHA、verdict、score、tally、review URL）+ 逐字保存的 GitHub Review 正文；bare branch/diff 审查则存 chat 展示内容。于 worktree 清理前保存；Completion Report 输出形状新增 `- report:` 字段。
