# Done 计划行冷快照与 status.json 瘦身（Morning Star）

## 可选：`Done` 计划行冷快照（`{HARNESS_DIR}/archived/plans/`）

**背景**：多条 `Done` 的 `plans[]` 行常带大块 `metadata`（`gates`、QC 摘要、`tests`、`commits`、长 `scope`/`description`），`status.json` 会无限膨胀；而 **`metadata.residual_findings` 中 open 项**宜保持有界（已关闭项应迁出至 **`{HARNESS_DIR}/archived/residuals/`**，见 `status-and-residuals.md`）。

**定位**：**`{HARNESS_DIR}/status.json`** 仍为**当前执行**的 SSOT（非终态计划、根 `metadata`、**open** 的 `residual_findings`）。本节为**可选**做法：在**不破坏可到达性**（快照文件须提交进仓库）的前提下给热文件瘦身。

**冷存储路径**：`{HARNESS_DIR}/archived/plans/<plan-id>.json`

**快照内容**：将该 plan 标为 `Done` 时，**完整的**对应 `plans[]` 元素（含当时全部 `metadata`），供审计与 handoff。

**与 residual 归档的关系**：**`{HARNESS_DIR}/archived/residuals/<plan-id>.json`** 存**已关闭 finding 行**；**`{HARNESS_DIR}/archived/plans/<plan-id>.json`** 存**计划行快照**。不要把计划快照当作 **open** `residual_findings` 的第二份权威来源。

## Profile A（默认）— 热文件保留瘦 `Done` 行

- **最小集**（机器导航够用）：**`id`**、**`status`**（`Done`）、**`file`**（主 plan 路径）、**`metadata`** 仅含：
  - **`archived_record`**：相对 **`{HARNESS_DIR}`** 的路径，例如 `archived/plans/<plan-id>.json`（冷快照内为**完整**当时 `plans[]` 元素，含臃肿字段）
  - 若该 `plan-id` 在 **`metadata.residual_findings`** 中仍有 **open** 行，在 **`metadata`** 内保留 **`residual_summary`**（语义见 `status-and-residuals.md` **`residual_summary`（可选）** 小节）
- **可选**（人类扫表友好，非必须）：**`title`** 一行、**`done_at`**；勿把长叙述塞回热行——放进 **`{HARNESS_DIR}/notes.json`** 或依赖冷快照 / `reports/`。
- 一旦快照已写入，热行**不得**再承载完整 `gates`、`qc_status`、`tests`、`commits`、长 `description`/`scope` 等；**以 `archived_record` 指向文件为准**。
- 单条 **`plans[].notes`** 字符串若仍在用，保持**极短**（如指向 `reports/<plan-id>/`）；**不要**重复 QC 报告大段原文。

## Profile B（可选）— 热文件不保留任何 `Done` 行（统一压缩）

- **Done 快照路径**：`{HARNESS_DIR}/archived/plans/<plan-id>.json`（保存完整 `plans[]` 行快照）。
- **Done 目录路径**：`{HARNESS_DIR}/archived/plans-done.json`（最小索引，便于统一发现已完成计划）。
- **`plans-done.json` 推荐最小字段**：`id`、`title`、`done_at`、`plan_file`、`archived_record`。
- **热文件行为**：`status.json.plans[]` 只保留非 `Done`（`Todo` / `InProgress` / `InReview` / `Blocked`）；计划变为 `Done` 后，从热文件移除该行。
- **读取约定**：当前执行状态读取 `status.json`；历史 `Done` 列表读取 `archived/plans-done.json`，详情读取 `archived/plans/<plan-id>.json`。

## 原子更新约束（Profile A / B 通用）

- 将计划标记为 `Done` 时，冷快照写入与 `status.json` 更新应在**同一变更集**完成（或紧随合并后一次性完成）。
- 采用 **Profile B** 时，必须在同一变更集中同时完成：  
  1) 写入/更新 `archived/plans/<plan-id>.json`，  
  2) 写入/更新 `archived/plans-done.json`，  
  3) 从 `status.json.plans[]` 删除该 `Done` 行。  
- 若无法满足以上三步，视为未完成 `Done` 收口，不应宣称已完成压缩迁移。

**可选索引**：`{HARNESS_DIR}/archived/plans/_index.json` — `plan-id` → 相对路径，便于不依赖 glob 的工具。

**可选滚动保留**：进一步缩小 `plans[]` 时，可只在热文件中保留**最近窗口**的瘦 `Done` 行，更旧 id 仅出现在 `_index.json` 与快照文件中；若采用，须在项目 `AGENTS.md` 中写明，并检查依赖「热文件中必有全部历史 id」的脚本。

## 采纳说明

- 未写快照、热文件中仍保留完整 `Done` 行在历史仓库里依然可读；但新落地时建议先确定并固定使用 **Profile A** 或 **Profile B**，避免同仓混跑。
- 从 Profile A 迁到 Profile B 前，先检查依赖 `status.json.plans[]` 扫描全部历史 `Done` 的脚本与流程，必要时先切换读取源到 `archived/plans-done.json`。

## 仓库级采用声明模板（贴到项目 `AGENTS.md`）

### Template A（默认，保留瘦 Done 行）

```markdown
### Plan compaction profile (this repository)

This repository uses **Profile A** from the Morning Star `mstar-plan-conventions` skill (`references/done-compaction.md`).

- `status.json.plans[]` keeps active plans and may keep **slim `Done` rows**.
- `archived/plans/<plan-id>.json` is used as cold snapshot when available.
- Historical tooling may read both `status.json.plans[]` and `archived/plans/`.
```

### Template B（统一压缩，不保留 Done 行）

```markdown
### Plan compaction profile (this repository)

This repository uses **Profile B** from the Morning Star `mstar-plan-conventions` skill (`references/done-compaction.md`).

- `status.json.plans[]` keeps **non-`Done`** plans only.
- Every `Done` plan MUST be represented in:
  - `archived/plans/<plan-id>.json` (full snapshot), and
  - `archived/plans-done.json` (minimal catalog).
- Historical `Done` discovery MUST read `archived/plans-done.json`, not `status.json.plans[]`.
```
