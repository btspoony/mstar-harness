---
category: Harness
packages: root
---

- **Release prep now rewrites `bun.lock`**: `bun run release:prepare` syncs the workspace versions the lockfile records and the root `@mstar-harness/engine` range, then `release:validate` fails a tag whose lockfile still records another workspace version or engine range. A post-release `bun i` leaves the tree clean.

<!-- CN -->
- **发布准备现在会重写 `bun.lock`**：`bun run release:prepare` 同步锁文件记录的各 workspace 版本与根 `@mstar-harness/engine` 版本范围，`release:validate` 也会在锁文件仍记录其他 workspace 版本或 engine 版本范围时判失败。发布后执行 `bun i` 不再留下脏改动。
