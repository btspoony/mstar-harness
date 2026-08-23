---
name: mstar-project-governance
description: Morning Star 项目治理层约定 —— `projects/<id>/roadmap.md` 编写约定（frontmatter schema + body 约定）与 `projects/<id>/residuals.json` register 生命周期（open → verified close in place、severity 枚举、provenance 字段）、`_default` 项目回退规则。写/审 roadmap、登记或关闭 residual、判断项目归属（含无项目流程的 `_default` fallback）、或对齐 roadmap/register 与 engine 校验时 Read。schema 事实与 `packages/engine/src/project.ts` 逐字一致；字段语义 SSOT → `mstar-artifacts`；路径符号 → `mstar-conventions`。
---

# mstar-project-governance（项目治理层：roadmap + register）

## Load Order

- 先 Read **`mstar-harness-core`**（SKILL.md；冲突时以 core 为准）。
- 路径符号（`{PROJECT_DIR}` / `{WORKFLOW_DIR}` 解析与 `.mstarc` 声明）→ **`mstar-conventions`**。
- 字段语义 SSOT（severity 含义、findings cleanup modes、close 协议全文、engine-check 查询）→ **`mstar-artifacts`**（`references/status-and-residuals.md`）。本 skill 只承载**编写约定与生命周期规则**，不重复字段全文。

## Scope

项目层 = `{PROJECT_DIR}/<id>/`（默认 `{HARNESS_DIR}/projects/<id>/`；`.mstarc` `project_dir` 声明时用声明值）：

| 文件 | 内容 |
|------|------|
| `roadmap.md` | 项目方向与目标（frontmatter machine-checkable + body 约定） |
| `residuals.json` | 项目 register：open residual 的 **SSOT**（`entries[<plan-id>]` 数组） |
| `references/` | 主题化研究语料（surveys / epic 备注 / 第三方 notes）。与 `{SPECS_DIR}`（冻结规格/ADR）、`{KNOWLEDGE_DIR}`（compound 结晶实现 SSOT）、`{ITERATION_DIR}`（迭代 package）**不同**；engine 只列文件名（`listProjectReferenceFiles`），**不做** markdown schema 校验 |

- **`_default` 回退**：无项目流程（未指定 project id 的 plan / 单 plan / hotfix）落到 **`projects/_default/`**（engine `_DEFAULT_PROJECT`）。项目归属由 plan 的 project id 决定；未归属即 `_default`。
- 本 skill 的 schema 事实与 **`packages/engine/src/project.ts`** 逐字一致（`validateRoadmap` / `validateProjectRegister` / `findingsCleanupGate` / `techDebtRollup`）；技能文本是语义 SSOT，engine 是确定性校验。

## Roadmap 编写约定（`projects/<id>/roadmap.md`）

### Frontmatter schema（machine-checkable；engine `validateRoadmap`）

```markdown
---
project_id: <id>
title: <title>
status: active | paused | completed
created_at: YYYY-MM-DD
milestones: [ ... ]        # optional
residuals_ref: residuals.json  # optional
---

# <title>

## Direction
...
```

| 字段 | 必填 | 规则 |
|------|------|------|
| `project_id` | 是 | 非空字符串 |
| `title` | 是 | 非空字符串 |
| `status` | 是 | 枚举 `active | paused | completed`（其他值 = violation） |
| `created_at` | 是 | `YYYY-MM-DD` |
| `milestones` | 否 | 非空字符串列表（空 `milestones:` 视同缺省） |
| `residuals_ref` | 否 | 非空字符串（指向 register 文件，如 `residuals.json`） |

### Body 约定（warnings only —— 永不翻转 `ok`）

- 应有 **`## Direction`** 小节陈述项目方向。
- 目标项以 markdown task-list 列出：`- [ ]` 计划/进行中，`- [x]` 已交付。
- **无 residual→goal 自动链接**（本迭代 Non-Goal）：goal items 不携带 register id；residual 与目标的对齐是人工约定，不是硬门禁。

> **Engine check (when available):** import `validateRoadmap` from `@mstar-harness/engine` in a host hook（无 CLI 命令）校验 `projects/<id>/roadmap.md`。On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## Register 生命周期（`projects/<id>/residuals.json`）

### 文档形状、必填字段与枚举（单址 → `mstar-artifacts`）

Register 文档形状（`entries[<plan-id>]` 数组 JSON）、**9 个必填字段**（`id`/`title`/`severity`/`source`/`scope`/`decision`/`owner`/`target`/`tracking`，engine `RESIDUAL_REQUIRED_FIELDS`）与 **severity / decision / lifecycle 枚举**的逐字 schema → **`mstar-artifacts`** `references/status-and-residuals.md`（「Basic structure · project register」+「Residual findings: severity」）。本 skill 只承载编写约定与生命周期规则，**不重复字段全文**。

- `entries[<plan-id>]` 值是**数组** —— v1 `residual_findings[plan-id]` 多 finding 语义逐字保留（一个 plan 可持 2+ open residual）。
- 每条 = v1 residual entry **逐字** + provenance 字段。

### 生命周期：open → verified close（in place）

- **open**：缺省状态；`lifecycle` 缺省/`false`/`null` = `open`。
- **close（唯一关闭路径）**：在 register **in place** 置 `lifecycle`（≠ `open`）+ `closed_at`（`YYYY-MM-DD`）+ `closure_note`；推荐 `closure_evidence`。v1 的 `archived/residuals/` 归档路径与 `status archive-residuals` 已移除（该命令现为报错桩，指向 register 状态变更）。
- **closed 完整性**：`lifecycle` ≠ `open` 时缺 `closed_at` / `closure_note` = violation。
- **谁更新**：PM 在 consolidated 决策后分配 R# 并登记；`QA gate: mandatory` 时 `qa-engineer` 验证后关闭；`pm-acceptance` 时 PM 验收清单完成后关闭。
- close 协议全文 → **`mstar-artifacts`** `references/status-and-residuals.md`（「Residual findings lifecycle」）。

### Provenance（register 专属字段）

| 字段 | 规则 |
|------|------|
| `source_plan` | 必填非空字符串；**必须等于其 entries key**（不匹配 = 损坏的 provenance，violation） |
| `registered_at` | 必填 `YYYY-MM-DD` |
| `lifecycle_id` | 可选非空字符串（迭代拥有该 plan 时的 workflow id） |

### Findings cleanup（与 Assignment 联动）

- Assignment **`Findings cleanup: zero-residual | allow-residual`** 是唯一 mode 来源（`metadata.findings_cleanup` mirror 已删）；迭代 Phase 2 默认 `zero-residual`。
- `zero-residual`：可修 findings 当轮 fix → re-review 清干净；仅真 blocker 可 defer 且须 Durable Roadmap + `target`；`nit` 必须当场修或删；waived/risk-accepted 必须关闭，不得留 open。
- `allow-residual`：仅 unresolved **critical** 阻止 Approve。
- mode 全文与 enforcement → **`mstar-artifacts`** `references/status-and-residuals.md`（「Findings cleanup modes」+ 其 engine check）。

## Workflow

1. 确定项目归属：plan 的 project id（无 → `_default`）。
2. 写/审 roadmap：frontmatter 过 `validateRoadmap`（schema violations 决定 `ok`；body 约定缺失只出 warnings）。
3. 登记 residual：新 finding 只写 `{PROJECT_DIR}/<id>/residuals.json` → `entries[<plan-id>]`，登记前过 `validateResidual` / `validateProjectRegister`（fail-loud）。
4. 关闭：验证后 in place 置 `lifecycle` / `closed_at` / `closure_note`。
5. 汇总：`mstar status tech-debt [<project-dir>]` 打印跨 register 的 rollup（total_open / by_severity / by_target / by_plan）。

## Decision Rules

- **只写 v2 地址**：open residual 只登记 project register；v1 根级 `residual_findings` 仅 legacy 只读（`mstar migrate` 一次性迁移），**禁止双写**。
- **fail-loud handoff**：登记前必须过 engine 校验；malformed → reject + rewrite，绝不静默降级写入。
- **severity 是机器字段**：QC 报告的 Critical / Warning / Suggestion 是**章节标题**，不得逐字抄入 JSON `severity`。
- **`_default` 不豁免校验**：无项目流程同样走 register（`projects/_default/residuals.json`），schema 与生命周期规则不变。

## Evidence

正确结果 = 可复核产物：`projects/<id>/roadmap.md` 过 `validateRoadmap`（0 violations；warnings 可接受）、`projects/<id>/residuals.json` 过 `validateProjectRegister`、`mstar status findings-cleanup <plan-id>` 按 Assignment mode 绿、`mstar status tech-debt` 输出与 register 一致。拒绝「仅对话声称」。

## References

- **`mstar-artifacts`**（`references/status-and-residuals.md`）— 字段语义 SSOT：severity 含义与门禁关系、findings cleanup modes 全文、close 协议、engine-check 查询示例
- **`mstar-conventions`** — `{PROJECT_DIR}` / `{WORKFLOW_DIR}` 路径符号、`.mstarc` 声明、gitignore 策略
- **`mstar-review-qc`** — PM QC 编排与 residual 留档（PM 同轮必读）
