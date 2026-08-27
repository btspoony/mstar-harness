---
category: Harness
packages: root, cli, engine
---

- Added a pluggable **ArtifactStore** for JSON coordination docs: `status.json`, workflow snapshots, and project residuals now persist through `ArtifactStore.put` / `get` (default `FsStore` keeps the existing `{HARNESS_DIR}` paths and atomic-write semantics). Integrations can mount their own store in-process via `setArtifactStore` or per-command via `MSTAR_STORE_MODULE` / `--store` — filesystem paths only, URI schemes are rejected before `import()`.
- Added `mstar-harness persist <kind> --key <key> [--file <path>|--stdin] [--store <module>] [--schema <id>]` and `mstar-harness persist get <kind> --key <key> [--store <module>]` for `status` / `snapshot` / `residuals` / `review` / `json`, running the existing kind validators before put.

<!-- CN -->
- 新增可插拔 **ArtifactStore** 用于 JSON 协调文档持久化：`status.json`、workflow snapshots 与 project residuals 现经 `ArtifactStore.put` / `get` 落盘（默认 `FsStore` 保持既有 `{HARNESS_DIR}` 路径与原子写语义）。集成方可经 `setArtifactStore` 在进程内挂载自有存储，或经 `MSTAR_STORE_MODULE` / `--store` 按命令挂载——仅限文件系统路径，URI scheme 在 `import()` 前一律拒绝。
- 新增 `mstar-harness persist <kind> --key <key> [--file <path>|--stdin] [--store <module>] [--schema <id>]` 与 `mstar-harness persist get <kind> --key <key> [--store <module>]`，支持 `status` / `snapshot` / `residuals` / `review` / `json`，put 前先运行既有 kind 校验器。
