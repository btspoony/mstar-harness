---
category: Harness
packages: root, cli, opencode-v2, engine, commands
---

- Hardened the **opencode-v2 write gate** against symlink aliasing: the landing-path resolver now follows symlink chains to the real destination (8-hop bound, fail-close refusal `write.symlink-resolution-refused` on cycles/overflow), closing a dangling-link bypass that could write harness authority files (`store.db-wal`) through outside aliases (#438).
- Hardened the **ZCode git-guard hook** force-push detection: push argv roles are now classified (option allowlist from `git push -h`, values consumed, first positional = repository), `+refspec` force pushes are denied, and unknown option forms fail closed naming the token — closing the `+main:main` and `--repo=origin +main:main` bypasses (#439).
- The MCP and CLI **spawn helpers survive early-exiting children**: `child.stdin` stream errors (EPIPE) are owned by the helper instead of crashing the process with an unhandled exception (#441).
- **Root `hooks/` are CI-covered**: guard behavior tests plus `node --check` run in CI; `hooks/session-context.mjs` degrades fail-soft (diagnostic + unavailable-authority context) when the engine is unresolvable instead of crashing (#445, #446 partial).
- **Status-write lock refusals now diagnose** the stale-lock state (holder alive / confirmed dead with verified removal steps / pid file absent) instead of a bare hand-edit hint; automatic takeover stays deferred pending an atomic primitive (#447 partial).
- Lean cleanup: removed the unreachable CLI target prompt and the `@inquirer/prompts` dependency, deleted the dead `homeRelativeSourcePath` export, unified the judgment shadow digest helpers, fixed a stale release docstring (#453 partial).

<!-- CN -->
- 加固 **opencode-v2 写门**的符号链接别名防护：落点解析器现在沿链接链解析真实落点（8 跳上限，环形/越界以 `write.symlink-resolution-refused` fail-close 拒绝），堵住可经外部别名写入 harness 权威文件（`store.db-wal`）的悬空链接绕过 (#438)。
- 加固 **ZCode git-guard 钩子**的强推检测：对 push argv 做角色分类（选项白名单来自 `git push -h`、值选项消费、首个位置参数为仓库），拒绝 `+refspec` 强推，未知选项形式 fail-close 并指名 token——堵住 `+main:main` 与 `--repo=origin +main:main` 两处绕过 (#439)。
- MCP 与 CLI 的 **spawn 助手可在子进程提前退出时存活**：`child.stdin` 流错误（EPIPE）由助手接管，不再以未处理异常击穿整个进程 (#441)。
- **根 `hooks/` 纳入 CI 覆盖**：CI 运行守卫行为测试与 `node --check`；`hooks/session-context.mjs` 在引擎不可解析时 fail-soft 降级（stderr 诊断 + 不可用权威上下文）而非崩溃 (#445，#446 部分)。
- **status 写锁拒绝信息可诊断**陈旧锁状态（持有者存活 / 确认已死附验证后的移除步骤 / pid 文件缺失），替代裸手改提示；自动接管仍待原子原语后启用 (#447 部分)。
- 精简清理：移除不可达的 CLI target 交互提示与 `@inquirer/prompts` 依赖，删除死导出 `homeRelativeSourcePath`，统一 judgment shadow 的 digest 助手，修正过时的发布脚本注释 (#453 部分)。
