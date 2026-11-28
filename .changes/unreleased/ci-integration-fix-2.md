---
category: Fixed
packages: commands, opencode, cli
---

- **`mstar lint` refusals carry one literal recovery per branch.** The recovery no longer interpolates the caller's `--type` value, so `lint:refusal-quality` proves it statically; `--type acceptance` keeps its own arm because the filename inference never reproduces that type, and the generic arm tells the caller to repeat the flag it supplied. No allowlist entry was added.
- **The engine-absent inertness fixture stubs the current engine import surface.** The stub still exported names `packages/opencode/src/mstar.ts` no longer imports and was missing `readAssignmentSource`, `assignmentFrontmatterEntries` and `parseAssignmentFieldsFromFrontmatter`, so the copied plugin failed to load and the probe exited 1 with one stderr line instead of proving the hook inert.
- **The `issue obsolete` end-to-end case declares its own 30s budget.** It spawns the built bundle about eleven times, so the default 5s bound fails on a loaded `test-cli-ops-a` shard (reproduced at 5.08s under CPU contention); no assertion changed.

<!-- CN -->
- **`mstar lint` 的拒绝分支各自携带一条字面量恢复文本。** 恢复文本不再插值调用方的 `--type` 值，因此 `lint:refusal-quality` 可以静态证明它；`--type acceptance` 保留独立分支（文件名推断不会产生该类型），通用分支提示调用方重述自己提供的 flag。未新增 allowlist 条目。
- **engine-absent 惰性测试的桩已对齐当前 engine 导入面。** 该桩仍在导出 `packages/opencode/src/mstar.ts` 已不再导入的名字，且缺少 `readAssignmentSource`、`assignmentFrontmatterEntries` 与 `parseAssignmentFieldsFromFrontmatter`，导致被复制到临时项目的插件加载失败、探针以一行 stderr 退出 1，而不是证明 hook 保持惰性。
- **`issue obsolete` 端到端用例自带 30s 预算。** 它约十一次拉起构建产物，默认 5s 上限在负载的 `test-cli-ops-a` 分片上会失败（在 CPU 争用下复现为 5.08s）；断言未改。
