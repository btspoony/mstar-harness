# Phase 3: iteration-close（收口迭代）

> Loaded by `mstar-iteration` SKILL.md when entering Phase 3. **Read `mstar-harness-core` first.** Phase 2 全部 plan `Done` 后按 **Phase transition gates** 进入本 Phase。

PM 在迭代内全部 plan Done 后执行。**本 Phase 在 integration worktree（路径取 ACTIVE workflow 执行行的 `integration_worktree_path`；pre-activation：snapshot 字段）中运行**，产出物 commit 到 integration 分支，随迭代 PR 合入 workflow `branch.target`。入口：Phase 2 全部 plan `Done` 后按 **Phase transition gates** 进入。

**Close Done 定义**：§3.1→§3.5 完成；compass frontmatter `status: completed` + `end_date`；新增 knowledge doc 完成 store catalog 登记。README 仅散文，无登记行义务。final plan 的 compound / roadmap / PR 说明不替代 iteration-close。

## 3.0 Phase boundary（HARD）

- Phase 3 是 iteration 级收口，不是任一 plan 的子任务。
- final plan closure、plan notes、plan compaction 可作为输入，但不能替代 §3.1→§3.5。
- 读过 `mstar-iteration` / `mstar-compound` 不等于执行 gate；必须打印 checklist 并写入产物。

## 3.0.5 Compass shape normalization（legacy 漂移修复）

进入 §3.1 前，先确认 compass 具有 close 可写入的结构。若缺失，PM 在本 thread 做最小规范化，不委派、不重写无关内容。

| 检查 | 缺则补齐 |
|------|----------|
| YAML frontmatter：`iteration_id`, `start_date`, `status` | 从文件名 / 正文提取；收口前 `status` 保持 `active` 或 `locked` |
| `## Decisions` / `## Open Questions`（模板中紧跟 `## Scope`） | 从 general context / 正文迁移为本节，无内容则按模板补节；行处置 → `phase-1-prepare.md` §1.3 |
| `## Roadmap Position` | 从 general context / roadmap prose 迁移为本节 |
| `## Quality Gate Summary` | 按模板补占位，§3.4 填写 |
| `## Compound Round Summary` | 按模板补占位，§3.4 填写 |
| `## Iteration Retrospective (minimal)` | 按模板补占位，§3.4 填写 |

正文 completion status 只能作为历史注释；最终状态必须写入 frontmatter `status: completed` + `end_date`。

## 3.1 Close entry checklist（HARD GATE）

**STOP**: 打印下方 checklist，且全部为 `[x]` 后，才可进入 §3.2 Compound。

- [ ] compass 登记的全部 plan 在 ACTIVE `execution_plans` 均为 `Done`（经 `mstar status validate` / `mstar plan show`；pre-activation：snapshot 行）
- [ ] 各 plan 经 `mstar status findings-cleanup <plan-id>` 对 store linked open issues 按 Assignment mode 收口；`allow-residual` 下已捕获且披露的非阻断 issue 可保持 open，`zero-residual` 仅允许 blocker-defer + roadmap；关闭经 `mstar issue close|waive|duplicate|supersede`，不改退役 project register；unresolved `critical` 阻断（规则 → `mstar-artifacts` Findings cleanup modes）
- [ ] compass `## Plans` 表状态与当前权威执行行同步
- [ ] 迭代 `## Acceptance Criteria` 已达成或显式豁免（compass 或对话记录原因）
- [ ] compass shape 已满足（frontmatter + `## Roadmap Position` + close 占位节）

PM **必须**在对话中打印本 checklist；不得默认同过。

## 3.2 知识结晶（Compound）—— 迭代级核心收口

**Compound 在此执行，不在 per-plan Done 后独立执行。** 工作流 SSOT → **`mstar-compound`**（Q1–Q8、Phase 1–7、store catalog 发现/登记）。

PM 批量触发后须：

1. 收集本迭代 plan 实现 / debug / review 素材，筛候选知识
2. **盘点** `{ITERATION_DIR}/<iteration-id>/**` package（`guides/`、`specs/`；默认排除 `delivery-compass.md`）— **`mstar-compound`**「Iteration package promotion」；提升值得保留者进 `{KNOWLEDGE_DIR}/`
3. **specs 提升**：满足 `{SPECS_DIR}` 准入条件的已审 package specs（锁定、跨迭代成立、`primary_spec` / `spec_refs` 权威——`iteration-artifact-boundaries.md`「`{SPECS_DIR}/` 准入」）由 PM 以 compound 结构化重写（非整文件复制）**直接写入 integration worktree（`integration_worktree_path`，检出 `spec_integration_branch`）中 tracked 的 `{SPECS_DIR}/`**——主 checkout（control root）只承载 gitignored 进程产物；该写入随 §3.5 的 close commit 进入 integration 分支。提升同时完成既有登记面：package `README.md` 的 `Promoted to:` 标注、受影响 plan `primary_spec` / `spec_refs` 与 compass 引用指向提升后的权威路径，以及 catalog 登记（`mstar catalog register` / `mstar catalog link`——文档归属与 project/iteration 关系，contract §1/§4；登记指向提升后的 `{SPECS_DIR}` 权威路径，该文件在 close 与 PR review 期间位于 integration worktree 同路径，合并后随 integration 分支出现在各 checkout）
4. 逐条过 `mstar-compound` 自检；跳过项记入 compass `## Compound Round Summary`
5. 在 integration worktree 中写入或更新 tracked 的 `{KNOWLEDGE_DIR}/<category>/<slug>.md`（主 checkout 只承载 gitignored 进程产物；写入随 §3.5 的 close commit 进入 integration 分支）；新领域词更新同处的 `CONCEPTS.md`
6. **每篇**新 doc 完成 catalog 登记（`mstar catalog register` 或 reviewed `discover` → `import`），关系经 `mstar catalog link`；README 仅散文

若无结晶且无 package 提升，仍在 `## Compound Round Summary` 写明 `无可结晶知识` / package 盘点结论及原因。

## 3.3 更新 roadmap

1. 更新 compass **`## Roadmap Position`**（§3.0.5 已确保本节存在）：current iteration 标记为 **`delivered`**（或等价明确措辞），next iteration 记下即将开始的内容、触发条件和 owner。compass 是执行叙事，不是项目 roadmap 内容权威。
2. 对该 catalog project，从 roadmap 域**读** store 当前正文及 project/roadmap revisions。存在正文时**导出为独立 Markdown 候选**并编辑候选中的 status / goal items；已知项目无记录时明确创建新候选并在 replacement 中预期 absent，**不**从 `roadmap.md` 补读。review 后使用 revision-guarded roadmap replacement 更新完整正文；若版本变化，重读权威并重新 review，不能盲目重试。**绝不编辑 live `projects/<id>/roadmap.md`**。读写/校验的唯一规则家 → **`mstar-project-governance`**；命令选项 → built `mstar roadmap --help`。
3. 历史 `roadmap.md`、deferred-feature tracker 等文件若需保留只能是 import/export/历史记录；不作为这轮 close 的项目内容读写面。若 `STRATEGY.md` 存在，重大架构决策可更新其 `## Decision Log`。

At close, review the local ignored per-edit attribution record for this iteration against delivered edits and plan-QC references (`mstar-artifacts/references/plan-files-and-reports.md` § Edit attribution). Record actual correction time for a missed row and disclose the unobserved prior edit; unknown model remains `unknown`. Do not paste real runtime provenance into tracked artifacts or turn this review into a machine completeness check.

## 3.4 标记迭代完成

1. compass **YAML frontmatter**：`status: completed`，`end_date: YYYY-MM-DD`（必须；见 §3.0.5）
2. `{ITERATION_DIR}/README.md` 仅散文，不维护迭代状态登记行；catalog metadata 如需更新，经 `mstar catalog update` 按观察到的 revision 写入
3. 填充 compass `## Quality Gate Summary`、`## Compound Round Summary` 与 `## Iteration Retrospective (minimal)`（见模板）；`## Quality Gate Summary` 须含 residual 披露 —— 每个 plan 的 open R# 清单（id + severity + 跟踪位置 + blocker-defer 标记；无 open 时写 `N/A — none open`；unresolved `critical` 仍阻断完成）

## 3.5 Close exit checklist + commit

**Precondition**: §3.1 checklist `[x]`；§3.4 frontmatter `completed` + `end_date` 已写。

PM 打印 **iteration-close exit checklist**；全部为 `[x]` 后方可 `git commit`；然后进入 **Phase 4**（见 `references/phase-4-5-pr-delivery.md`）：

- [ ] §3.1 前置 gate 已打印并满足
- [ ] §3.2 compound 完成；package 已盘点（提升 / 保留 / 跳过已记入 Summary）；新增 knowledge doc 均完成 store catalog 登记（或记明无可结晶原因）
- [ ] §3.3 `## Roadmap Position` current iteration 已标 `delivered`；项目 roadmap 的 store 替换已以观察到的版本完成；STRATEGY 已按需更新
- [ ] §3.4 frontmatter `status: completed` + `end_date`；Quality Gate Summary（含 open R# 披露：id + severity + 跟踪位置 + blocker-defer 标记；无 open 时 `N/A — none open`；unresolved `critical` 仍阻断）+ Compound Summary + Retrospective 已填
- [ ] 当前分支是 `spec_integration_branch`
- [ ] PR base = 当前权威 workflow `branch.target`（ACTIVE：执行行；pre-activation：snapshot；与 compass 一致），不是未记录的 `main`

**Commit 前提（HARD — branch-anchored，防递交到主 checkout 驻留分支）**：§3.5 的 close commit **在 integration worktree（`integration_worktree_path`）中执行，**绝不**在主 checkout（control root）或任一 feature worktree 上执行**——`git commit` 落在**当前检出分支**，`<spec_integration_branch>` 只出现在 push 参数里。当执行 commit 的检出不在 integration 分支时，未经下述核对直接执行本配方，compound 会把 tracked 的 `{KNOWLEDGE_DIR}/`、`{SPECS_DIR}/`、`CONCEPTS.md` 递交到主 checkout 驻留分支（如 `main`），integration 分支的 PR 永远带不上这些 shared 产物。因此 **任何 `git add` 之前**必须先验分支；mismatch → **STOP**（不得 commit、不得 push、不得「先提交后挪」），改在正确检出上重做（见下）。

1. 解析 `<spec_integration_branch>`：ACTIVE workflow 执行行 `branch.integration`（pre-activation：snapshot 字段）→ 缺失时 compass frontmatter；仍缺 → STOP 按受守卫入口补齐，不默认 `main`。
2. **先验后提交**（在执行 commit 的检出处）：`git branch --show-current` === `<spec_integration_branch>`。§3.2–§3.4 产生的 tracked close 产物本就应处于未提交状态等待本 commit，**不要求**此处工作树干净。engine 可用 → 在 add/commit **前**运行 `mstar iteration gate --workflow <id> --compass <delivery-compass.md> --branch <current> --integration <spec_integration_branch> --target <target_branch>` 并确认 exit 无 `EXIT_BRANCH_MISMATCH` / `EXIT_PR_BASE_MISMATCH`（Phase-3 窗口预期的其它 exit-1 除外，见 Phase transition gates 注）。
3. **mismatch 时**：不产生任何提交。tracked 子树（`{KNOWLEDGE_DIR}/`、`{SPECS_DIR}/`、`CONCEPTS.md`、迭代 package 中 tracked 部分）的写入本就落在 **integration worktree**（检出 `<spec_integration_branch>` 的专用检出，§3.2 直写）；mismatch 时在正确检出的 integration worktree 重做这些写入，然后重跑本 checklist（进程产物 plans/iterations/status/sdd 为 gitignored 本地工件，经 control root 绝对路径读写，不受影响）。

**在 integration worktree（`integration_worktree_path`，检出 `<spec_integration_branch>`）中执行 —— never the primary checkout**：

```bash
git branch --show-current   # must print <spec_integration_branch> — mismatch → STOP, see above
git add {ITERATION_DIR}/<id>/ {ITERATION_DIR}/README.md {KNOWLEDGE_DIR}/ {SPECS_DIR}/ CONCEPTS.md
git add STRATEGY.md   # only if updated in §3.3 (tracked root file); skip line otherwise
git commit -m "chore(iteration): close <iteration-id> — compound round"
git push origin <spec_integration_branch>
```

Staging 说明：`{SPECS_DIR}` 为解析后的实际 specs 目录（候选链见 `mstar-conventions`，如 `{HARNESS_DIR}/specs/`、`docs/specs/`、`specs/`）；本轮更新过才加入。Roadmap store 变更是进程权威，不以 `git add` Markdown 文件代替；可供跨环境传递的 export 是 transport，不是本轮 close commit 的正文权威。

PR 目标使用当前权威 workflow `branch.target`；缺失时停止并按受守卫入口处理，不默认 `main`。

## 3.6 可选：触发 compound-refresh

若本轮 compound 新增了较多知识文档，或 compass 标记了可能过时的旧知识，触发 `mstar-compound-refresh` 对有重叠的知识文档做维护。
