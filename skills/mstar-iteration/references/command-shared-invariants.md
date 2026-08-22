# Iteration 命令共享 invariants + preflight

本文件是 `commands/iteration-*.md`（`iteration-start` / `iteration-drive` / `iteration-loop`）**重叠内容**的单一共享副本（SSOT）。**只收录出现在 ≥2 个命令中的行**；命令专属内容保留在命令正文，**不**复制进本文件：

- `iteration-start` Phase 1 review-chain 表（§5.1→§5.2→§5.3 顺序 invoke、三角色冒充禁止、`{KNOWLEDGE_DIR}/` 新增禁止）— start 专属
- `iteration-loop`「Do not Read `skills/grill-me/SKILL.md`」— loop 专属

命令正文经一行指针引用本文件，不重复定义以下 invariants / preflight / todos / STOP。

## PM invariants（重叠行）

Phase 2–5 全程有效（drive + loop 共有的行）：

| 禁止（PM 线程） | 必须 |
|-----------------|------|
| Write/Edit/Shell 产品代码、写测试、跑 QC（Phase 2） | 每条 implement/QC/QA Assignment ⇒ **1 次 `Task`** |
| **多 task plan 用 inline 大包派发**（整份 plan / T1–Tn 贴进一个 dev Assignment） | **SDD**：`mstar-sdd` per-task 循环 — `mstar sdd task-brief` → implementer → `mstar sdd review-package` → task reviewer → `progress.md` |
| 只写 Assignment 就进入下一 gate | 同轮 dispatch：每条 Assignment ⇒ **1 次 invoke**（`Subagent invokes issued: N`，N = Assignment 条数） |
| 最后一个 plan `Done` 后直接开 PR / 汇报结束 | **Phase 3 → 4 → 5** 顺序执行 |
| Phase 5 自己改产品代码 | 需改产品代码时 **dispatch** `fullstack-dev` / `ops-engineer` |

派发细则 → **`mstar-dispatch-gates`** + **`mstar-host`**。Phase 3 细则 → **`mstar-iteration` §3** + **`mstar-compound`**。

## Assignment preflight（bash 块 — byte-identical 共享副本）

`mstar-harness` bin 未安装时静默跳过；在每次 implement/QC/QA 派发前（**SDD** 下为最新 `{SDD_DIR}/task-N-brief.md` 或临时写盘的 Assignment）校验。模式由迭代 compass frontmatter 的 `enforcement` 键决定（Slice 5）：

- **默认（compass 无 `enforcement: hard`）— 可选 warn-only**：exit 1 仅提示，不阻断派发（Slice 3 行为不变）：

```bash
command -v mstar-harness >/dev/null 2>&1 && mstar-harness dispatch validate "<latest-assignment-file>"
```

- **`enforcement: hard`（迭代 compass frontmatter 声明）— fail-fast**：校验失败即 `exit 1` 阻断派发（bin 缺失仍静默跳过）：

```bash
if command -v mstar-harness >/dev/null 2>&1; then mstar-harness dispatch validate "<latest-assignment-file>" || exit 1; fi
```

> 路径必须加引号且替换为具体文件（如最新 `{SDD_DIR}/task-N-brief.md`，勿留尖括号）——agent 代入的路径不得进入 shell 无引号展开。

## Session todos（重叠行；drive + loop 共有）

| Todo id | 何时追加 | 何时可勾掉 |
|---------|----------|------------|
| plan-wave todos | 进入 Phase 2 | 各 plan `Done` |
| `phase-3-iteration-close` | 仅剩 1 个非 `Done` plan | Phase 3 §3.5 exit 全 `[x]` |
| `phase-4-create-pr` | Phase 3 完成后 | PR 已创建并记录 URL/number |
| `phase-5-pr-merge-ready` | Phase 4 完成后 | Phase 5 §5.5 exit 全 `[x]` |

## Continuous execution STOP list（重叠行；start / drive / loop 共有）

Execute **`mstar-iteration` §2.6**（Continuous execution SSOT：自 Phase 2 进入至 Phase 5 §5.5 exit 前 PM **连续编排**，进度汇报后下一条必须是 dispatch 或下一 phase 步骤，不向用户例行 yes/no check-in）。

**合法 STOP（仅此升级用户）**：

- 迭代 branch metadata 缺失（`iteration_base_branch` / `target_branch`）
- **`Blocked`**：真冲突、secrets、不可逆范围缺口、Phase 5 多轮仍无法 merge-ready
- 用户本轮显式打断

**Turn 收束纪律**：最后一条 assistant 内容必须是 **in-flight 动作**（invoke 已发出、或写明下一 dispatch 的 Assignment 字段），**不得**以对用户的确认问句收束 turn。
