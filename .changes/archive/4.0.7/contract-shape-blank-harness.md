---
category: Changed
packages: commands
---

- **A blank `--harness` now means "unset" in every command family.** The five families that declared `harness: z.string().min(1).optional()` (`status`, `execution-ledgers`, `session`, `plan`, `workflow`) now use the same bare optional-string declaration the rest of the surface already used, so `{harness: ""}` is admitted and resolves exactly like an omitted harness instead of being refused as `command.invalid-input`. `status` also drops the `?? parsed.data.harness` fallback that had become reachable with a blank value and would have resolved an empty root to the process cwd rather than the pinned control root.

<!-- CN -->
- **空 `--harness` 在所有命令族中都表示「未提供」。** 原先使用 `harness: z.string().min(1).optional()` 的五个命令族（`status`、`execution-ledgers`、`session`、`plan`、`workflow`）改为表层其余部分早已使用的裸 optional-string 声明，于是 `{harness: ""}` 会被接受，并与省略 harness 一样解析，而不再以 `command.invalid-input` 拒绝。`status` 同时删除了因空值而变得可达的 `?? parsed.data.harness` 回退——该回退会把空根解析为进程 cwd，而不是固定的控制根。
