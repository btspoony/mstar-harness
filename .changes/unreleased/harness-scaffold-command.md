---
packages: root, engine, cli
---
- Added **`mstar harness scaffold [path]`** (default cwd): one-shot harness bootstrap — engine `scaffoldHarness` now also prebuilds `projects/_default/` (`roadmap.md` with valid `validateRoadmap` frontmatter + `## Direction` placeholder, and an empty `residuals.json` passing `validateProjectRegister`); the CLI appends the canonical `.gitignore` snippet when absent, writes a minimal `.mstar/AGENTS.md` when absent, and prints a created/skipped summary. Idempotent — re-running on an initialized tree only creates missing pieces.
- `mstar harness scaffold` is now `.mstarc`-aware: it scaffolds into the `.mstarc`-declared `harness_dir` (or the `MSTAR_HARNESS_DIR` override), lands `projects/_default/` under the resolved `project_dir`, and prints the resolved harness/project dirs. The canonical `.gitignore` snippet is appended only for the default `.mstar/` layout — custom harness layouts skip it. The fence now splices `.mstar/**` BEFORE existing `!.mstar/…` re-includes when the broad rule is missing (gitignore last-match-wins), keeping the re-includes effective.
- `mstar path resolve` failure guidance now points to `mstar harness scaffold` instead of `mstar init`.

<!-- CN -->
- 新增 **`mstar harness scaffold [path]`**（默认 cwd）一次性 harness 初始化：engine `scaffoldHarness` 现同时预建 `projects/_default/`（`roadmap.md` 含通过 `validateRoadmap` 的 frontmatter 与 `## Direction` 占位，以及通过 `validateProjectRegister` 的空 `residuals.json`）；CLI 在缺失时追加 canonical `.gitignore` snippet、写入最小 `.mstar/AGENTS.md`，并打印 created/skipped 摘要。幂等 —— 在已初始化树上重跑只补缺失件。
- `mstar harness scaffold` 现遵循 `.mstarc`：按 `.mstarc` 声明的 `harness_dir`（或 `MSTAR_HARNESS_DIR` 覆盖）落盘，`projects/_default/` 落在解析后的 `project_dir` 下，并打印解析后的 harness/project 目录。canonical `.gitignore` snippet 仅对默认 `.mstar/` 布局追加 —— 自定义 harness 布局跳过（自行管理 ignore 规则）。`.gitignore` fence 在宽规则缺失但存在 `!.mstar/…` re-include 时，将宽规则拼接到 re-include 之前（gitignore 后者胜出），保证 re-include 仍生效。
- `mstar path resolve` 失败指引由 `mstar init` 改为 `mstar harness scaffold`。
