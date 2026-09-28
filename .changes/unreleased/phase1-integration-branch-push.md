---
category: Harness
packages: root
---

- **Phase 1 no longer commits harness artifacts**: the §2.3 integration-worktree checklist step 7 (reached through `iteration-start` §6) now pushes only the newly created `spec_integration_branch` (`git push -u`; the branch tip stays at the recorded base, satisfying the `phase-1-lock` readiness check that the pushed remote tip equal the live integration HEAD — enforced by the omp model-handoff runtime). The reviewed compass / plans / specs / iteration package are default-gitignored `{HARNESS_DIR}` process artifacts: they are never transferred, committed or pushed, and the primary checkout keeps its uncommitted Phase 1 docs. Renamed the `iteration-start` pre-commit checklist to the pre-integration checklist and reworded the §1.6 uncommitted-docs exception accordingly.

<!-- CN -->
- **Phase 1 不再提交 harness 产物**：§2.3 integration-worktree checklist step 7（经 `iteration-start` §6 进入）现在只 push 新建的 `spec_integration_branch`（`git push -u`；分支 tip 停留在记录的 base，从而满足 `phase-1-lock` 就绪检查——已 push 的 remote tip 等于 live integration HEAD，由 omp model-handoff 运行时校验）。已 review 的 compass / plans / specs / iteration package 是默认 gitignored 的 `{HARNESS_DIR}` 本地工件：不搬运、不 commit、不 push，主 checkout 上的 Phase 1 未提交文档保持原样。`iteration-start` 的 pre-commit checklist 更名 pre-integration checklist，§1.6 未提交文档例外相应改写。
