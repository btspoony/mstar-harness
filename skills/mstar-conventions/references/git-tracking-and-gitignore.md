# Git 跟踪策略（进程 vs 结果）

> **Load when:** editing root `.gitignore`, deciding what under `{HARNESS_DIR}` is tracked vs ignored, validating the canonical snippet, or explaining multi-worktree visibility of process vs result paths.

**原则**：进程留在本地；结果与团队共享。

**默认 tracked（bootstrap 布局）**：

- `.mstarc`（仓库根；布局声明，四个键 `harness_dir` / `knowledge_dir` / `specs_dir` / `adr_dir`，随分支共享）
- `.agents/AGENTS.md`（harness 规则文件；scaffold 写在仓库根下）
- `{KNOWLEDGE_DIR}/**`、`{SPECS_DIR}/**`、`{ADR_DIR}/**` — 默认即 `.agents/knowledge|specs|adr`（`.mstarc` 声明时以声明为准；这三层不位于 `{HARNESS_DIR}` 下，`{HARNESS_DIR}/<kind>/` 仅是 legacy 只读位置，不建、不声称）；`{ADR_DIR}` 另含 `README.md`、`proposed/TEMPLATE.md`、`implemented/TEMPLATE.md`

**默认 gitignored**：`{HARNESS_DIR}` **整体**（默认 `.mstar/`）——`archived/`、`iterations/`、`plans/`、`sdd/`、`reviews/`（review 运行目录树：codebase audit / PR / branch / diff review 的 report 与 evidence）、`projects/`（roadmap transport 规则 → `mstar-project-governance`）、`workflows/`（retained ordinary bodies/notes）、`store.db`（issue/catalog/roadmap/milestone 与 execution_* 权威）、`status.json`（仅历史输入，无 live writer）。

Legacy `.agents/` harness 项目：`{HARNESS_DIR}` 即 `.agents/`，进程与结果同处一棵树，沿用下方 legacy 等价 snippet（先 default-ignore、再 re-include tracked 结果）。`mstar path check` 按 Git 实况判定、**目录名不作准**：被忽略的文件只能留在 **control checkout**，可提交的文件属于**调用方自己的 checkout**（work / integration worktree）；结果目录被忽略只是 warning（`path.result-ignored`，exit `0`，指向 `.agents/` 或 `.mstarc`），位置越界才是 finding（exit `1`）。

**`mstar harness scaffold` 产物**：`.mstarc` 仅在仓库内找不到可解析的 `.mstarc`、且 harness 目录的父目录位于 scaffold 根之内时写入该父目录——`harness_dir` 取解析后的 basename，corpora 三个键固定 `.agents/*`；已有 `.mstarc` 永不改写，也不会在子目录再生一份。`{HARNESS_DIR}` 下建 `plans/`、`iterations/`、`sdd/`、`reviews/` 与 `projects/_default/`（`workflows/` 不预建）；tracked 语料按解析后的 `{KNOWLEDGE_DIR}` / `{SPECS_DIR}` / `{ADR_DIR}` 建目录，`{ADR_DIR}` 种子为 `README.md`、两个模板与四个桶目录（class 目录由首条记录创建）；`.agents/AGENTS.md` 写在工作区根。重跑幂等：既有文件与目录一律跳过。

**v3 运行时目录的 gitignore 说明（文档化；canonical snippet 零改动）**：`workflows/`、`projects/` 与 `reviews/` 都位于已被 **`.mstar/**` 默认忽略**的 `{HARNESS_DIR}` 之下——**不需要**在仓库根 `.gitignore` 增加任何条目，也**不新增** re-include 条目（它们不是 tracked 结果）。`projects/_default/` 由 **`scaffoldHarness` / `mstar harness scaffold` 建目录并在可用的 catalog 中登记**，不生成 `roadmap.md` 或 `residuals.json`；其余 project id 与 `workflows/` 子目录由各自 domain writers 按需创建。历史文件的迁移只走 transport/review（→ `mstar-project-governance`）。**`review_dir` 声明在 `{HARNESS_DIR}` 之外时**（例如 `review_dir=process/reviews` 或绝对路径）`{REVIEW_DIR}` 落在 canonical snippet 的 `.mstar/**` / `.agents/**` 之外，review report 与证据因此**不再被忽略**——这类布局需自行在仓库根 `.gitignore` 声明对应规则（canonical snippet 只 bootstrap 默认 harness 布局）。

**多 worktree（iteration L1）**：默认 gitignored 的进程产物**不会**随 `git worktree add` 进入新检出。进程 SSOT 固定在 **control root = 主 checkout（main worktree）**，读写经 control 绝对路径（`<main-repo-root>/{HARNESS_DIR}/…`）；integration 分支检出在专属 integration worktree（ACTIVE workflow `integration_worktree_path`，唯一 merge cwd）；产品代码改在 feature worktree。**Gitignore 策略注**：tracked-results 层（`.mstarc` / `.agents/AGENTS.md` / `{KNOWLEDGE_DIR}` / `{SPECS_DIR}` / `{ADR_DIR}`）随 Git 分支走，在采纳 canonical gitignore snippet 的仓库中对所有 worktree **可见**——本仓库 `.mstar/` 全量 gitignore 属仓库自身 ignore 规则的属性，非契约。三写域模型（process SSOT / tracked results / product source）的 SSOT → **`mstar-branch-worktree`**「Harness path SSOT under default gitignore」；反模式（禁止因 feature 缺 plans 而 `Worktree mode: waived`）同见该节。

**control root 的发现路径（two-step）**：`git -C <cwd> worktree list --porcelain` 的首条记录即主 worktree 根；`mstar path resolve` 直接报告 `controlRoot`（主 worktree 根）/ `controlHarnessDir`（该根的 `{HARNESS_DIR}`）/ `linkedWorktree`。进程文档一律从 `controlHarnessDir` 读写；linked checkout 里没有 `.mstar/` **不是**未初始化 harness——它只是说明本 checkout 不持有进程 SSOT。解析顺序的唯一 SSOT 见上文「`{HARNESS_DIR}` 解析顺序」。

**`.gitignore` 作者所有（author-owned）**：文件已含任一 harness **根声明**——`.mstar` 或 `.agents` 的规则，含前导 `/`、`!` 否定与部分声明（如 `.mstar/plans/`）——即为作者所有；scaffold、fence 写路径与 `doctor` 读路径共用 engine `path` 模块导出的同一个只读谓词 `hasHarnessRootDeclaration`，命中即**不做任何改动**（不追加、不重排、不去重、不规范化），文件字节不变。无关路径（`node_modules`、`dist/`）与单独出现的配置项 `.mstarc` **不**构成声明。canonical snippet 只 bootstrap **未声明**的文件；自定义 harness 布局的跳过行为不变。

**Canonical `.gitignore` snippet**（skills 与 CLI `init` 对齐）：

```gitignore
# Morning Star harness: the process root stays local.
# Tracked results live under .agents/ and .mstarc declares the layout.
.mstar/
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
!.agents/adr/
!.agents/adr/**
```

> **Engine check:** engine `emitGitignoreSnippet` / `validateGitignore` to emit or validate the canonical snippet above — a declared file validates as author-owned (`gitignore.author-declared`) with no rewrite, while a missing file still fails as `gitignore.missing`. On `fail`, do not proceed — fix and re-run. Contract → **`mstar-use-cli`** `references/checks-and-lints.md` § Engine check callouts.
