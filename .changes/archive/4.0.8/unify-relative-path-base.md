---
category: Changed
packages: commands, cli
---

- **Every dev-command path argument now resolves from one base** (`resolveCliPath(value, context.cwd)`, #537): a relative input is discovered from the invocation workspace's project root — the nearest `package.json`, preferring one declaring `workspaces`, and the workspace itself when no marker exists — so `audit`, `pr-review`, `persist`, `harness scaffold`, `path resolve`, the project plugin root, `store --out` and `iteration gate --compass` answer like the validation family instead of joining the raw workspace directory. Absolute arguments still pass through unchanged, and a run from a monorepo member now reaches the same files as a run from the root.
- Removed the leftover unused imports in the audit family and the dsh host adapter.

<!-- CN -->
- **所有 dev 命令的路径参数现在共用同一个基址**（`resolveCliPath(value, context.cwd)`，#537）：相对输入会从调用工作区的项目根解析——最近的 `package.json`（优先声明了 `workspaces` 的那个），无标记时回退到工作区本身——因此 `audit`、`pr-review`、`persist`、`harness scaffold`、`path resolve`、项目 plugin 根、`store --out` 与 `iteration gate --compass` 的解析行为与 validation 家族一致，而不再直接与工作区目录拼接。绝对参数仍然原样透传，在 monorepo 成员目录中运行与在根目录运行现在指向同一批文件。
- 移除 audit 家族与 dsh 宿主适配器中残留的未使用 import。
