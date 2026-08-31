# Phase 3: iteration-close（收口迭代）

> Loaded by `mstar-iteration` SKILL.md when entering Phase 3. **Read `mstar-harness-core` first.** Phase 2 全部 plan `Done` 后按 **Phase transition gates** 进入本 Phase。

PM 在迭代内全部 plan Done 后执行。**本 Phase 在 integration 分支上运行**，产出物 commit 到 integration 分支，随迭代 PR 合入 snapshot `branch.target`（`target_branch`）。入口：Phase 2 全部 plan `Done` 后按 **Phase transition gates** 进入。

**Close Done 定义**：§3.1→§3.5 全部完成；compass frontmatter 写入 `status: completed` + `end_date`；每篇新增 knowledge doc 已登记 `{KNOWLEDGE_DIR}/README.md`。只在 final plan 中写了 compound / roadmap / PR 说明，不算 iteration-close 完成。

## 3.0 Phase boundary（HARD）

- Phase 3 是 iteration 级收口，不是任一 plan 的子任务。
- final plan closure、plan notes、plan compaction 可作为输入，但不能替代 §3.1→§3.5。
- 读过 `mstar-iteration` / `mstar-compound` 不等于执行 gate；必须打印 checklist 并写入产物。

## 3.0.5 Compass shape normalization（legacy 漂移修复）

进入 §3.1 前，先确认 compass 具有 close 可写入的结构。若缺失，PM 在本 thread 做最小规范化，不委派、不重写无关内容。

| 检查 | 缺则补齐 |
|------|----------|
| YAML frontmatter：`iteration_id`, `start_date`, `status` | 从文件名 / 正文提取；收口前 `status` 保持 `active` 或 `locked` |
| `## Roadmap Position` | 从 general context / roadmap prose 迁移为本节 |
| `## Quality Gate Summary` | 按模板补占位，§3.4 填写 |
| `## Compound Round Summary` | 按模板补占位，§3.4 填写 |
| `## Iteration Retrospective (minimal)` | 按模板补占位，§3.4 填写 |

正文 completion status 只能作为历史注释；最终状态必须写入 frontmatter `status: completed` + `end_date`。

## 3.1 Close entry checklist（HARD GATE）

**STOP**: 打印下方 checklist，且全部为 `[x]` 后，才可进入 §3.2 Compound。

- [ ] 所有 compass 中登记的 plan 在 workflow snapshot（`{WORKFLOW_DIR}/<id>/snapshot.json`）均为 `Done`
- [ ] 所有 plan 的 residual findings 已收口：优先 empty register 条目（`projects/<id>/residuals.json` → `entries[<plan-id>]`）；若仍有 open R#，须均为 Phase 2 `zero-residual` 允许的 blocker-defer + roadmap，或已 closed（`lifecycle` / `closed_at` / `closure_note`，见 `mstar-artifacts` Findings cleanup modes）
- [ ] compass `## Plans` 表状态列已与 snapshot 同步
- [ ] 迭代 `## Acceptance Criteria` 已达成或显式豁免（compass 或对话记录原因）
- [ ] compass shape 已满足（frontmatter + `## Roadmap Position` + close 占位节）

PM **必须**在对话中打印本 checklist；不得默认同过。

## 3.2 知识结晶（Compound）—— 迭代级核心收口

**Compound 在此执行，不在 per-plan Done 后独立执行。** 工作流 SSOT → **`mstar-compound`**（Q1–Q8 自检、Phase 1–7、Phase 6 索引登记强制）。

PM 批量触发后须：

1. 收集本迭代 plan 实现 / debug / review 素材，筛候选知识
2. **盘点** `{ITERATION_DIR}/<iteration-id>/**` package（`guides/`、`specs/`；默认排除 `delivery-compass.md`）— **`mstar-compound`**「Iteration package promotion」；提升值得保留者进 `{KNOWLEDGE_DIR}/`
3. 逐条过 `mstar-compound` 自检；跳过项记入 compass `## Compound Round Summary`
4. 写入或更新 `{KNOWLEDGE_DIR}/<category>/<slug>.md`；新领域词更新 `CONCEPTS.md`
5. **每篇**新 doc 完成 Phase 6（`{KNOWLEDGE_DIR}/README.md` 登记）

若无结晶且无 package 提升，仍在 `## Compound Round Summary` 写明 `无可结晶知识` / package 盘点结论及原因。

## 3.3 更新 roadmap

1. 更新 compass **`## Roadmap Position`**（§3.0.5 已确保本节存在）：
   - current iteration 行标记为 **`delivered`**（或等价明确措辞）
   - next iteration 更新为即将开始的内容、触发条件、owner
2. 若项目层 roadmap（`{PROJECT_DIR}/<id>/roadmap.md`）存在，同步更新（frontmatter `status` / goal-item checkboxes）；若 snapshot plan 行含 `metadata.roadmap` 字段，同步更新
3. 若存在 deferred-features / roadmap tracker 类文档，按项目惯例刷新
4. 若 `STRATEGY.md` 存在，可更新 `## Decision Log`（重大架构决策时）

## 3.4 标记迭代完成

1. compass **YAML frontmatter**：`status: completed`，`end_date: YYYY-MM-DD`（必须；见 §3.0.5）
2. 更新 `{ITERATION_DIR}/README.md` 索引中该迭代行 Status 为 `completed`
3. 填充 compass `## Quality Gate Summary`、`## Compound Round Summary` 与 `## Iteration Retrospective (minimal)`（见模板）

## 3.5 Close exit checklist + commit

**Precondition**: §3.1 checklist `[x]`；§3.4 frontmatter `completed` + `end_date` 已写。

PM 打印 **iteration-close exit checklist**；全部为 `[x]` 后方可 `git commit`；然后进入 **Phase 4**（见 `references/phase-4-5-pr-delivery.md`）：

- [ ] §3.1 前置 gate 已打印并满足
- [ ] §3.2 compound 完成；**`<iteration-id>/` package 已盘点**（提升 / 保留 / 跳过已记入 Compound Summary）；新增 knowledge doc 均已登记 `{KNOWLEDGE_DIR}/README.md`（或已记录无可结晶原因）
- [ ] §3.3 `## Roadmap Position` current iteration 已标 `delivered`；tracker / STRATEGY 已按需更新
- [ ] §3.4 frontmatter `status: completed` + `end_date`；Quality Gate Summary + Compound Summary + Retrospective 已填
- [ ] 当前分支是 `spec_integration_branch`
- [ ] PR base = snapshot `branch.target`（`target_branch`，与 compass frontmatter 一致）；**不是**未记录的 `main`

**Commit 前提（HARD — branch-anchored，防递交到控制分支）**：§3.5 的 commit 是 **branch 锚定**的——`git commit` 落在**当前检出分支**，`<spec_integration_branch>` 只出现在 push 参数里。当控制 worktree（或任一检出）不在 integration 分支时，未经下述核对直接执行本配方，compound 会把 tracked 的 `{KNOWLEDGE_DIR}/`、`{SPECS_DIR}/`、`CONCEPTS.md` 递交到控制分支（如 `main`），integration 分支的 PR 永远带不上这些 shared 产物。因此 **任何 `git add` 之前**必须先验分支；mismatch → **STOP**（不得 commit、不得 push、不得「先提交后挪」），改在正确检出上重做（见下）。

1. 解析 `<spec_integration_branch>`：snapshot `branch.integration`（workflows/<id>/snapshot.json）→ 缺失时 compass frontmatter `spec_integration_branch`；仍缺 → STOP 补齐，不得默认 `main`。
2. **先验后提交**（在执行 commit 的检出处）：`git branch --show-current` === `<spec_integration_branch>`。§3.2–§3.4 产生的 tracked close 产物本就应处于未提交状态等待本 commit，**不要求**此处工作树干净。engine 可用 → 在 add/commit **前**运行 `mstar iteration gate --workflow <id> --compass <delivery-compass.md> --branch <current> --integration <spec_integration_branch> --target <target_branch>` 并确认 exit 无 `EXIT_BRANCH_MISMATCH` / `EXIT_PR_BASE_MISMATCH`（Phase-3 窗口预期的其它 exit-1 除外，见 Phase transition gates 注）。
3. **mismatch 时**：不产生任何提交。tracked 子树（`{KNOWLEDGE_DIR}/`、`{SPECS_DIR}/`、`CONCEPTS.md`、迭代 package 中 tracked 部分）在**检出 `<spec_integration_branch>` 的 worktree** 重新写入或在 commit 前恢复（它们默认 tracked、随 Git 分支走；进程产物 plans/iterations/status/sdd 经 control 绝对路径不受影响）。然后重跑本 checklist。

**在 `<spec_integration_branch>` 检出上执行**：

```bash
git branch --show-current   # must print <spec_integration_branch> — mismatch → STOP, see above
git add {ITERATION_DIR}/<id>/ {ITERATION_DIR}/README.md {KNOWLEDGE_DIR}/ {SPECS_DIR}/ CONCEPTS.md
git add STRATEGY.md   # only if updated in §3.3 (tracked root file); skip line otherwise
git commit -m "chore(iteration): close <iteration-id> — compound round, roadmap update"
git push origin <spec_integration_branch>
```

Staging 说明：`{SPECS_DIR}` 为解析后的实际 specs 目录（候选链见 `mstar-conventions`，如 `{HARNESS_DIR}/specs/`、`docs/specs/`、`specs/`）；本轮更新过才加入。§3.3 更新过的 tracked 项目层 roadmap tracker 若为 tracked 文件，一并 stage（gitignored 的 process 产物不进 commit）。

PR 目标使用 snapshot `branch.target`；缺失时停止并补齐，不得默认 `main`。

## 3.6 可选：触发 compound-refresh

若本轮 compound 新增了较多知识文档，或 compass 标记了可能过时的旧知识，触发 `mstar-compound-refresh` 对有重叠的知识文档做维护。
