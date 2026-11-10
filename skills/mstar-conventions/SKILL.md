---
name: mstar-conventions
description: harness 路径约定：`{HARNESS_DIR}`/`{PLAN_DIR}`/`{SDD_DIR}`/`{ITERATION_DIR}`/`{KNOWLEDGE_DIR}`/`{SPECS_DIR}`/`{ADR_DIR}`/`{REVIEW_DIR}` 等符号的发现与初始化、docs 与 harness 子树边界、Spec 分支模型。读写 `.mstar/` 或开 plan 前必读。
---

## Load order（必读顺序）

**首次 Read 本 skill 前：必须先 Read `mstar-harness-core`（SKILL.md）。** 本 skill 只约定 **目录与路径**；不突破状态机与门禁。冲突时 **以 `mstar-harness-core` 为准**。

| 你还可能要 Read | 何时 |
|-----------------|------|
| `mstar-artifacts` | Main plans, review summaries, current execution/issue fields, InReview/QC waves and knowledge |
| `mstar-project-governance` | 项目 roadmap 内容权威与读写/导入/导出规则；legacy `roadmap.md` 仅 transport/history；residual register 迁移边界与 `_default` |
| `mstar-branch-worktree` | Assignment 写分支 / worktree / QC 检出 |
| `mstar-review-qc` | 派 QC（PM 同轮必读；SDD 强制 tri） |
| `mstar-sdd` | PM 执行 `Execution mode: sdd` 的 implement 波次 |

## Workflow

主链：按「路径符号」+「`{HARNESS_DIR}` 解析顺序」确定目录（默认 `.mstar/`，兼容 `.agents/`）→ 按「初始化 Plan 目录」以 **`mstar harness scaffold` + `mstar store init`** 建立 authored 目录与 ACTIVE store（唯一 bootstrap 路径），并追加 gitignore 进程产物集（未声明 harness 根规则时；进程本地、结果共享）→ 多 Plan · 同一 Spec 时登记 iteration base / spec 集成分支 / 各 Plan 实现分支 / PR target → 主 plan 写入 `{PLAN_DIR}`（**Plan-Writing Path Gate**）。未启用 plan 或无 ACTIVE store 时 → 对话追踪（no-plan mode），门禁（QC/PM Acceptance）照常。

## 路径符号（SSOT）

| 符号 | 默认 |
|------|------|
| `{HARNESS_DIR}` | `.mstar/` |
| `{PLAN_DIR}` | `{HARNESS_DIR}/plans/` |
| `{SDD_DIR}` | `{HARNESS_DIR}/sdd/<plan-id>/`（SDD 运行时 scratch + review bundle；gitignored） |
| `{ITERATION_DIR}` | `{HARNESS_DIR}/iterations/` |
| `{KNOWLEDGE_DIR}` | `{HARNESS_DIR}/knowledge/`（默认）；解析见下文「`{KNOWLEDGE_DIR}` / `{ADR_DIR}` 解析」 |
| `{SPECS_DIR}` | `{HARNESS_DIR}/specs/`（默认）；解析见下文「`{SPECS_DIR}` 解析」 |
| `{ADR_DIR}` | `{HARNESS_DIR}/adr/`（默认）；解析见下文「`{KNOWLEDGE_DIR}` / `{ADR_DIR}` 解析」 |
| `{WORKFLOW_DIR}` | `{HARNESS_DIR}/workflows/` (default; `.mstarc` `workflow_dir` overrides it) — retained ordinary bodies, append-only `notes.jsonl` and workflow-owned `reports/` (e.g. `<workflow-id>/reports/e2e.md`) |
| `{PROJECT_DIR}` | `{HARNESS_DIR}/projects/`（默认；`.mstarc` `project_dir` 声明时用声明值）——project 层目录；旧 `roadmap.md` 仅作文件 transport/history |
| `{REVIEW_DIR}` | `{HARNESS_DIR}/reviews/`（默认；`.mstarc` `review_dir` 声明时用声明值）——review 运行目录树（codebase audit / PR / branch / diff review 的 report 与 evidence；`mstar audit scaffold` 写入，`mstar pr-review report-path` 解析；gitignored） |
| `{HARNESS_DIR}/store.db` | 进程/control harness 根下的 issue/catalog/roadmap/milestone 与 **execution_* 执行权威** SQLite（`resolveProcessHarnessDir` 后 `<resolved root>/store.db`；尊重 `.mstarc`）。功能/集成 worktree **不**在 cwd 建库；roadmap 规则 → `mstar-project-governance`。 |

> **Engine check:** engine `resolveHarnessDir` / `resolvePlanDir` / `resolveSddDir` / `resolveIterationDir` / `resolveKnowledgeDir` / `resolveSpecsDir` / `resolveAdrDir` / `resolveWorkflowDir` / `resolveProjectDir` / `resolveReviewDir` — or run `mstar path resolve [path]`, whose JSON envelope prints the resolved dirs (including `specsDir`, `knowledgeDir`, `adrDir`) — to confirm the resolution below. On `fail`, do not proceed — fix and re-run. Contract → **`mstar-use-cli`** `references/checks-and-lints.md` § Engine check callouts.

### `{HARNESS_DIR}` 解析顺序（找到即停；探测**永不越过工作区根**——CLI=start 的 git top-level（非 git→start 自身）；dsh=会话工作区）

1. 显式 override：`opts.harnessDir` / `MSTAR_HARNESS_DIR`（全权优先，短路一切探测与配置文件）
2. 否则 **`.mstarc`** `[config] harness_dir=<dir>`（仓库本地声明，见下「`.mstarc` 格式」；find-first-stop 向上找最近文件，**不越过工作区根**）
3. 否则 `.mstar/` → `{HARNESS_DIR}=.mstar/`, `{PLAN_DIR}=.mstar/plans/`
4. 否则 `.agents/` → legacy `{HARNESS_DIR}=.agents/`, `{PLAN_DIR}=.agents/plans/`
5. 否则 `.plans/` 或 `plans/` → 遗留同目录 `{HARNESS_DIR}={PLAN_DIR}`
6. 皆无 → 未启用 plan；进度走对话与 Completion Report

并存时 **`.mstar/` 优先**；仅当项目已有 `.agents/` 且无 `.mstar/` 时继续沿用 `.agents/`。

#### `.mstarc` 格式（INI 子集；默认 gitignored，→ `references/git-tracking-and-gitignore.md`）

```ini
[config]
harness_dir=.custom_dir
plan_dir=planning
sdd_dir=process/sdd
iteration_dir=process/iterations
knowledge_dir=knowledge
specs_dir=specs/custom
adr_dir=docs/adr
workflow_dir=process/workflows
project_dir=process/projects
review_dir=process/reviews
enforcement=hard
```

- `#` / `;` 注释；`[section]` 头；`key=value`（去空白）。仅读 `[config]` 段，未知键忽略（向前兼容）。
- 目录键：`harness_dir`（`{HARNESS_DIR}`）、`plan_dir`（`{PLAN_DIR}`）、`sdd_dir`（`{SDD_DIR}` 的 per-plan 基目录，`<plan-id>` 仍会追加）、`iteration_dir`（`{ITERATION_DIR}`）、`knowledge_dir`（`{KNOWLEDGE_DIR}`）、`specs_dir`（`{SPECS_DIR}`，**权威**——声明后不再走候选链）、`adr_dir`（`{ADR_DIR}`，**权威**——同上）、`workflow_dir`（`{WORKFLOW_DIR}`）、`project_dir`（`{PROJECT_DIR}`）、`review_dir`（`{REVIEW_DIR}`）。全部相对 `.mstarc` 所在目录解析（绝对路径亦可）；无需目录已存在（可后续 scaffold；v3 的 `workflows/` / `projects/` / `reviews/` 子目录由 engine writers 按需创建）。
- **`enforcement=hard|soft`**：仓库级硬门禁策略（`hard` 硬门禁、`soft` 本地回滚；其他值忽略）。优先级：显式 Config > Assignment `Enforcement: hard` 头标记（仅派发闸门）> `.mstarc` > 迭代 compass frontmatter > 默认 warn-only。`.mstarc` `soft` 可回滚 hard compass；`.mstarc` `hard` 硬化无标记的派发与各闸门。
- 子目录键与 `enforcement` 由 engine `resolvePlanDir` / `resolveSddDir` / `resolveIterationDir` / `resolveKnowledgeDir` / `resolveSpecsDir` / `resolveAdrDir` / `resolveWorkflowDir` / `resolveProjectDir` / `resolveReviewDir` / `resolveRepoEnforcement` 读取：从 harness 目录与其父目录（仓库根，`.mstarc` 的文档化位置）向上找最近配置文件。
- 优先级：显式 override > `.mstarc` > 探测。非默认布局的仓库写一个 `.mstarc` 即可程序化解目录问题，无需逐宿主设置 env / config。

**无 engine 时的手工解析（runtime 缺席，技能文本为权威）：**

1. 从当前目录向上找**最近**的 `.mstarc`（find-first-stop），**不越过工作区根**（CLI=git top-level，非 git=start 自身；dsh=会话工作区）。
2. 读 `[config]` 段：`key=value`（去空白），`#`/`;` 注释与空行忽略；同一键最后一次出现生效。
3. `harness_dir` 存在 → 相对该 `.mstarc` 所在目录解析（绝对路径直接用），即 `{HARNESS_DIR}`；无需目录已存在。
4. 其余键（`plan_dir` / `sdd_dir` / `iteration_dir` / `knowledge_dir` / `specs_dir` / `adr_dir` / `workflow_dir` / `project_dir` / `review_dir`）从 **`{HARNESS_DIR}` 或其父目录**（仓库根）向上找最近 `.mstarc` 读取；值同样相对配置文件目录解析；`specs_dir` / `adr_dir` 声明后直接采用（跳过下方候选链与空目录规则），`sdd_dir` 只替换基目录（`<plan-id>` 仍追加），`workflow_dir` / `project_dir` / `review_dir` 直接替换默认子目录名。
5. 未声明的键回落默认组合：`{HARNESS_DIR}/plans/`、`{HARNESS_DIR}/sdd/<plan-id>/`、`{HARNESS_DIR}/iterations/`、`{HARNESS_DIR}/workflows/`、`{HARNESS_DIR}/projects/`、`{HARNESS_DIR}/reviews/`；`{SPECS_DIR}` / `{KNOWLEDGE_DIR}` / `{ADR_DIR}` 走下方候选链。

### `{SPECS_DIR}` 解析（找到非空目录即停）

1. `.mstarc` `specs_dir`（**权威**：声明即采用，跳过本链）
2. `{HARNESS_DIR}/specs/`（默认 `.mstar/specs/`）
3. `<repo-root>/.agents/specs/`
4. `docs/specs/`
5. `specs/`（仓库根）
6. legacy 只读：`{HARNESS_DIR}/designs/`、仓库根 `designs/`（仅非空时可用；init **不**新建）

**空目录规则**：候选路径存在但无任何文件 → 视为不存在，继续下一候选；候选按解析后路径去重（harness 根即 `.agents/` 时第 3 项与第 2 项是同一目录）。

**创建默认**：全部缺失或皆空 → 创建并使用 `{HARNESS_DIR}/specs/`（统一落在 `.mstar/` 下）。**禁止**在 greenfield init 时优先创建裸仓库根 `specs/`。

### `{KNOWLEDGE_DIR}` / `{ADR_DIR}` 解析（找到非空目录即停）

- `{KNOWLEDGE_DIR}`：`.mstarc` `knowledge_dir`（权威）→ `{HARNESS_DIR}/knowledge/` → `<repo-root>/.agents/knowledge/`（空目录视为不存在）→ 回退 `{HARNESS_DIR}/knowledge/`，需创建时创建（`resolveKnowledgeDir` 默认创建，`{ create: false }` 关闭）。
- `{ADR_DIR}`：`.mstarc` `adr_dir`（权威）→ `{HARNESS_DIR}/adr/` → `<repo-root>/.agents/adr/` → `<repo-root>/docs/adr/`（均按空目录规则）→ 回退 `{HARNESS_DIR}/adr/`，创建规则同上（`resolveAdrDir`）。

> **Engine check:** engine `resolveSpecsDir` / `resolveKnowledgeDir` / `resolveAdrDir` — or run `mstar path resolve` (prints all three) — to confirm the candidate order (empty-dir-as-absent included). On `fail`, do not proceed — fix and re-run. Contract → **`mstar-use-cli`** `references/checks-and-lints.md` § Engine check callouts.

部分 spoke 仓库 opt-in 跟踪的 `{HARNESS_DIR}/roadmap.md` 仅是既有 Markdown 文件/可审导入候选，非项目内容权威；读写规则 → `mstar-project-governance`。

## 内容边界（摘要）

| 区域 | 内容 |
|------|------|
| `docs/` | 人类文档：安装、贡献 |
| `{SPECS_DIR}` | 冻结规格 |
| `{ADR_DIR}` | 决策记录（ADR：proposed / implemented / rejected） |
| `{ITERATION_DIR}` | Iteration package: retained `prototypes/` design context first, then formal compass + guides/specs; prototype path/disposition → `mstar-iteration` Phase 1 §1.2.5 |
| `{KNOWLEDGE_DIR}` | 实现 SSOT、可复用设计 |
| `{PLAN_DIR}/` | 主 plan、durable gate summaries、可选 residual prose |
| `{REVIEW_DIR}/` | review 运行目录：codebase audit 的 `README.md` 报告 + 证据、PR/branch/diff review 的 `report.md` + `stage<N>-<slug>.md` 证据（进程产物，gitignored；不是 plan 产物，不经 plan 状态机） |

单 plan 的 QC/PM Acceptance **原始过程报告**默认进入 **`{SDD_DIR}/review/`**（gitignored review bundle），非 `docs/`，也不默认进入 `{PLAN_DIR}`。主 plan 仅保留 durable gate summary；open finding 以 `{HARNESS_DIR}/store.db` 的 linked issues 为 SSOT（`mstar plan issue-add` / `mstar issue add`）；project residual register 无条件退役为迁移历史。细则 → **`mstar-artifacts`**。

## Issue/catalog store 路径与权威分界

Issue/catalog/roadmap and ACTIVE execution authority live in control-root `{HARNESS_DIR}/store.db`; roadmap/milestone rules → `mstar-project-governance`. ACTIVE root register, workflow/plan rows, coordinator sessions, registered inputs and workflow merge exclusion live in `execution_*` tables. Coordinator source metadata/configuration/progress/completion and merge exclusion are domain-written; no per-row session or sealed Assignment. Historical execution files are read-only direct `mstar store upgrade` inputs, preserving original bytes; no staging writer or runtime file-state fallback remains. Retained ordinary artifacts stay with `ArtifactStore`; notes and docs never become transactional authority.

### Catalog 字段权威（contract §1）

| 数据 | 权威 | 读法 |
|------|------|------|
| project / iteration / plan / document 的 identity、路径、kind、description、project/iteration 归属、spec/knowledge 关系、catalog 生命周期（`active` / `archived` / `superseded`） | **DB catalog** 行 | catalog 域 API；`mstar catalog list` / `mstar catalog show` |
| 文档正文（compass 叙述、plan、spec/knowledge 内容、README 散文） | **文件** | 直接读文件 |
| Root register and workflow status/phase/anchors/configuration/completion/coordinator/merge exclusion | ACTIVE DB `execution_*` authority（唯一） | `mstar status validate` / `mstar plan show`; dashboard is projection |
| Row status/progress/task/QC/PM Acceptance/done_at/source branch/worktree | Same selected execution authority (`execution_plans` when ACTIVE) | Domain calls; catalog and projections never reset runtime state |
| Registered plan id/title/file and metadata | Registered row inputs from a catalog revision (`execution_inputs` / `catalog_pin`) | Correct supported source/configuration facts through ordinary writers; catalog edits never silently relocate an active plan or rewrite its registered inputs |

Store is process-local and gitignored. Issue/catalog and execution domains retain their own authority boundaries. Missing stores refuse `store.not-initialized` rather than answering an empty catalog. Staged stores support ordinary read-only catalog list/show; catalog mutations require an active store and refuse `store.not-active` while staged. Staged catalog inspection does not activate execution authority, and ACTIVE execution reads never fall back to leftover root/snapshot/session files. Bootstrap/migration changes authority only through supported operator operations.

### Markdown 索引退役（contract §4）

`{ITERATION_DIR}/README.md` 的迭代行、`<iteration-id>/README.md` 的 Documents 表、`{SPECS_DIR}/README.md` / `{KNOWLEDGE_DIR}/README.md` 的登记表与 `{PLAN_DIR}` 目录索引**不再是有待维护的登记面**：README 与其它正文一样是**散文**（可留作导览），但没有任何「必须新增/维护一行」的义务；「某文档是否已登记、属于谁、什么类型、什么生命周期」一律查 catalog。

### 职责：discover / import / register / query

`mstar catalog discover` 是只读 dry-run 提案（配置根 tracked 正文 + legacy 索引行 → 候选证据，带 reviewed source hash、显式 `unknowns` 与拟退役索引节）；`import` 按当前语义 identity/path/revision 应用该映射（source hash 仅 provenance，reviewed 字节漂移不单独拒绝），不建 workflow session、不退休索引；`register` / `update` / `link` 是单行登记与元数据/关系变更（identity 不可改）；`query` = `list` / `show`；`reconcile` 收口注册中断（pending `catalog.registration-pending`，contract §3）；`export` 是版本化 transport，回灌用 `import`。

标志、revision 守卫与可改字段以 `mstar catalog --help` 为准（族名索引 → **`mstar-use-cli`**）。

### 跨 clone 限制（contract §4）

`store.db` 是本地/进程产物，**仅凭 tracked 正文无法重建 catalog 历史**。`discover` 只提取 tracked 正文的 title/path/content hash 与显式元数据作**候选证据**，**从不**假设文件名编码 project/iteration 归属、归档状态、执行状态或 provenance——未声明的一律以显式 `unknowns`（identity / membership / document-kind / source-missing …）披露，需人工 review 后 import；完整恢复需 `catalog export` + reviewed import。

Store 落在 **control / process harness 根**，不随 feature worktree cwd；Help / validator / engine import **不**打开 SQLite。文档本身不证明打包兼容或激活就绪。

## 初始化 Plan 目录

PM 在需要持久化追踪时：

1. **Bootstrap 唯一路径 = `mstar harness scaffold` + `mstar store init`**（store 分工见步骤 4）：scaffold 建 authored 目录与 `projects/_default/` 登记；`store init` 激活执行权威。**无 ACTIVE store 的 harness 没有执行权威**——用对话追踪（no-plan mode），门禁（QC/PM Acceptance）仍适用；scaffold **不**写 `status.json`。
2. scaffold 建立 `plans/` / `iterations/` / `knowledge/` / `specs/` / `sdd/` / `reviews/` 空目录；运行时 per-plan 子目录由 **`mstar-sdd`** → `mstar sdd workspace <plan-id>` 创建；`workflows/` 由 engine writers 按需创建，**不**预建。
3. 项目根 `.gitignore` 追加 Morning Star **进程产物**忽略集（→ `references/git-tracking-and-gitignore.md`）— CLI `init` 可自动添加；文件已声明 harness 根规则时属作者所有，fence 不写入（→ `references/git-tracking-and-gitignore.md`）
4. Store：全新、无 legacy register/catalog 的 harness 用 `mstar store init` 建 active issue/catalog store；已有或 legacy harness 用 `mstar store upgrade`（operator 见 help）导入可识别执行状态、激活 authority 并报告 skipped 项。`store activate` 是 staged `store migrate` apply 后的激活入口（attestation 自动生成，`--attestation <path>` 仅为显式覆盖，`--operator` 必填），不是 init/upgrade 的例行下一步。以回执确认 authority，再用 `mstar status validate` / `mstar plan show` 读执行状态。
5. Git：**进程本地、结果共享** — 默认跟踪 `{HARNESS_DIR}/AGENTS.md`、`{KNOWLEDGE_DIR}/**`、`{SPECS_DIR}/**`；store 与运行过程默认 gitignored，plan Markdown 仍是 authored artifact，非状态权威。跨 clone 持久 handoff = knowledge + specs + `{HARNESS_DIR}/AGENTS.md`（及根 `CONCEPTS.md` / `STRATEGY.md` 若使用）；须跨 clone 的 finding 须提升（compound）或写入 tracked results — **勿**默认 `git add` 迁移源 `status.json` / `plans/`。

**程序化初始化**：`scaffoldHarness`（engine）与 `mstar harness scaffold [path]`（CLI）完成目录 + **`projects/_default/` 目录及可用 catalog 登记** + canonical gitignore snippet + 最小 `{HARNESS_DIR}/AGENTS.md`；**不**写 `status.json`，也不代替 `mstar store init` / `mstar store upgrade`（执行权威只在 store）。不创建 roadmap Markdown 或 residual register。既有 v1 `roadmap.md` 只作为后续 reviewed import 的候选（→ `mstar-project-governance`）。幂等，重跑只补缺失件；已声明的 `.gitignore` 属作者所有，字节不变。scaffold 遵循 `.mstarc`；解析出的 harness 目录名非 `.mstar` 时跳过 canonical gitignore snippet（自定义布局自行管理 ignore 规则）。

步骤与 `{HARNESS_DIR}/AGENTS.md` 分层 → **`references/harness-bootstrap-and-agents-layering.md`**。

## Git 跟踪策略（进程 vs 结果）

**原则**：进程留在本地；结果与团队共享。Tracked defaults（`AGENTS.md` / `{KNOWLEDGE_DIR}` / `{SPECS_DIR}` / `{ADR_DIR}`）、gitignore 面、canonical snippet、author-owned 判定、multi-worktree 可见性与 `mstar path check` 语义 → **`references/git-tracking-and-gitignore.md`**（唯一契约本体）。Bootstrap 步骤里的 ignore 引用指向同一文件。

## Spec 驱动的分支模型（多 Plan · 同一 Spec）

- **Iteration base branch**：创建 Spec/iteration 集成分支的祖先分支或 ref；必须显式记录，不能默认 `main` / `master`。**`branch.base` 是创建/merge 锚点，不是主 worktree 驻留事实**——主 worktree（control root）的驻留分支在生命周期写入前由 PM 记录为 **`Main worktree branch`**（主 plan 头），全程不切换。
- **Spec 集成分支**：从 `iteration_base_branch` 创建；各 Plan 实现 merge 回此线后再视为 Spec 在代码侧集成。
- **Plan 实现分支**：每 `plan_id` 一条（PM 书面）。
- **PR target**：全部 Plans 与 iteration-close 完成后，向显式 `target_branch` 提 PR（窄例外见 Assignment `Branch policy`）。
- **Standalone development plan**：单 plan 交付不经迭代集成序列——交付分支上完成 compound disposition（步骤 → **`mstar-knowledge/references/compound-workflow.md`**）后向显式 target 提交 PR，PR 身份（repo/head/target）在提交时记录；序列与语义 → `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`（迭代序列不变，见上）。
- Git 操作与 QC 单一 `HEAD` → **`mstar-branch-worktree`**。
- ACTIVE workflow 行（DB）登记顶层 `branch.base`（`iteration_base_branch`）/ `branch.target`（`target_branch`）/ `branch.integration`（`spec_integration_branch`），以及 plan 行 `metadata.spec_integration_branch` / `merge_target` → **`mstar-artifacts`**。

**解析顺序**（`mstar-iteration` §2.3）：workflow 执行行 `branch` anchors → compass frontmatter → 向用户确认。**禁止**因仓库默认分支名为 `main`/`master` 就自动采用。

## Plan-Writing Path Gate

Plans are written to **`{PLAN_DIR}`** when persistent plan tracking is enabled. Do not introduce external default plan directories.

> **Engine check:** engine `assertPlanWritingPath` to enforce the gate above. On `fail`, do not proceed — fix and re-run. Contract → **`mstar-use-cli`** `references/checks-and-lints.md` § Engine check callouts.

## 状态与权限（摘要）

`Todo` | `InProgress` | `InReview` | `Blocked` | `Done` — **`Done` 仅 primary PM**。字段与 residual → **`mstar-artifacts`**。主 plan checkbox → **`mstar-artifacts`**。

## 未启用 Plan 时

无 plan 目录或无 ACTIVE store：PM 用对话追踪（no-plan mode）；门禁（QC/PM Acceptance）仍适用；复杂度上升时可建议初始化（`mstar harness scaffold` + `mstar store init`）。

## 实现角色最小阅读

仅需路径符号与 `plans[].metadata` 的 `primary_spec` / `spec_refs` 时：读本 SKILL 至「路径符号」+ **`mstar-artifacts/references/knowledge-and-designs.md`** 即可，**不必**通读 status/residual 全文。

## Evidence

正确结果 = 可复核产物与执行状态：`mstar plan show` / `mstar status validate` 返回 store 的对应 plan 行（状态 + `metadata` 分支字段）与 root register，plan authored 文件存在于 `{PLAN_DIR}`，`{HARNESS_DIR}/AGENTS.md` 分层与 gitignore 与本文约定一致（进程本地 / 结果共享），`mstar path resolve` 输出与路径符号表一致，tracked 正文的 catalog 行（`mstar catalog show` / `mstar catalog list`）与其实际位置一致。迁移源文件面（`status.json` / snapshot）不构成 ACTIVE 证据要求。

## References

- `references/harness-bootstrap-and-agents-layering.md` — 新仓 harness + AGENTS 分层
- `references/git-tracking-and-gitignore.md` — 进程 vs 结果跟踪、canonical `.gitignore` snippet、author-owned 判定
- `references/effort-estimation.md` — agent-oriented 工期（禁人天/FTE）
- `references/artifact-storage-paths.md` — **产物存储路径 SSOT**（知识文档、CONCEPTS.md、STRATEGY.md 等落盘位置；`mstar-knowledge` 等技能引用此表，不得本地重定义）
- **`mstar-project-governance`** `references/migration-source-shapes.md` — historical execution/register file shapes; no execution route or live writer

**Current artifact details** (main plans, review bundles / durable summaries, execution/issue fields, knowledge and templates) → **`mstar-artifacts`**.
