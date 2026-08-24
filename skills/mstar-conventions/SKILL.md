---
name: mstar-conventions
description: Morning Star (启明星) harness 计划目录约定 —— `{HARNESS_DIR}` / `{PLAN_DIR}` / `{SDD_DIR}` / `{ITERATION_DIR}` / `{KNOWLEDGE_DIR}` / `{SPECS_DIR}` / `{WORKFLOW_DIR}` / `{PROJECT_DIR}` 发现与初始化（默认 `.mstar/`，兼容 `.agents/`）、`docs` 与 harness 子树边界、review bundle、未启用 plan 时的工作方式、Spec 集成分支与多 Plan 实现分支（显式 base / merge 靶 / PR target）、Morning Star plan-writing path gate、工期预估（agent-oriented）。**必须**在读写 `.mstar/` / `.agents/`、初始化 harness、编排含 plan 的任务、或对齐 `metadata.primary_spec` 时 Read；`@project-manager` 开 plan 任务前必读。plan 文件 / status / residual / review bundle / knowledge → **`mstar-artifacts`**；分支与 QC 检出 → **`mstar-branch-worktree`**。
---

## Load order（必读顺序）

**首次 Read 本 skill 前：必须先 Read `mstar-harness-core`（SKILL.md）。** 本 skill 只约定 **目录与路径**；不突破状态机与门禁。冲突时 **以 `mstar-harness-core` 为准**。

| 你还可能要 Read | 何时 |
|-----------------|------|
| `mstar-artifacts` | 主 plan、review bundle 摘要、`status.json`、residual、InReview/QC 波次、knowledge |
| `mstar-project-governance` | `projects/<id>/roadmap.md` 编写约定 + `residuals.json` register 生命周期、`_default` 回退 |
| `mstar-branch-worktree` | Assignment 写分支 / worktree / QC 检出 |
| `mstar-review-qc` | 派 QC（PM 同轮必读；SDD 强制 tri） |
| `mstar-sdd` | PM 执行 `Execution mode: sdd` 的 implement 波次 |

## Workflow

主链：按「路径符号」+「`{HARNESS_DIR}` 解析顺序」确定目录（默认 `.mstar/`，兼容 `.agents/`）→ 按「初始化 Plan 目录」建 `plans/` / `status.json` 并追加 gitignore 进程产物集（进程本地、结果共享）→ 多 Plan · 同一 Spec 时按「Spec 驱动的分支模型」登记 iteration base / spec 集成分支 / 各 Plan 实现分支 / PR target → 主 plan 写入 `{PLAN_DIR}`（**Plan-Writing Path Gate**，不引入外部默认 plan 目录）。未启用 plan 时 → 对话追踪，门禁（QC/QA）照常。

## 路径符号（SSOT）

| 符号 | 默认 |
|------|------|
| `{HARNESS_DIR}` | `.mstar/` |
| `{PLAN_DIR}` | `{HARNESS_DIR}/plans/` |
| `{SDD_DIR}` | `{HARNESS_DIR}/sdd/<plan-id>/`（SDD 运行时 scratch + review bundle；gitignored） |
| `{ITERATION_DIR}` | `{HARNESS_DIR}/iterations/` |
| `{KNOWLEDGE_DIR}` | `{HARNESS_DIR}/knowledge/`（默认；`.mstarc` `knowledge_dir` 声明时用声明值） |
| `{SPECS_DIR}` | `{HARNESS_DIR}/specs/`（默认）；解析见下文「`{SPECS_DIR}` 解析」 |
| `{WORKFLOW_DIR}` | `{HARNESS_DIR}/workflows/`（默认；`.mstarc` `workflow_dir` 声明时用声明值）——v3 每 lifecycle 一个 `workflows/<id>/`（`snapshot.json` + `notes.jsonl`） |
| `{PROJECT_DIR}` | `{HARNESS_DIR}/projects/`（默认；`.mstarc` `project_dir` 声明时用声明值）——v3 项目层 `projects/<id>/roadmap.md` + `residuals.json` |

> **Engine check (when available):** import `resolveHarnessDir` / `resolvePlanDir` / `resolveSddDir` / `resolveIterationDir` / `resolveKnowledgeDir` / `resolveSpecsDir` / `resolveWorkflowDir` / `resolveProjectDir` from `@mstar-harness/engine` in a host hook — or run `mstar path resolve [path]` (`--json` for machine output) to print the resolved dirs — to confirm the resolution below. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

### `{HARNESS_DIR}` 解析顺序（找到即停；探测**永不越过工作区根**——CLI=start 的 git top-level（非 git→start 自身）；dsh=会话工作区）

1. 显式 override：`opts.harnessDir` / `MSTAR_HARNESS_DIR`（全权优先，短路一切探测与配置文件）
2. 否则 **`.mstarc`** `[config] harness_dir=<dir>`（仓库本地声明，见下「`.mstarc` 格式」；find-first-stop 向上找最近文件，**不越过工作区根**）
3. 否则 `.mstar/` → `{HARNESS_DIR}=.mstar/`, `{PLAN_DIR}=.mstar/plans/`
4. 否则 `.agents/` → legacy `{HARNESS_DIR}=.agents/`, `{PLAN_DIR}=.agents/plans/`
5. 否则 `.plans/` 或 `plans/` → 遗留同目录 `{HARNESS_DIR}={PLAN_DIR}`
6. 皆无 → 未启用 plan；进度走对话与 Completion Report

并存时 **`.mstar/` 优先**；仅当项目已有 `.agents/` 且无 `.mstar/` 时继续沿用 `.agents/`。

#### `.mstarc` 格式（INI 子集；默认 gitignored，见下「Git 跟踪策略」）

```ini
[config]
harness_dir=.custom_dir
plan_dir=planning
sdd_dir=process/sdd
iteration_dir=process/iterations
knowledge_dir=knowledge
specs_dir=specs/custom
workflow_dir=process/workflows
project_dir=process/projects
enforcement=hard
```

- `#` / `;` 注释；`[section]` 头；`key=value`（去空白）。仅读 `[config]` 段，未知键忽略（向前兼容）。
- 目录键：`harness_dir`（`{HARNESS_DIR}`）、`plan_dir`（`{PLAN_DIR}`）、`sdd_dir`（`{SDD_DIR}` 的 per-plan 基目录，`<plan-id>` 仍会追加）、`iteration_dir`（`{ITERATION_DIR}`）、`knowledge_dir`（`{KNOWLEDGE_DIR}`）、`specs_dir`（`{SPECS_DIR}`，**权威**——声明后不再走候选链）、`workflow_dir`（`{WORKFLOW_DIR}`）、`project_dir`（`{PROJECT_DIR}`）。全部相对 `.mstarc` 所在目录解析（绝对路径亦可）；无需目录已存在（可后续 scaffold；v3 的 `workflows/` / `projects/` 子目录由 engine writers 按需创建）。
- **`enforcement=hard|soft`**：仓库级硬门禁策略（`hard` 硬门禁、`soft` 本地回滚；其他值忽略）。优先级：显式 Config > Assignment `Enforcement: hard` 头标记（仅派发闸门）> `.mstarc` > 迭代 compass frontmatter > 默认 warn-only。`.mstarc` `soft` 可回滚 hard compass；`.mstarc` `hard` 硬化无标记的派发与各闸门。
- 子目录键与 `enforcement` 由 engine `resolvePlanDir` / `resolveSddDir` / `resolveIterationDir` / `resolveKnowledgeDir` / `resolveSpecsDir` / `resolveWorkflowDir` / `resolveProjectDir` / `resolveRepoEnforcement` 读取：从 harness 目录与其父目录（仓库根，`.mstarc` 的文档化位置）向上找最近配置文件。
- 优先级：显式 override > `.mstarc` > 探测。非默认布局的仓库写一个 `.mstarc` 即可程序化解目录问题，无需逐宿主设置 env / config。

**无 engine 时的手工解析（runtime 缺席，技能文本为权威）：**

1. 从当前目录向上找**最近**的 `.mstarc`（find-first-stop），**不越过工作区根**（CLI=git top-level，非 git=start 自身；dsh=会话工作区）。
2. 读 `[config]` 段：`key=value`（去空白），`#`/`;` 注释与空行忽略；同一键最后一次出现生效。
3. `harness_dir` 存在 → 相对该 `.mstarc` 所在目录解析（绝对路径直接用），即 `{HARNESS_DIR}`；无需目录已存在。
4. 其余键（`plan_dir` / `sdd_dir` / `iteration_dir` / `knowledge_dir` / `specs_dir` / `workflow_dir` / `project_dir`）从 **`{HARNESS_DIR}` 或其父目录**（仓库根）向上找最近 `.mstarc` 读取；值同样相对配置文件目录解析；`specs_dir` 声明后直接采用（跳过「`{SPECS_DIR}` 解析」候选链与空目录规则），`sdd_dir` 只替换基目录（`<plan-id>` 仍追加），`workflow_dir` / `project_dir` 直接替换默认子目录名。
5. 未声明的键回落默认组合：`{HARNESS_DIR}/plans/`、`{HARNESS_DIR}/sdd/<plan-id>/`、`{HARNESS_DIR}/iterations/`、`{HARNESS_DIR}/knowledge/`、`{HARNESS_DIR}/workflows/`、`{HARNESS_DIR}/projects/`、`{SPECS_DIR}` 候选链。

### `{SPECS_DIR}` 解析（找到非空目录即停）

1. `{HARNESS_DIR}/specs/`（默认 `.mstar/specs/`）
2. `docs/specs/`
3. `specs/`（仓库根）

**空目录规则**：候选路径存在但无任何文件 → 视为不存在，继续下一候选。

**创建默认**：全部缺失或皆空 → 创建并使用 `{HARNESS_DIR}/specs/`（统一落在 `.mstar/` 下）。**禁止**在 greenfield init 时优先创建裸仓库根 `specs/`。

**Legacy 兼容读**：若以上皆无内容，但 `{HARNESS_DIR}/designs/` 或仓库根 `designs/` **非空**，可作 `{SPECS_DIR}` 使用；init 时**不**新建 `designs/`。


> **Engine check (when available):** import `resolveSpecsDir` from `@mstar-harness/engine` in a host hook — or run `mstar path resolve` (prints the resolved specs dir) — to confirm the candidate order (empty-dir-as-absent included). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

可选项目选择：部分 spoke 仓库另跟踪 `{HARNESS_DIR}/roadmap.md` — **非**默认 tracked；仅在项目 opt-in 时提及。

## 内容边界（摘要）

| 区域 | 内容 |
|------|------|
| `docs/` | 人类文档：安装、贡献 |
| `{SPECS_DIR}` | 冻结规格 / ADR |
| `{ITERATION_DIR}` | 迭代 package（compass + guides/specs） |
| `{KNOWLEDGE_DIR}` | 实现 SSOT、可复用设计 |
| `{PLAN_DIR}/` | 主 plan、durable gate summaries、可选 residual prose |

单 plan 的 QC/QA **原始过程报告**默认进入 **`{SDD_DIR}/review/`**（gitignored review bundle），非 `docs/`，也不默认进入 `{PLAN_DIR}`。主 plan 仅保留 durable gate summary；R# open 状态以 `{PROJECT_DIR}/<id>/residuals.json` 为 SSOT（根 `status.json` v2 仅 workflows 注册表）。细则 → **`mstar-artifacts`**。

## 初始化 Plan 目录

PM 在需要持久化追踪时：

1. 建 `.mstar/`、`plans/`、`status.json`（**v2 空模板**见 **`mstar-artifacts/templates/status.empty.json`**：`version: 2` + `workflows: []`）
2. 可选 `knowledge/`、`iterations/`、`{HARNESS_DIR}/specs/`、`sdd/`（空目录占位；运行时 per-plan 子目录由 **`mstar-sdd`** → `mstar sdd workspace <plan-id>` 创建；`workflows/` / `projects/` 由 engine writers 按需创建，**不**预建）
3. 项目根 `.gitignore` 追加 Morning Star **进程产物**忽略集（见下文「Git 跟踪策略」）— CLI `init` 可自动添加
4. Git：**进程本地、结果共享** — 默认跟踪 `{HARNESS_DIR}/AGENTS.md`、`{KNOWLEDGE_DIR}/**`、`{SPECS_DIR}/**`；`plans/`、`iterations/`、`status.json` 等为**本地会话 SSOT**，默认 gitignored。跨 clone 持久 handoff = knowledge + specs + `{HARNESS_DIR}/AGENTS.md`（及根 `CONCEPTS.md` / `STRATEGY.md` 若使用）；须跨 clone 的 residual 须提升（compound）或写入 tracked results — **勿**默认 `git add` `status.json` / `plans/`。

步骤与 `{HARNESS_DIR}/AGENTS.md` 分层 → **`references/harness-bootstrap-and-agents-layering.md`**。

## Git 跟踪策略（进程 vs 结果）

**原则**：进程留在本地；结果与团队共享。

**默认 tracked（`{HARNESS_DIR}` 下）**：

- `{HARNESS_DIR}/AGENTS.md`
- `{KNOWLEDGE_DIR}/**`
- `{HARNESS_DIR}/specs/`（即解析后的 `{SPECS_DIR}` 在 harness 下的默认落点）

**默认 gitignored（`{HARNESS_DIR}` 下）**：

- `archived/`
- `iterations/`
- `plans/`
- `sdd/`
- `status.json`
- `workflows/`（v3 每 lifecycle 运行态：`<id>/snapshot.json` + `<id>/notes.jsonl`）
- `projects/`（v3 项目层：`<id>/roadmap.md` + `<id>/residuals.json`）

Legacy `.agents/` 项目：将上表路径前缀 `.mstar/` 换为 `.agents/`。

**v3 运行时目录的 gitignore 说明（文档化；canonical snippet 零改动）**：`workflows/` 与 `projects/` 都位于已被 **`.mstar/**` 默认忽略**的 `{HARNESS_DIR}` 之下——**不需要**在仓库根 `.gitignore` 增加任何条目，也**不新增** re-include 条目（它们不是 tracked 结果）。`workflows/` / `projects/` 子目录由 **engine writers 按需创建**（`writeWorkflowSnapshot` / `registerWorkflow` / project-register 写入路径），**不是** `scaffoldHarness` 的初始化产物——`mstar init` 不会预建空目录。

**多 worktree（iteration L1）**：默认 gitignored 的进程产物**不会**随 `git worktree add` 进入 feature 检出。读写须经 **control worktree** 绝对路径（`<control_worktree_path>/{HARNESS_DIR}/…`）；产品代码改在 feature worktree。细则与反模式（禁止因 feature 缺 plans 而 `Worktree mode: waived`）→ **`mstar-branch-worktree`**「Harness path SSOT under default gitignore」。

**Canonical `.gitignore` snippet**（skills 与 CLI `init` 对齐）：

```gitignore
# Morning Star harness (.mstar/)
# Principle: process stays local; results are shared with the team.
# Default-ignore everything under .mstar/, then re-include the tracked results.
.mstar/**
!.mstar/AGENTS.md
!.mstar/knowledge/
!.mstar/knowledge/**
!.mstar/specs/
!.mstar/specs/**
# .mstarc — repo-local harness config (may declare [config] harness_dir=<name>)
.mstarc
```

Legacy `.agents/` 等价：

```gitignore
# Morning Star harness (.agents/) — legacy
# Default-ignore everything under .agents/, then re-include the tracked results.
.agents/**
!.agents/AGENTS.md
!.agents/knowledge/
!.agents/knowledge/**
!.agents/specs/
!.agents/specs/**
```

> **Engine check (when available):** import `emitGitignoreSnippet` / `validateGitignore` from `@mstar-harness/engine` in a host hook to emit or validate the canonical snippet above. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## Spec 驱动的分支模型（多 Plan · 同一 Spec）

- **Iteration base branch**：创建 Spec/iteration 集成分支的祖先分支或 ref；必须显式记录，不能默认 `main` / `master`。
- **Spec 集成分支**：从 `iteration_base_branch` 创建；各 Plan 实现 merge 回此线后再视为 Spec 在代码侧集成。
- **Plan 实现分支**：每 `plan_id` 一条（PM 书面）。
- **PR target**：全部 Plans 与 iteration-close 完成后，向显式 `target_branch` 提 PR（窄例外见 Assignment `Branch policy`）。
- Git 操作与 QC 单一 `HEAD` → **`mstar-branch-worktree`**。
- workflow snapshot 登记顶层 `branch.base`（`iteration_base_branch`）/ `branch.target`（`target_branch`）/ `branch.integration`（`spec_integration_branch`），以及 plan 行 `metadata.spec_integration_branch` / `merge_target` → **`mstar-artifacts`**。

**解析顺序**（`mstar-iteration` §2.3）：workflow snapshot `branch` anchors → compass frontmatter → 向用户确认。**禁止**因仓库默认分支名为 `main`/`master` 就自动采用。

## Plan-Writing Path Gate

Plans are written to **`{PLAN_DIR}`** when persistent plan tracking is enabled. Do not introduce external default plan directories.

> **Engine check (when available):** import `assertPlanWritingPath` from `@mstar-harness/engine` in a host hook to enforce the gate above. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## 状态与权限（摘要）

`Todo` | `InProgress` | `InReview` | `Blocked` | `Done` — **`Done` 仅 PM 或 QA**。字段与 residual → **`mstar-artifacts`**。主 plan checkbox → **`mstar-artifacts`**。

## 未启用 Plan 时

无 plan 目录：PM 用对话追踪；门禁（QC/QA）仍适用；复杂度上升时可建议初始化。

## 实现角色最小阅读

仅需路径符号与 `plans[].metadata` 的 `primary_spec` / `spec_refs` 时：读本 SKILL 至「路径符号」+ **`mstar-artifacts/references/knowledge-and-designs.md`** 即可，**不必**通读 status/residual 全文。

## Evidence

正确结果 = 落盘产物可复核：`{WORKFLOW_DIR}/<id>/snapshot.json` 含对应 plan 行（状态 + `metadata` 分支字段；根 `status.json` v2 仅 workflows 注册表，无 plan 行），plan 文件存在于 `{PLAN_DIR}`，`{HARNESS_DIR}/AGENTS.md` 分层与 gitignore 与本文约定一致（进程本地 / 结果共享），`mstar path resolve` 输出与路径符号表一致。

## References

- `references/harness-bootstrap-and-agents-layering.md` — 新仓 harness + AGENTS 分层
- `references/effort-estimation.md` — agent-oriented 工期（禁人天/FTE）
- `references/artifact-storage-paths.md` — **产物存储路径 SSOT**（知识文档、CONCEPTS.md、STRATEGY.md 等落盘位置；`mstar-compound`、`mstar-compound-refresh`、`mstar-strategy` 等技能引用此表，不得本地重定义）

**Plan 工件细则**（主 plan、review bundle / durable summaries、`status.json`、residual、knowledge、Done 归档、**`templates/`**）→ skill **`mstar-artifacts`**（`references/` 与 `templates/`）。
