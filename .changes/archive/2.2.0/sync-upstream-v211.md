---
packages: root, engine, cli, opencode
---

- **Sync upstream v2.1.1**: merged the upstream `mstar-harness` v2.1.1 line into the dev-dsh branch — adds the `code-reviewer` role (read-only L2 SDD task reviewer / audit executor; replaces `generalPurpose` as the SDD per-task review seat, with generic fallback only when the role agent is absent on the host), ships the canonical default-ignore harness `.gitignore` format (`.mstar/**` + tracked re-includes `AGENTS.md` / `knowledge/` / `specs/`) across the engine, CLI `init` fence and bundled skills, and aligns all 11 version surfaces to 2.1.1.
- **engine**: `emitGitignoreSnippet` / `validateGitignore` / `HARNESS_PROCESS_GITIGNORE` now emit the default-ignore + re-include format instead of the flat per-directory ignore list; `ROLE_MAPPING` grows to 14 ids with `code-reviewer`.
- **bundle-assets**: re-synced `packages/dsh/harness-skills` / `harness-commands` from the merged `skills/` tree — the 6+ upstream-touched bundled skills and all `mstar-host/references/*.md` host adapters (cursor/kimi/omp/opencode/zcode) now carry the v2.1.1 wording (SDD task reviewer → `code-reviewer`).

<!-- CN -->
- **同步上游 v2.1.1**：将上游 `mstar-harness` v2.1.1 线合入 dev-dsh 分支——新增 `code-reviewer` 角色（只读 L2 SDD 任务评审 / 审计执行席；取代 `generalPurpose` 作为 SDD 每任务评审席位，仅当宿主缺失该角色 agent 时回退 generic），在 engine、CLI `init` fence 与 bundled skills 中全面采用 canonical 的 harness 默认忽略 `.gitignore` 格式（`.mstar/**` + 追踪重包含 `AGENTS.md` / `knowledge/` / `specs/`），并将全部 11 个版本面对齐到 2.1.1。
- **engine**：`emitGitignoreSnippet` / `validateGitignore` / `HARNESS_PROCESS_GITIGNORE` 改为输出「默认忽略 + 重包含」格式，替代旧的逐目录平铺 ignore 清单；`ROLE_MAPPING` 扩至 14 个 id，新增 `code-reviewer`。
- **bundle-assets**：将 `packages/dsh/harness-skills` / `harness-commands` 从合并后的 `skills/` 树重同步——上游改动的 6+ 个 bundled skills 及全部 `mstar-host/references/*.md` 宿主适配（cursor/kimi/omp/opencode/zcode）均携带 v2.1.1 措辞（SDD 任务评审 → `code-reviewer`）。
