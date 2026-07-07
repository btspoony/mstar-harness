# 产物存储路径（SSOT · 路径符号解析后）

> **Authority**: `mstar-plan-conventions` `references/artifact-storage-paths.md`.
> Symbol definitions (`{HARNESS_DIR}`, `{KNOWLEDGE_DIR}`, `{PLAN_DIR}`, etc.) → `mstar-plan-conventions` SKILL.md § 路径符号。
> All `mstar-*` skills that produce or operate on files **must** follow this table; do not redefine paths locally.

## Harness 子树内（`{HARNESS_DIR}/` 下）

这些是 agent handoff 用的结构化产物，随 `.git` 追踪，不面向人类直接阅读。

| 产物 | 解析后路径（默认 `.mstar/`） | 读写的技能 |
|------|---------------------------|-----------|
| **知识文档** | `.mstar/knowledge/<category>/<slug>.md` | `mstar-compound`（写）、`mstar-compound-refresh`（读写） |
| **知识索引** | `.mstar/knowledge/README.md` | `mstar-compound`（写）、`mstar-compound-refresh`（读写） |
| **主 plan** | `.mstar/plans/<plan-id>-<name>.md` | PM / `mstar-plan-artifacts` |
| **QC 报告** | `.mstar/plans/reports/<plan-id>/qc1.md`…`qc3.md` + consolidated（**SDD 默认**）；`qc.md`（inline 例外） | `mstar-review-qc` |
| **SDD scratch** | `{HARNESS_DIR}/sdd/<plan-id>/`（gitignored） | `mstar-sdd` |
| **status.json** | `.mstar/status.json` | `mstar-plan-artifacts` |
| **迭代 compass** | `.mstar/iterations/<iteration-id>-delivery-compass.md` | `mstar-iteration`（读写） |
| **迭代工作区** | `.mstar/iterations/<iteration-id>/`（`guides/`、`specs/` 等） | `mstar-iteration`（读写）；close 时 `mstar-compound`（提升读） |
| **迭代索引** | `.mstar/iterations/README.md` | `mstar-iteration`（读写） |
| **规格** | `specs/`（优先），否则 `designs/` | `mstar-plan-artifacts` |
| **archived residuals** | `.mstar/archived/residuals/<plan-id>.json` | `mstar-plan-artifacts` |
| **archived knowledge** | `.mstar/archived/knowledge/`（保留原 `{KNOWLEDGE_DIR}` 相对路径） | `mstar-iteration` §1.6 corpus hygiene、`mstar-plan-artifacts` |
| **archived specs** | `.mstar/archived/specs/`（保留原 `{SPECS_DIR}` 相对路径） | `mstar-iteration` §1.6 corpus hygiene、`mstar-plan-artifacts` |

## 仓库根目录（`<repo-root>/`，与 `.git/` 同级）

这些是人类和所有 agent 的共同入口，**不在** `{HARNESS_DIR}` 子树内。

| 产物 | 解析后路径 | 读写的技能 |
|------|----------|-----------|
| **CONCEPTS.md** | `<repo-root>/CONCEPTS.md` | `mstar-compound`（写/协同）、`mstar-compound-refresh`（reconciliation/bootstrapping） |
| **STRATEGY.md** | `<repo-root>/STRATEGY.md` | `mstar-strategy`（读写） |
| **AGENTS.md 更新** | `<repo-root>/AGENTS.md`（或 `CLAUDE.md`） | `mstar-compound`（可发现性检查编辑）、`mstar-strategy`（索引编辑） |

## 禁止操作区域

以下目录**不属于** harness 知识/策略的产出目标，skills 不得在其中写入：

| 路径 | 说明 |
|------|------|
| `docs/` | 人类文档（安装、贡献指南等），知识产物不放此处 |
| `{ITERATION_DIR}/` | 仅限迭代 compass，知识文档不放此处 |
| `{SPECS_DIR}/` | 仅限冻结规格/ADR，运行时知识不放此处 |
| `{PLAN_DIR}/reports/` | 仅限 QC 报告，知识文档不放此处 |

## `<category>` 取值

知识文档的 `<category>` 子目录由 `mstar-compound` 的 `references/category-mapping.md` 定义，在 `{KNOWLEDGE_DIR}` 下按需创建。示例：`runtime-errors/`、`conventions/`、`architecture-patterns/` 等。
