---
category: Harness
packages: root
---

- Added a **plan-scoped primary entry** to `/iteration-drive`: `--assignment <absolute-md-path>`, `--workflow <id> --plan <id>` and the explicit `--resume <absolute-session-json-path>` form drive one prepared plan in an independent primary session. That session stops at a durable **handoff** — `Done` and both lease releases stay with the iteration coordinator after it verifies the merge. A second fresh entry for the same plan fails as a duplicate holder; malformed nonempty arguments fail closed, and no arguments keep the whole-iteration route.
- The scoped session owns one plan row: it reads with `show` and writes only `progress`, `residual-add`, `residual-close` and `handoff`, leaving sibling rows, lifecycle anchors, the root register, the shared indexes, the iteration PR and Phase 3–6 to the coordinator. User guide: `docs/commands.md` — the unified command reference this change ships, with the scoped session as its `/iteration-drive` section; CLI flags and exit codes: `docs/cli.md`.
- The scoped terminal is **transport, not a dependency**: any terminal works, and Herdr / tmux are optional — ownership never reads pane state, TTL or terminal labels.
- Added seven `plan-scope-*` cases to the PM routing-eval corpus covering both addressing forms, duplicate entry, unknown arguments, last-plan stop, `Done`-before-integration refusal, the no-argument route and the leaf boundary. The `mstar plan` transport itself is recorded in `.changes/unreleased/plan-coordination.md`.
- Because `/iteration-drive` now advertises its argument shapes in the command frontmatter, the dsh client-claim table that pins every `input:` hint (`packages/dsh/tests/commands.spec.ts`) moved to the new hint, so the composer ghost text offers the scoped forms instead of executing the bare command.

<!-- CN -->
- `/iteration-drive` 新增 **plan 级 scoped 入口**：`--assignment <绝对 md 路径>`、`--workflow <id> --plan <id>` 与显式的 `--resume <绝对 session json 路径>` 形态在独立 primary 会话中只驱动一个已 prepare 的 plan。该会话止于一次可持久化的 **handoff**——`Done` 与两个 lease 的释放仍由 coordinator 在验证合并后完成。同一 plan 的第二次 fresh 入口以重复持有被拒绝；非空但畸形的参数 fail closed；无参数仍走整迭代路线。
- scoped 会话只拥有一个 plan 行：用 `show` 读取，只写 `progress`、`residual-add`、`residual-close` 与 `handoff`；兄弟行、生命周期锚点、根 register、共享索引、迭代 PR 与 Phase 3–6 均留给 coordinator。用户指南：`docs/commands.md`——本次变更附带的统一命令参考，scoped 会话即其中的 `/iteration-drive` 章节；CLI 标志与退出码：`docs/cli.md`。
- scoped 终端是**传输方式，不是依赖**：任意终端均可，Herdr / tmux 均为可选——所有权不读 pane 状态、TTL 或终端标签。
- PM 路由回归语料新增七个 `plan-scope-*` 场景，覆盖两种寻址形态、重复入口、未知参数、最后一个 plan 的停止、合并前标 `Done` 的拒绝、无参数路线与 leaf 边界。`mstar plan` 传输层本身记录在 `.changes/unreleased/plan-coordination.md`。
- 由于 `/iteration-drive` 现在在命令 frontmatter 中公布其参数形态，钉住每条 `input:` hint 的 dsh 客户端 claim 表（`packages/dsh/tests/commands.spec.ts`）已同步到新 hint，使输入框 ghost text 提供 scoped 形态而非直接裸执行命令。
