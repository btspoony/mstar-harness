---
category: Harness
packages: root, cli, dsh, engine, opencode
---
- Harness dir is uniformly `.mstar/` across the repo: maintenance docs moved under `.mstar/docs/`, the legacy maintenance root is gone, and probe/override docs no longer reference a legacy root name. `harnessDir` / `MSTAR_HARNESS_DIR` semantics unchanged — explicit override wins; probe order stays `.mstar/` → `.agents/` → `.plans/`/`plans/`.
- `drift-lint` roadmap-citation exemption now recognizes `.mstar/`-prefixed citations (gitignored roadmap/ADR docs); engine/dsh/opencode source citations updated to the new path.

<!-- CN -->
- 本仓 harness 目录统一为 `.mstar/`：维护文档并入 `.mstar/docs/`，旧维护根目录移除，探测/override 文档不再提及旧根名。`harnessDir` / `MSTAR_HARNESS_DIR` 语义不变——显式 override 优先；探测顺序保持 `.mstar/` → `.agents/` → `.plans/`/`plans/`。
- `drift-lint` 的 roadmap 引用豁免现识别 `.mstar/` 前缀（gitignored roadmap/ADR 文档）；engine/dsh/opencode 源码引用已更新到新路径。
