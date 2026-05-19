---
name: mstar-phase-gates
description: Morning Star (启明星) Spec-Driven 双阶段门禁 —— Prepare（`specify → clarify → plan`）、Execute（`plan(locked) → tasks → implement`）、意图门禁、clarify 核心纪律（共享理解 / 先探索 / 每问推荐答案）、hotfix 压缩路径、可验证编辑、Phase Gate 最小证据。**必须**在 PM 判定 gate、首次 implement 派单前、产品/架构参与 Prepare、或解释为何不能跳过 plan/clarify 时 Read；`@project-manager` 每轮编排非 hotfix 任务必读；`@product-manager` / `@architect` 写规格与锁 plan 时必读 Prepare 节；实现角色 Read Execute 与 hotfix 例外即可。Task category 与 `quick` 禁豁免规则仍在 `mstar-harness-core`。并行 Superpowers 短语见 `mstar-superpowers-align`。
---

## Load order（必读顺序）

**首次 Read 本 skill 前：必须先 Read `mstar-harness-core`（SKILL.md）。** `{PLAN_DIR}` / plan 文件落盘见 **`mstar-plan-conventions`**。冲突时 **以 `mstar-harness-core` 为准**。

## Spec-Driven 双阶段门禁（非热修强制）

### A. Prepare：`specify → clarify → plan`

- **`specify`** — 问题陈述、用户价值、范围/非目标、DoD 草案。
- **`clarify`** — 关键歧义清单与结论；高影响歧义必须收敛，否则 `Blocked`。
  - **意图核对（Intent gate）**：区分**用户字面表述**与**待解决的真正问题**；手段与目标混淆须在此收敛。
  - **结构化澄清**：宿主提供 `question` 工具时优先使用；否则用结构化正文选项。宿主细节在各自的 `mstar-host` skill。
  - **`clarify` 核心纪律（Prepare）**：对 plan/方案的**每个方面**持续核对，直到与用户达成**共享理解**；沿**设计决策树**逐枝下行，**一次只收敛一个决策点**及其依赖，再进入下一枝。
    1. **能查库则查库**：若问题可通过探索代码库（实现、配置、`{SPECS_DIR}`、`{KNOWLEDGE_DIR}`、`{ITERATION_DIR}` 等）得到答案，**先探索、不向用户提问**。
    2. **每问带推荐**：每个仍需用户确认的问题，须给出**推荐答案**（及简短理由），便于快速对齐。
    3. **收口摘要**：`clarify` 结束前列出：已决事项、仍 open 的假设、对 `plan` 的约束。
- **`plan`** — 技术方案、模块边界/接口契约、风险与回滚点、验证计划。
  - **意图门禁**：锁 plan 前须能书面写清**真实目标 / 成功判据 / 非目标**三项；否则 Prepare 未通过。

### B. Execute：`plan(locked) → tasks → implement`

- **`plan(locked)`** — 冻结基线；实现中出现新约束时**先回写 plan 再继续**。
- **`tasks`** — 含依赖顺序、并行标记、完成判据；每任务可追踪到 plan 与验收标准。
  - **并行标签**：若 PM 将 ≥2 条实现轨 **同时** 分派，须在 `Superpowers` 中写入 `dispatching-parallel-agents`；同仓 ≥2 可写并发时叠 `using-git-worktrees`（见 **`mstar-superpowers-align`** 与 **`mstar-branch-worktree`**）。
- **`implement`** — 按 tasks 顺序执行并提交自检证据；完成进入 `InReview`；遵循 **`mstar-coding-behavior`**。

### 可验证编辑与上下文纪律

- **读后再改**：修改文件前以磁盘内容为准重读（`Read`/等价工具）。
- **小步应用**：Patch 失败**禁止**在同一过时锚点连试；重读、缩小变更单元或拆步。
- **多文件改动**：逐项核对路径与引用，避免未验证的批量替换。

### Hotfix 例外

- 压缩为 `specify(min) → plan(min) → implement`；必须在回报或 plan notes 补记事后 **`clarify/RCA`**。

详细节点与角色最小产物见 **`references/phase-gate-playbook.md`**。

## PM 快速判定

Prepare 未完成、意图门禁未满足（真实目标 / 成功判据 / 非目标未书面收敛）、`tasks` 未就绪、或 plan drift 未回写 → **`Gate decision: blocked`**。

## References

- `references/phase-gate-playbook.md` — 可执行动作、角色职责与证据要求。
