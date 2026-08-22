---
category: Harness
packages: root
---

- **Skill pointer + callout hygiene**: `mstar-audit` Handoff step 1 now registers the workflow + plan rows in `{WORKFLOW_DIR}/<id>/snapshot.json` (root `status.json` v2 holds the workflows registry only); the plan-conventions R# sentence names `{PROJECT_DIR}/<id>/residuals.json` as the open-state SSOT.
- **Load-condition fix**: `mstar-design-md` is now an **on-demand** skill (UI / design-token plans only) in the `architect` and `product-manager` role references; `mstar-compound-refresh` no longer claims STRATEGY.md creation (delegated to `mstar-strategy`).
- **Callout-dedup guard**: `scripts/drift-lint.ts` gains `checkCalloutDuplication` — normalized (whitespace + bilingual-variant) Engine-check callout bodies now fail when duplicated across files; lease (`mstar-plan-artifacts`) and review-seats (`mstar-review-qc`) callouts are canonical with one-line pointers elsewhere.
- **Shared anti-recursion NEVER**: the five conceptual anti-recursion bullets now live once in `_shared/leaf-executor-core.md` with role-specific pointers kept in each role reference.
- **Strategy thin**: `mstar-strategy` create/maintain prose is replaced by a pointer to `project-knowledge-bootstrap.md` Phase 2 (six-section table + engine check retained).
- **Knowledge usage gate**: harness entry, iteration §1.1, `iteration-start` Research, phase-gates implement, and `knowledge-and-designs.md` now discover `{KNOWLEDGE_DIR}/README.md` by default — implementers scan the index and read relevant Active rows even when `plans[].metadata` has no knowledge link (registered metadata links stay mandatory).
- No `audit promote` CLI is added (a separate promote plan owns it).

<!-- CN -->
- **技能指针与 callout 卫生**：`mstar-audit` Handoff 第 1 步改为在 `{WORKFLOW_DIR}/<id>/snapshot.json` 注册 workflow 与 plan 行（根 `status.json` v2 仅作 workflows 注册表）；plan-conventions 的 R# 句改为以 `{PROJECT_DIR}/<id>/residuals.json` 为 open 状态 SSOT。
- **加载条件修复**：`mstar-design-md` 在 `architect` 与 `product-manager` 角色引用中改为 **On demand**（仅 UI / design-token 条件触发）；`mstar-compound-refresh` 不再揽下 STRATEGY.md 的 bootstrap（交由 `mstar-strategy` 承接）。
- **Callout 去重守卫**：`drift-lint.ts` 新增 `checkCalloutDuplication`——归一化空白与双语变体后，同一 Engine-check callout 正文出现在多个文件即判定失败；lease（`mstar-plan-artifacts`）与 review seats（`mstar-review-qc`）callout 各保留一份 canonical，其余位置改为一行为指针。
- **共享反递归 NEVER**：五条概念性反递归红线收敛到 `mstar-roles/references/_shared/leaf-executor-core.md`，各角色文件保留角色专属条目并加一行指针。
- **策略文档精简**：`mstar-strategy` 的 create/maintain 长文替换为指向 `project-knowledge-bootstrap.md` Phase 2 的指针（六段式表格与 engine check 保留）。
- **知识使用门禁**：harness 入口、iteration §1、`iteration-start` Research、phase-gates implement 与 `knowledge-and-designs.md` 默认先发现 `{KNOWLEDGE_DIR}/README.md` 索引——即使 `plans[].metadata` 无 knowledge 链接，implementer 也须扫描索引并阅读相关 Active 行（已注册的 metadata 链接仍为强制）。
- 不新增 `audit promote` CLI（由独立的 promote plan 负责）。
