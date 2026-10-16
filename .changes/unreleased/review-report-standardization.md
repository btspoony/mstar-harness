---
category: Harness
packages: root, engine, commands, dsh
---

- Review output now lives in a dedicated **`{REVIEW_DIR}`** tree (default `{HARNESS_DIR}/reviews/`, `.mstarc` `review_dir` aware) with run-scoped directory names — `<date>-codebase-<level>-<round>`, `<date>-pr<N>`, `<date>-branch-<slug>`, `<date>-diff-<short-sha>`; `reviewRunDirName` / `resolveReviewRunDir` / `resolveReviewDir` are exported and `harness scaffold` creates `reviews/`.
- **The codebase audit writes a review report, not plans**: `scaffoldAuditReport` writes `<reviewsDir>/<date>-codebase-<level>-<round>/README.md` (same finding gates; the README drops the plan execution-order block). `mstar audit scaffold` gains `--level` / `--round` / `--reviews-dir` / `--dir`, and the `promote` verb of the `mstar audit` family — with `scaffoldAuditPlan`, the plan-Status-block validators and the plan-list helper — is **removed**. The audit seam now scans markdown under `{REVIEW_DIR}` with the credential scan as its only validator.
- **PR review reports and evidence move to `{REVIEW_DIR}/<date>-pr<N>/`**: `prReviewReportPath` takes `reviewsDir` instead of `reportsDir`, and `mstar pr-review report-path` takes an optional `--reviews-dir` defaulting to the resolved `{REVIEW_DIR}`; the dsh `mstar-pr-seats` `reportsDir` argument is that same review run directory.
- Updated the audit/review skills, the slash commands, `docs/commands.md` + `docs/runtime-reference.md` and the plan-lifecycle references: no plan files, no promotion producer, no plan-quality-bar citation on the review surface.

<!-- CN -->
- 评审产出迁入专用 **`{REVIEW_DIR}`** 目录树（默认 `{HARNESS_DIR}/reviews/`，受 `.mstarc` `review_dir` 控制），run 目录名固定：`<date>-codebase-<level>-<round>`、`<date>-pr<N>`、`<date>-branch-<slug>`、`<date>-diff-<short-sha>`；导出 `reviewRunDirName` / `resolveReviewRunDir` / `resolveReviewDir`，`harness scaffold` 创建 `reviews/`。
- **代码库审计产出 review report 而非 plan**：`scaffoldAuditReport` 写入 `<reviewsDir>/<date>-codebase-<level>-<round>/README.md`（findings 门禁不变；README 去掉 plan 执行顺序块）。`mstar audit scaffold` 新增 `--level` / `--round` / `--reviews-dir` / `--dir`，并**移除** `mstar audit` 家族的 `promote` 动词（连同 `scaffoldAuditPlan`、plan Status block 校验与 plan 列表辅助函数）。审计 seam 现扫描 `{REVIEW_DIR}` 下的 markdown，且只保留凭据扫描这一项校验。
- **PR review 报告与证据迁至 `{REVIEW_DIR}/<date>-pr<N>/`**：`prReviewReportPath` 选项由 `reportsDir` 改为 `reviewsDir`；`mstar pr-review report-path` 增加可选 `--reviews-dir`，默认取解析后的 `{REVIEW_DIR}`；dsh `mstar-pr-seats` 的 `reportsDir` 参数即同一 review run 目录。
- 同步更新审计/评审技能、斜杠命令、`docs/commands.md` 与 `docs/runtime-reference.md`、以及 plan 生命周期参考：评审面不再产出 plan 文件、不存在 promotion producer、不再引用 `plan-quality-bar`。
