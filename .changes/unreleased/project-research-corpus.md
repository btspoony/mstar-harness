---
category: Harness
packages: root, engine
---

- **Project-scoped research corpus**: theme research (surveys, epic roadmaps, third-party notes) now lives under `{PROJECT_DIR}/<id>/references/` — named as current by `mstar-project-governance` (Scope table), `artifact-storage-paths.md` (new path-SSOT row), and `knowledge-and-designs.md` (boundary: research ≠ specs ≠ knowledge ≠ iteration guides).
- **Engine filename listing**: `PROJECT_REFERENCES_DIR` + `listProjectReferenceFiles(projectDir)` in `packages/engine/src/project.ts` — sorted relative paths (root files + one-level subdirectory files; skips `roadmap.md` / `residuals.json` strays; missing dir → `[]`); directory metadata only, never file bodies, never a markdown schema.

<!-- CN -->
- **项目级研究语料**：主题研究（surveys、epic roadmaps、第三方 notes）现存放于 `{PROJECT_DIR}/<id>/references/` — 由 `mstar-project-governance`（Scope 表）、`artifact-storage-paths.md`（路径 SSOT 新行）与 `knowledge-and-designs.md`（边界：研究 ≠ specs ≠ knowledge ≠ 迭代 guides）命名。
- **Engine 文件名列表**：`packages/engine/src/project.ts` 新增 `PROJECT_REFERENCES_DIR` + `listProjectReferenceFiles(projectDir)` — 返回排序相对路径（根级文件 + 一层子目录文件；跳过 `roadmap.md` / `residuals.json` 游离文件；目录缺失 → `[]`）；仅目录元数据，不读文件正文，不做 markdown schema 校验。
