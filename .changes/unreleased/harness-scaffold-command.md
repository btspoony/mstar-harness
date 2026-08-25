---
packages: root, engine, cli
---
- Added **`mstar harness scaffold [path]`** (default cwd): one-shot harness bootstrap — engine `scaffoldHarness` now also prebuilds `projects/_default/` (`roadmap.md` with valid `validateRoadmap` frontmatter + `## Direction` placeholder, and an empty `residuals.json` passing `validateProjectRegister`); the CLI appends the canonical `.gitignore` snippet when absent, writes a minimal `.mstar/AGENTS.md` when absent, and prints a created/skipped summary. Idempotent — re-running on an initialized tree only creates missing pieces.
- `mstar path resolve` failure guidance now points to `mstar harness scaffold` instead of `mstar init`.

<!-- CN -->
- 新增 **`mstar harness scaffold [path]`**（默认 cwd）一次性 harness 初始化：engine `scaffoldHarness` 现同时预建 `projects/_default/`（`roadmap.md` 含通过 `validateRoadmap` 的 frontmatter 与 `## Direction` 占位，以及通过 `validateProjectRegister` 的空 `residuals.json`）；CLI 在缺失时追加 canonical `.gitignore` snippet、写入最小 `.mstar/AGENTS.md`，并打印 created/skipped 摘要。幂等 —— 在已初始化树上重跑只补缺失件。
- `mstar path resolve` 失败指引由 `mstar init` 改为 `mstar harness scaffold`。
