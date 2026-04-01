# 开源 Agent Harness 理念（本仓库）

## 定位

本文归纳从公开 agent harness 实践中提炼的**流程理念**，并已写入 `harness-loop.md`、`agents/project-manager.md` 等，作为本配置的默认行为约定。

## 已内化的原则（执行时必须遵守）

| 理念 | 含义 | 在本仓库的落点 |
|------|------|----------------|
| **意图优先于字面** | 先弄清「用户真正要达成什么」，再分类与分派 | `harness-loop.md`「意图门禁」；PM「第一性原理」与 `clarify` |
| **先准备再实现** | 访谈式规划、锁范围、再写代码 | Prepare：`specify -> clarify -> plan`；Execute：`plan locked -> tasks -> implement` |
| **按任务类别选能力与模型** | 视觉/深读/快改/硬逻辑等用不同强项 | `harness-loop.md`「任务类别」；Assignment 字段 **`Task category`**；`opencode.json` 的 `agent.*.model` |
| **可验证编辑** | 减少「凭记忆 Patch」导致的漂移与损坏 | `harness-loop.md`「可验证编辑与上下文纪律」：读后再改、失败则重读 |
| **持续推进与可核对完成** | 长任务有清单、有关门证据，避免空转 | `superpowers-skills.md` 的 `verification-before-completion`；PM 对 `tasks`/Phase Gate 的拉回 |
| **并行与边界** | 多线任务不踩同一写归属、不绕过分支门禁 | `harness-loop.md`「并行规则」；`branch-collaboration.md` |
| **分层上下文（可选）** | 大仓库用目录级 `AGENTS.md` 降噪 | `harness-loop.md`「分层上下文」；由业务项目维护者按需添加 |

## 与常见 harness 说法的对照（帮助理解角色分工）

| 常见说法 | 本仓库实体 |
|----------|------------|
| 总编排 | `@project-manager` |
| 规划/访谈 | `@product-manager` / `@architect` + Prepare 阶段 |
| category 路由 | **`Task category`** + 路由表 + 子代理选择 |
| 持续推进 / 不半途而废 | Phase Gate + Todo/`tasks` + 验证门禁 |
| 行级哈希锚定编辑 | 本仓库以 **读后再改 + 小步 Patch** 纪律落实（见 `harness-loop`） |

## 延伸阅读

- 按能力选配 MCP/skills：`~/.config/opencode/docs/agents/optional-tooling-by-capability.md`
- Superpowers 与门禁对齐：`~/.config/opencode/docs/agents/superpowers-skills.md`
