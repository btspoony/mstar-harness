---
category: Harness
packages: root
---

- **Commit identity policy**: Repository-writing agents use configured Git author/committer identities, never fabricated or per-commit-overridden ones. Before committing, check `git config --get user.name` / `git config --get user.email`: an empty value is Blocked, preventing Git-synthesized identities; the operator configures the user's identity or uses a configured checkout. Completion reports require author-visible `git log -1 --format='%h %an <%ae>'` evidence.
- **Commit-surface coverage**: Branch/worktree guidance, fresh and sticky SDD prompts and handoffs, shared and Cursor plan-mode bridges and rules, iteration-close and knowledge-bootstrap recipes, and PM dispatch reports point to the single shared leaf Git rule. The execution-consumer fixture now uses a neutral test identity; engine, CLI and hook behavior is unchanged.

<!-- CN -->
- **提交身份策略**：写仓库的 agent 使用已配置的 Git 作者／提交者身份，禁止编造或逐次提交覆盖。提交前检查 `git config --get user.name` / `git config --get user.email`：空值即 Blocked，防止使用 Git 自动合成的身份；由操作者配置用户身份或改用已配置的检出。完成报告须提供显示作者的 `git log -1 --format='%h %an <%ae>'` 证据。
- **提交入口覆盖**：分支／worktree 指引、首次及 sticky SDD 提示与文件交接、共享及 Cursor 计划模式桥接与规则、迭代收口与知识初始化配方、PM 派发报告均指向共享 leaf Git 规则这一唯一权威。执行消费者测试 fixture 改用中性测试身份；engine、CLI 与 hook 行为不变。
