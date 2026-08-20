---
category: Harness
packages: root, cli, dsh, engine, opencode
---
- `.mstarc` now supports every harness directory symbol under `[config]`: `plan_dir`, `sdd_dir` (per-plan base), `iteration_dir`, `knowledge_dir`, `specs_dir` (authoritative — skips the candidate chain) alongside `harness_dir`. The engine resolvers (`resolvePlanDir` / `resolveSddDir` / `resolveIterationDir` / `resolveKnowledgeDir` / `resolveSpecsDir`) honor them from the nearest `.mstarc` at the harness dir or its parent; `mstar_path_resolve` reports the knowledge dir too.

<!-- CN -->
- `.mstarc` 现在支持 `[config]` 下的全部 harness 目录符号：`plan_dir`、`sdd_dir`（per-plan 基目录）、`iteration_dir`、`knowledge_dir`、`specs_dir`（权威——跳过候选链），外加 `harness_dir`。engine 各解析器（`resolvePlanDir` / `resolveSddDir` / `resolveIterationDir` / `resolveKnowledgeDir` / `resolveSpecsDir`）从 harness 目录或其父目录的最近 `.mstarc` 读取；`mstar_path_resolve` 同时输出 knowledge 目录。
