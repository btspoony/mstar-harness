<div align="center">

<img src="assets/logo.svg" alt="Morning Star Harness" width="96">

# [Morning Star](https://github.com/btspoony/mstar-harness)

规划、实现、审查、验证、合并 —— 给 agent 编码宿主的一套交付流程。

[English](README.md) / 中文

<a href="https://github.com/btspoony/mstar-harness">GitHub</a> · <a href="https://github.com/btspoony/mstar-harness/issues">Issues</a>

[![CI](https://img.shields.io/github/actions/workflow/status/btspoony/mstar-harness/ci.yml?branch=main&style=flat-square&label=CI&labelColor=black)](https://github.com/btspoony/mstar-harness/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-white?labelColor=black&style=flat-square)](LICENSE)
[![Version](https://img.shields.io/github/v/release/btspoony/mstar-harness?include_prereleases&sort=semver&label=version&style=flat-square&labelColor=black&color=c4f042)](https://github.com/btspoony/mstar-harness/releases)

</div>

Morning Star 是面向 agent 编码宿主的插件，支持 dsh、omp、OpenCode、Cursor、Kimi Code、ZCode 与 Codex。它把一次请求变成可执行的交付流程，而不是一段聊天：`project-manager` 先澄清需求并维护计划，专职角色负责实现，独立的审查与验收在交付前把关。流程中可机械校验的部分（工作流状态、分支、门禁）由随包发布的 TypeScript 引擎实现；判断类内容（方向、角色选择、审查结论）留在 `mstar-*` skills 中 —— 都是可以直接阅读和修改的 Markdown。

**为什么用它**

- **每个请求都走同一条流程** —— 规划、实现、审查、验证：一次小修复和多 plan 迭代使用相同的阶段，而且随时可以暂停、恢复，过程记录不会丢。
- **由专职角色分工，而不是一段超长 prompt** —— PM 负责编排；需求、架构、实现、QC、验收、审计、运维各有专属角色与明确边界。
- **留下可审计的轨迹** —— 计划、发现、审查报告与决策都记录在仓库的 harness 目录里，而不只是留在对话中。
- **边界都是明确的** —— 流程负责开 PR 并停在 merge-ready；是否合并由你决定。审计只读并给出报告；任何触及真实环境的操作都需要你的明确授权。

## 安装

前置条件：CLI 通过 **Bun >=1.4.0** 启动 —— `npx` / `bunx` 只负责拉取包，仍需 PATH 上有 Bun；
纯 Node 机器的做法是安装包后用 **Node >=24.18.0** 运行（`node node_modules/@mstar-harness/cli/dist/mstar-harness.js <verb>`）。

| 宿主 | 安装 |
|------|------|
| dsh（DeepSeek Harness） | `npx @mstar-harness/cli init --target dsh` —— 需要 PATH 上有 `dsh` CLI；会安装插件与 LLM fallbacks（`--no-fallbacks` 跳过后者） |
| omp | `npx @mstar-harness/cli init --target omp` —— 有 `omp` CLI 时直接使用，否则回退到 `omp plugin install @mstar-harness/omp` |
| OpenCode | `npx @mstar-harness/cli init --target opencode` |
| Cursor | `npx @mstar-harness/cli init --target cursor` —— 会创建真实的插件 checkout，需要 `git` |
| Kimi Code | Kimi TUI：`/plugins install https://github.com/btspoony/mstar-harness`，然后 `/plugins reload` |
| ZCode | `npx @mstar-harness/cli init --target zcode`，再在 设置 → 插件管理 中安装 **morning-star-harness** |
| Codex | `npx @mstar-harness/cli init --target codex` —— 需要 `codex` CLI；会注册仓库 marketplace 并添加 `morning-star-harness@mstar-repo` |
| 任意 Agent Plugins v1.0.0 客户端 | 将客户端指向本仓库根 —— `plugin.json` 加 `skills/` 即便携包 |

`init` 默认写入 project scope 的配置（`--scope global` 安装到宿主全局；Codex 的 global scope 不会安装七条斜杠命令 skill），成功后还会全局安装同版本的 `@mstar-harness/cli` —— 加 `--no-global-cli` 可跳过。用 `npx @mstar-harness/cli doctor --target <host>` 检查结果，它会同时报告 MCP 配置为 `aligned`、`mismatch` 或 `unavailable`。

CLI 的正式命令名是 `mstar-harness`。短别名 `mstar` 只在安装了本包的环境中存在，而且有一个同名 npm 包声明了同样的名字 —— 有疑问时用长名。手动安装、路径布局与各宿主说明见 [`INSTALL.md`](INSTALL.md)。

## 使用

每个会话进入一次 PM，然后用你自己的话描述要做什么；PM 会在该会话中推进整个流程。

| 宿主 | 进入 PM |
|------|---------|
| dsh | `pm` skill |
| omp | `/skill:pm` |
| OpenCode | `Project Manager` agent，或 `/pm` |
| Cursor | `/pm` |
| Kimi Code | 会话自动加载，或 `/skill:pm` |
| ZCode | `/morning-star-harness:pm` |
| Codex | `/pm` |

### 单任务（不跑迭代）

给 PM 一个具体的请求，例如：*“给公开 API 加上限流，并补上测试。”* PM 会补全模糊之处、写计划，然后在功能分支上走完 实现 → 独立 QC 审查 → 验收 → 完成。本轮没有修掉的已确认问题会被记录为 issue，而不是丢掉。最终结果由你检查并合并。

### 迭代

| 命令 | 作用 |
|------|------|
| `/iteration-start [direction] [pause]` | Phase 1：通过交互式方向锁定（grill-me）产出本次迭代的 compass 与计划，随后自动推进执行、收尾、开 PR 到 merge-ready。`pause` 停在 Phase 1，稍后用 `/iteration-drive` 继续。 |
| `/iteration-drive` | 恢复或继续推进已锁定的迭代，不接受参数。 |
| `/iteration-loop [direction] [scale]` | 同样的生命周期全程自动，但没有交互阶段。`scale`（`S` / `M` / `L` / `XL`）限制本次迭代承接的 plan 数量。 |

一次迭代只有走完 post-merge 收尾才算结束：阶段关闭、PR 处于打开状态或 PR 已合并，单独都不算完成。各宿主的命令拼写不同 —— 有的需要插件前缀，Codex 只在 project scope 安装命令 skill；参数形式与各宿主差异见 [`docs/commands.md`](docs/commands.md)。

### 审计、Review 与验证

| 命令 | 作用 |
|------|------|
| `/codebase-audit [keywords]` | 只读盘点，产出按优先级排序、可直接执行的改进计划；按类别聚焦（`bug`、`security`、`perf`、`tech-debt`、…）可缩小范围。 |
| `/amazing-pr-review [pr\|branch] [quick\|default\|deep]` | 合并前审查 PR 或分支，三档强度，最终给出唯一结论：`ship it`、`needs fixes` 或 `blocked`。 |
| `/amazing-test-audit [scope] [quick\|deep] [campaign]` | 对测试面做只读审计 → 产出删除、修复、合并或迁移测试的计划。 |
| `/amazing-e2e-check [environment] [scenarios]` | 在独立 workflow 中运行你明确要求的浏览器、真机或安装部署场景。 |

审计类命令只读取并报告，不会改你的代码。有两条边界要知道：`/amazing-pr-review` 在你给出 PR 编号时会把发现以 comment review 发布到 GitHub —— 它从不 approve、request changes 或 merge；`/amazing-e2e-check` 只在你主动要求时运行，其中触及真实环境的步骤需要明确授权。

## 工作流

1. **澄清并规划。** PM 把请求落成书面计划 —— 范围、任务、验收 —— 迭代场景下先与你锁定方向。
2. **在分支上实现。** 工作发生在功能分支上，每个任务交给合适的角色。
3. **独立审查与验证。** 先 per-task review，再 plan 级 QC 审查，然后由 QA 或 PM 验收：各环节独立取证，而不是复述实现者的总结。
4. **带证据收尾。** 已确认的发现转成跟踪中的 issue 或修复；plan 只有在验证证据齐全时才标记完成，workflow 的 PR 推进到 merge-ready。
5. **合并。** 合并是单独的一次授权 —— 你可以显式授权，也可以自己合并。合并之后，workflow 会验证结果并关闭。

引擎负责校验流程中可机械校验的部分 —— 工作流状态流转、分支与 worktree 对齐、派发前置条件、plan 与 issue 记录。这些校验默认是 advisory：只报告问题；项目或迭代可以用 `enforcement: hard` 升级为阻断，具体能否阻断取决于宿主。过程状态（计划、workflow 记录、发现、审查报告）存放在 harness 目录，默认 `.mstar/`，默认被 gitignore。

## 角色与技能

**project-manager** 在你的会话中运行并派发专职角色：需求与架构、后端与前端实现、QC 审查、验收、代码库与 PR 审计、运维、写作。这些角色的规则就是 `mstar-*` skills —— 可阅读的 Markdown，同时也是流程的唯一事实来源；`@mstar-harness/engine` 实现其中可校验的那一半。使用 harness 不需要手动加载或阅读任何内容：进入 PM，描述任务即可。

## 命令行

`mstar-harness` CLI 覆盖会话之外的事务：issue、roadmap、工作流状态、各类校验、看板与 MCP。

- **直接问命令本身。** `--help` 会列出命令期望的输入；对 issue 的写操作，它还会逐条列出 payload 字段的类型，以及必填还是仅在特定处置方式下必填。用法被拒绝时，它会说明发现的问题、该看哪条 help，以及如何恢复。
- **输出是 JSON**，便于脚本和 agent 解析；退出码为 `0` 成功、`1` 拒绝、`2` 用法错误，缺失 SDD task 时为 `3`。

```text
mstar-harness --help                        # 命令族
mstar-harness issue close --help            # 单个动词的选项与 payload 字段
mstar-harness schema --command issue.close  # 同一份契约的机器可读 JSON
```

- `mstar-harness dashboard` 在 `127.0.0.1` 提供只读的 issue 与工作流状态网页界面（Ctrl-C 停止）。
- `mstar-harness report` 生成离线、脱敏的 GitHub issue 报告草稿，供你检查后再提交。
- `mstar-harness mcp` 用同一个包通过 stdio MCP 暴露同一套命令；七个宿主都带有启动配置（dsh 需要在 profile 中安装 `@deepseek-ai/dsh-mcp-client` 桥接插件）。

宿主接入、issue 与 roadmap 命令族，以及这些界面背后的细节，见 [`docs/runtime-reference.md`](docs/runtime-reference.md)。

## 文档

- [`docs/runtime-reference.md`](docs/runtime-reference.md) —— 组件、存储布局、角色与技能、CLI 与 MCP 参考。
- [`INSTALL.md`](INSTALL.md) —— 各宿主的安装与校验，以及 `report` 命令的完整说明。
- [`docs/commands.md`](docs/commands.md) —— 七条斜杠命令：参数、适用场景、归属 skill。
- [`CONCEPTS.md`](CONCEPTS.md) —— harness 在 skills 与文档中使用的术语表。
- 更新说明：[`CHANGELOG.md`](CHANGELOG.md) / [`CHANGELOG_CN.md`](CHANGELOG_CN.md)。CLI 参数：**`mstar-use-cli`** skill。
- 维护者：[`AGENTS.md`](AGENTS.md)。

## 许可

MIT，见 [LICENSE](./LICENSE)。
