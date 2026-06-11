# Done 计划行冷快照与 status.json 瘦身（Morning Star）

> **Load order（与其它 `mstar-*` skill 一致）**：依赖本 reference 做 Done 瘦身 / 归档前，须已 Read **`mstar-harness-core`** skill（SKILL.md）与 **`mstar-plan-conventions`** SKILL.md（plan SSOT 总线）。合并与分支事实仍受 **`mstar-branch-worktree`** 约束。

## 可选：`Done` 计划行冷快照（`{HARNESS_DIR}/archived/plans/`）

**背景**：多条 `Done` 的 `plans[]` 行常带大块 `metadata`（`gates`、QC 摘要、`tests`、`commits`、长 `scope`/`description`），`status.json` 会无限膨胀；而**根级 `residual_findings` 中的 open 项**（canonical 见 `mstar-plan-artifacts` **SKILL.md** 开篇）宜保持有界（已关闭项应迁出至 **`{HARNESS_DIR}/archived/residuals/`**，见 `mstar-plan-artifacts/references/status-and-residuals.md`）。

**定位**：**`{HARNESS_DIR}/status.json`** 仍为**当前执行**的 SSOT（非终态计划、根 `metadata`、**open** 的 `residual_findings`）。本节为**可选**做法：在**不破坏可到达性**（快照文件须提交进仓库）的前提下给热文件瘦身。

**冷存储路径**：`{HARNESS_DIR}/archived/plans/<plan-id>.json`

**快照内容**：将该 plan 标为 `Done` 时，**完整的**对应 `plans[]` 元素（含当时全部 `metadata`），供审计与 handoff。

**与 residual 归档的关系**：**`{HARNESS_DIR}/archived/residuals/<plan-id>.json`** 存**已关闭 finding 行**；**`{HARNESS_DIR}/archived/plans/<plan-id>.json`** 存**计划行快照**。不要把计划快照当作 **open** `residual_findings` 的第二份权威来源。

## Profile A（默认）— 热文件保留瘦 `Done` 行

- **最小集**（机器导航够用）：**`id`**、**`status`**（`Done`）、**`file`**（主 plan 路径）、**`metadata`** 仅含：
  - **`archived_record`**：相对 **`{HARNESS_DIR}`** 的路径，例如 `archived/plans/<plan-id>.json`（冷快照内为**完整**当时 `plans[]` 元素，含臃肿字段）
  - 若该 `plan-id` 在 **open 列表**（根级 **`residual_findings`**；若仅存 legacy 侧则同口径）中仍有 **open** 行，在 **`metadata`** 内保留 **`residual_summary`**（语义见 `status-and-residuals.md` **`residual_summary`（可选）** 小节）
- **可选**（人类扫表友好，非必须）：**`title`** 一行、**`done_at`**；勿把长叙述塞回热行——放进 **`{HARNESS_DIR}/notes.json`** 或依赖冷快照 / `reports/`。
- 一旦快照已写入，热行**不得**再承载完整 `gates`、`qc_status`、`tests`、`commits`、长 `description`/`scope` 等；**以 `archived_record` 指向文件为准**。
- 单条 **`plans[].notes`** 字符串若仍在用，保持**极短**（如指向 `reports/<plan-id>/`）；**不要**重复 QC 报告大段原文。
- **可选索引**：`{HARNESS_DIR}/archived/plans/_index.json` — `plan-id` → 相对路径，便于不依赖 glob 的工具。
- **可选滚动保留**：进一步缩小 `plans[]` 时，可只在热文件中保留**最近窗口**的瘦 `Done` 行，更旧 id 仅出现在 `_index.json` 与快照文件中；若采用，须在项目 `AGENTS.md` 中写明，并检查依赖「热文件中必有全部历史 id」的脚本。

## Profile B（可选）— 热文件不保留任何 `Done` 行（统一压缩）

- **Done 快照路径**：`{HARNESS_DIR}/archived/plans/<plan-id>.json` — 单个 **`plans[]` 行对象**（含当时全部 `metadata`）；**不是**包装层，勿再套 `plan_id` / `snapshot` 外壳。
- **Done 目录路径**：`{HARNESS_DIR}/archived/plans-done.json` — **仅** plan id 列表（见下）；**勿**使用 `_index.json`、对象数组目录或其它并行索引。
- **`plans-done.json` schema（唯一权威；不得扩展）**：

```json
{
  "plans": ["01-data-infrastructure", "02-auth-refactor"]
}
```

  - 根对象**只允许**键 **`plans`**（字符串数组）。
  - 数组元素为 **`plans[].id`**（= `archived/plans/<plan-id>.json` 的 basename；通常亦为主 plan `.md` 去扩展名）。
  - 标题、`done_at`、主 plan 路径、`archived_record` 等**只**存在于 `archived/plans/<plan-id>.json` 快照内。
  - 初始化：`mstar-plan-artifacts/templates/plans-done.empty.json` → `{ "plans": [] }`。
- **热文件行为**：`status.json.plans[]` 只保留非 `Done`；`Done` 后从热文件**删除**该行。
- **读取约定**：活跃计划 → `status.json`；历史 Done id 列表 → `plans-done.json`.`plans`；单条详情 → `archived/plans/<plan-id>.json`（路径由 id 拼接，**不**读目录内嵌路径字段）。

## 原子更新约束（Profile A / B 通用）

- 将计划标记为 `Done` 时，冷快照写入与 `status.json` 更新应在**同一变更集**完成（或紧随合并后一次性完成）。
- 采用 **Profile B** 时，必须在同一变更集中同时完成：  
  1) 写入/更新 `archived/plans/<plan-id>.json`，  
  2) 将 `<plan-id>` 追加进 `archived/plans-done.json` 的 **`plans`** 数组（去重；勿写额外字段），  
  3) 从 `status.json.plans[]` 删除该 `Done` 行。  
- 若无法满足以上三步，视为未完成 `Done` 收口，不应宣称已完成压缩迁移。

## 采纳说明

- 未写快照、热文件中仍保留完整 `Done` 行在历史仓库里依然可读；但新落地时建议先确定并固定使用 **Profile A** 或 **Profile B**，避免同仓混跑。
- 从 Profile A 迁到 Profile B 前，先检查依赖 `status.json.plans[]` 扫描全部历史 `Done` 的脚本与流程，并改为读取 `archived/plans-done.json`.`plans`。
- 若仓库 `plans-done.json` 仍为非 `{ "plans": [...] }` 形态（例如对象数组、顶层 `entries`/`catalog`），**整文件改写**为仅 id 列表；勿保留兼容层或双写富字段。

## 仓库级采用声明模板（贴到项目 `AGENTS.md`）

### Template A（默认，保留瘦 Done 行）

```markdown
### Plan compaction profile (this repository)

This repository uses **Profile A** from the Morning Star `mstar-plan-artifacts` skill (`references/done-compaction.md`).

- `status.json.plans[]` keeps active plans and may keep **slim `Done` rows**.
- `archived/plans/<plan-id>.json` is used as cold snapshot when available.
- Historical tooling may read both `status.json.plans[]` and `archived/plans/`.
```

### Template B（统一压缩，不保留 Done 行）

```markdown
### Plan compaction profile (this repository)

This repository uses **Profile B** from the Morning Star `mstar-plan-artifacts` skill (`references/done-compaction.md`).

- `status.json.plans[]` keeps **non-`Done`** plans only.
- Every `Done` plan MUST be represented in:
  - `archived/plans/<plan-id>.json` (full snapshot), and
  - `archived/plans-done.json` (`{ "plans": ["<plan-id>", ...] }` only).
- Historical `Done` discovery MUST read `archived/plans-done.json` **`plans`**, not `status.json.plans[]`; per-plan detail from `archived/plans/<plan-id>.json`.
```
