---
category: Harness
packages: root
---

- Added the **`mstar-use-cli`** skill as the agent-facing CLI SSOT: a task→command-family index, the precondition ladder (harness-root resolution, control root vs feature worktree, neutral cwd, session envelope, revision and byte tokens), the two canonical sequences (versioned read-modify-write, plan completion), and how to read exit `0` / `1` / `2` — including the argument parser's exit `1` for a missing required argument. Flags are never restated: each command's own `--help` owns them.

- Retired **`docs/cli.md`** by splitting it by audience instead of redirecting: its two install-only sections (Codex agent files, install path layout) moved into `INSTALL.md`, where its own install cross-references plus `packages/cli/AGENTS.md` and `.cursor/LOCAL-VALIDATION.md` now resolve to in-file anchors. The CLI-contract pointers — `README` / `README_CN`, `docs/commands.md`, and the runtime skill references — now point at the **`mstar-use-cli`** skill. The old file is deleted outright: no redirect page and no compatibility layer.

- Extended the **drift guard's CLI inventory** past the CLI entry module into the plan / workflow / sdd registration modules — 16 command paths that were previously invisible, including 13 `plan` verbs — so citing those verbs is now checked instead of silently passing. The same check (declared bin prefix plus a real command path) now also scans the new skill's own markdown, not only the Engine-check callouts.

- Registered the skill in the **runtime load surface**: implementers, reviewers and QA, operations, architecture, harness-text work, and PM load `mstar-use-cli` in their preset menus / load table when the round runs or interprets CLI commands.

- Granted the **QC seats and `code-reviewer`** read-only CLI validators in their bash allowlist (`qc validate-report`, `lint`, `dispatch validate`, `worktree qc-alignment`, `status validate`, `lease verify`), removing the contradiction where a skill required a machine-checked gate the seat had no permission to run.

- Updated the **host support tiers** in the README pair: **`dsh = omp ≥ ZCode = OpenCode = Cursor > Kimi > Codex`**. ZCode now shares a tier with OpenCode and Cursor because its plugin hooks enforce the branch/worktree gates and the engine-backed coordination-write gate at tool-call time — runtime integration in the same class as OpenCode's.

<!-- CN -->
- 新增 **`mstar-use-cli`** skill，作为 CLI 的 agent 面向 SSOT：任务→命令族索引、前置条件阶梯（harness root 解析、control root 与 feature worktree、neutral cwd、session envelope、revision 与 byte token）、两条规范序列（带版本的 read-modify-write、plan 完成序列），以及退出码 `0` / `1` / `2` 的读法——含参数解析器对缺参返回 `1` 的例外。**不复述 flags**：一律以各命令自身 `--help` 为准。

- **`docs/cli.md` 退役**，内容按读者分流而非跳转：仅属安装的两节（Codex agent files、install path layout）迁入 `INSTALL.md`，其自身的安装交叉引用与 `packages/cli/AGENTS.md`、`.cursor/LOCAL-VALIDATION.md` 现由该文件的文内锚点承接。CLI 契约指针——`README` / `README_CN`、`docs/commands.md` 与各 runtime skill 引用——改向 **`mstar-use-cli`** skill。旧文件直接删除：不保留跳转页，也不留兼容层。

- **漂移守卫的 CLI inventory 扩容**：从 CLI 主入口扩展到 plan / workflow / sdd 注册模块——新增 16 条此前不可见的命令路径（含 13 个 `plan` 动词）——引用这些动词现被校验，不再静默通过。同一套校验（声明 bin 前缀 + 真实命令路径）现在也扫描新 skill 自身的 markdown，而不只覆盖 Engine-check callout。

- 该 skill 已登记进**运行时加载面**：实现、审查/QA、运维、架构、harness 文本工作与 PM，在本轮运行或解读 CLI 命令时于各自 preset / 加载表加载 `mstar-use-cli`。

- **QC 三席与 `code-reviewer`** 的 bash 白名单获得只读 CLI 校验命令（`qc validate-report`、`lint`、`dispatch validate`、`worktree qc-alignment`、`status validate`、`lease verify`），消除「skill 要求席位跑机器门禁、席位却无权限执行」的矛盾。

- **README 双语对更新了宿主支持等级**：**`dsh = omp ≥ ZCode = OpenCode = Cursor > Kimi > Codex`**。ZCode 升入与 OpenCode、Cursor 并列的档位：其插件 hooks 已在工具调用时执行分支/worktree 门禁与引擎背书的协调写入门禁，属与 OpenCode 同一档的运行期集成。
