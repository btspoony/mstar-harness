# Harness 初始化与 `AGENTS.md` 分层策略（Morning Star）

> **Load order**：使用本参考初始化仓库前，须先 Read `mstar-harness-core` 与 `mstar-conventions`；冲突以 `mstar-harness-core` 为准。

## 目标

给新仓或迁移仓提供一套可复制的启动方式，确保：

- store.db 执行/issue 权威与 authored plan、review bundle 有唯一落点；`status.json` / snapshot 只是迁移源；
- 根规则与 harness 规则不互相覆盖；
- 目录级 `AGENTS.md` 只承载增量边界，不变成重复手册。

## Bootstrap 最小步骤

1. **Bootstrap 唯一路径 = `mstar harness scaffold` + `mstar store init`**：scaffold 创建 `{HARNESS_DIR}`（推荐 `.mstar/`）与 authored 目录（`plans/` / `iterations/` / `knowledge/` / `specs/` / `sdd/`），建立 `projects/_default/` 目录并在可用 catalog 中登记；**不**写 `status.json`，不产出 roadmap Markdown 或 register。
2. Store：ACTIVE root register / plan 行 / leases / sessions 在 store；findings 是 store issues，project register 无条件退役为迁移历史。初始化/升级与 staged activation 的分工只按 **`mstar-conventions` SKILL.md「初始化 Plan 目录」**：全新用 `store init`；已有/legacy 用 `store upgrade` 导入并激活执行权威；`store activate` 仅用于 reviewed staged migration，不是例行追加步骤。无 ACTIVE store 的 harness 没有执行权威——用对话追踪（no-plan mode），门禁（QC/QA）仍适用。
3. per-plan SDD 子目录由 **`mstar-sdd`** → `mstar sdd workspace <plan-id>` 创建（`sdd/` 由 scaffold 建好）。
4. 项目根 `.gitignore` 追加 Morning Star **进程产物**忽略集（canonical snippet → `mstar-conventions` SKILL.md「Git 跟踪策略」；legacy `.agents/` 有等价表）。
5. 可选：为 `{ITERATION_DIR}` / `{KNOWLEDGE_DIR}` 补导览 `README.md`（散文，无登记义务）；`{HARNESS_DIR}/specs/` 是解析后的 `{SPECS_DIR}` 默认落点；内容边界见 `mstar-conventions` SKILL.md 与 `references/knowledge-and-designs.md`。
6. 创建 `{HARNESS_DIR}/AGENTS.md`（harness 子树规则；**tracked**）：符号表可复述 `{HARNESS_DIR}`、`{PLAN_DIR}`、`{ITERATION_DIR}`、`{KNOWLEDGE_DIR}`、`{SPECS_DIR}` 与 `docs/` 分工；新项目推荐 `.mstar/AGENTS.md`，已有项目可继续使用 `.agents/AGENTS.md`。
7. 校准根 `AGENTS.md`：只保留仓库级长期约束，显式引用 `{HARNESS_DIR}/AGENTS.md` 作为 harness SSOT。
8. 仅在确有稳定边界时新增目录级 `AGENTS.md`（如 `contracts/`、`gateway/`、`sdk/`）。

**程序化路径**：`mstar harness scaffold [path]`（CLI，默认 cwd）完成步骤 1（含 `_default` 项目登记）、4 与 6 —— 调用 engine `scaffoldHarness`、追加 canonical gitignore snippet（已存在则跳过）、写最小 `{HARNESS_DIR}/AGENTS.md`（已存在则跳过）；随后 `mstar store init` 完成步骤 2 的执行权威激活。幂等，重跑只补缺失件，不从既有 `roadmap.md` 自动创建内容权威。步骤 3 的 per-plan 子目录、5、7、8 仍按需手工。scaffold 遵循 `.mstarc` 的 `harness_dir` / `project_dir` 覆盖（写入解析后的目录）；解析出的 harness 目录名非 `.mstar` 时跳过 canonical gitignore snippet（自定义 harness 布局自行管理 ignore 规则）。

**gitignore 归一化契约**：scaffold 对默认布局的根 `.gitignore` 仅做四类收敛——分区（用户针对性 `.mstar/…` 规则整体移到 fence 之后、相对顺序不变）、去重冗余宽规则、错位主宽规则前移至首个 canonical negation 之前（仅当跨越行全部为 scaffold 自有语义）、补齐 canonical negation 使其出现在最后一条宽规则之后。保证：① tracked 结果（AGENTS/knowledge/specs）不因错序 fence 被忽略；② 用户针对性规则的字面意图最后生效（`!x` 即 track `x`）。自我否定的规则序列（先 `!x` 后被宽规则压制）按字面意图解析；每次变更均在 scaffold 输出中报告。

## Git 跟踪策略（进程 vs 结果）

**原则**：进程留在本地；结果与团队共享。完整规则与 canonical `.gitignore` snippet → **`mstar-conventions` SKILL.md「Git 跟踪策略」**。

| 类别 | 默认 tracked | 默认 gitignored |
|------|--------------|-----------------|
| 结果（跨 clone handoff） | `{HARNESS_DIR}/AGENTS.md`、`{KNOWLEDGE_DIR}/**`、`{SPECS_DIR}/**` | — |
| 进程（执行权威在 store；plan 是 authored artifact） | — | `store.db`、`plans/`、`iterations/`、迁移源 `status.json`、`workflows/` retained bodies 与 legacy 文件、`projects/`、`sdd/`、`archived/` |

跨 clone 须持久的 residual 或决策：经 **`mstar-compound`** 提升入 `{KNOWLEDGE_DIR}/`、写入 `{SPECS_DIR}/`，或记入 tracked `{HARNESS_DIR}/AGENTS.md` — **勿**默认 `git add` 迁移源 `status.json` / `plans/`。

## 三层 `AGENTS.md` 职责切分

### 根 `AGENTS.md`（项目层）

- 放：仓库身份、技术边界、构建/测试接口、安全与分支策略、规格路由表。
- 不放：动态状态、当前批次进展、R# 明细、QC 单次结论。

### `{HARNESS_DIR}/AGENTS.md`（harness 层）

- 放：`{HARNESS_DIR}`/`{PLAN_DIR}`/`{ITERATION_DIR}`/`{KNOWLEDGE_DIR}`/`{SPECS_DIR}` 契约、`docs/` 与 harness 子树内容边界、状态推进门禁、QC/QA 对齐规则、residual 生命周期。
- 不放：语言/框架编码细节、业务模块实现约束。

### `<subdir>/AGENTS.md`（边界层）

- 放：该目录独有的边界、禁区、接口命令与升级触发。
- 不放：根级通用规则复写、harness 全量规则拷贝。

## 分目录 `AGENTS.md` 创建准入

仅当满足任一条件时创建：

- 目录具备独立风险模型（如链上合约 vs 网关服务）；
- 目录有单独发布面或对外 API 面；
- 目录有稳定且长期存在的专属约束（构建、依赖、数据/安全边界）。

若仅是代码组织而无新增约束，不创建目录级 `AGENTS.md`。

## 推荐模板骨架（目录级）

```markdown
# AGENTS.md — `<dir>/`

## Source Priority
1. Current user instruction
2. Root `AGENTS.md`
3. This file
4. `{HARNESS_DIR}/AGENTS.md`

## Boundary Rules
- ...

## Build & Test (interface)
- ...

## Escalation Triggers
- ...
```

## 反模式与修正

- 反模式：在根 `AGENTS.md` 维护当前计划进展与 commit 列表。  
  修正：经公共动词写 store.db 执行 plan 行 metadata，并 append `workflows/<id>/notes.jsonl`。

- 反模式：每个子目录复制一份完整 harness 规则。  
  修正：保留一行引用 `{HARNESS_DIR}/AGENTS.md`，仅写本目录增量约束。

- 反模式：目录级规则未声明 Source Priority，冲突时不可裁决。  
  修正：统一四级优先级模板并在每个目录级文件开头声明。
