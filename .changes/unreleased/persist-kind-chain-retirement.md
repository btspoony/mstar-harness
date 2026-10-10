---
packages: root, engine, commands
---

- Restrict the `mstar persist` family to `review` and `json`; engine `status` and `snapshot` kinds remain internal to the migration path, whose permanent consumer is `migrate.ts`.
- Retire the coordinated artifact read/replace chain and its public exports. The coordinated purge-entry veto remains deferred to the T21 terminal sweep.

<!-- CN -->
- 将 `mstar persist` 家族限制为 `review` 和 `json`；engine 的 `status` 与 `snapshot` kind 仍仅用于迁移路径，其永久调用方为 `migrate.ts`。
- 退役 coordinated artifact 读取/替换链及其公共导出。coordinated purge-entry veto 仍延期至 T21 terminal sweep 处理。
