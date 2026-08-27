---
category: Harness
packages: root, cli, engine
---

- Programmatic deferred-PR backlog registration: `mstar status backlog-register` / `mstar status backlog-close` replace the hand-rolled python lock protocol in `skills/mstar-audit/references/pr-review.md`. The engine `appendProjectRegisterEntries` / `closeProjectRegisterEntry` run inside `withStatusWriteLock` with atomic temp+rename writes (crash-safe, fail-loud validation); same-day key bump (`-2`, `-3`, …) and entry-id uniqueness are enforced inside the lock (B-9).

<!-- CN -->
- 将 deferred-PR backlog 注册程序化：`mstar status backlog-register` / `mstar status backlog-close` 取代 `skills/mstar-audit/references/pr-review.md` 中手写的 python 锁协议。engine `appendProjectRegisterEntries` / `closeProjectRegisterEntry` 在 `withStatusWriteLock` 内执行原子 temp+rename 写入（崩溃安全、fail-loud 校验）；同日 key bump（`-2`、`-3`…）与 entry-id 唯一性在锁内强制（B-9）。
