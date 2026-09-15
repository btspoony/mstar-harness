---
category: Harness
packages: root
---

- Added a **plan-scoped primary entry** to `/iteration-drive`: `--assignment <absolute-md-path>`, `--workflow <id> --plan <id>` and the explicit `--resume <absolute-session-json-path>` form drive one prepared plan in an independent primary session. That session stops at a durable **handoff** — `Done` and both lease releases stay with the iteration coordinator after it verifies the merge. A second fresh entry for the same plan fails as a duplicate holder; malformed nonempty arguments fail closed, and no arguments keep the whole-iteration route.
- The scoped terminal is **transport, not a dependency**: any terminal works, and Herdr / tmux are optional — ownership never reads pane state, TTL or terminal labels. Usage: `README.md` / `README_CN.md`; recipe: `docs/plan-scoped-pm.md`.
- Added seven `plan-scope-*` cases to the PM routing-eval corpus covering both addressing forms, duplicate entry, unknown arguments, last-plan stop, `Done`-before-integration refusal, the no-argument route and the leaf boundary.

<!-- CN -->
- `/iteration-drive` 新增 **plan 级 scoped 入口**：`--assignment <绝对 md 路径>`、`--workflow <id> --plan <id>` 与显式的 `--resume <绝对 session json 路径>` 形态在独立 primary 会话中只驱动一个已 prepare 的 plan。该会话止于一次可持久化的 **handoff**——`Done` 与两个 lease 的释放仍由 coordinator 在验证合并后完成。同一 plan 的第二次 fresh 入口以重复持有被拒绝；非空但畸形的参数 fail closed；无参数仍走整迭代路线。
- scoped 终端是**传输方式，不是依赖**：任意终端均可，Herdr / tmux 均为可选——所有权不读 pane 状态、TTL 或终端标签。用法见 `README.md` / `README_CN.md`；配方见 `docs/plan-scoped-pm.md`。
- PM 路由回归语料新增七个 `plan-scope-*` 场景，覆盖两种寻址形态、重复入口、未知参数、最后一个 plan 的停止、合并前标 `Done` 的拒绝、无参数路线与 leaf 边界。
