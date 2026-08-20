---
category: Harness
packages: root, cli, dsh, engine, opencode
---
- New gitignored repo-local config **`.mstarc`** (`[config] harness_dir=<dir>`) lets repos with a non-default harness root declare it programmatically — `resolveHarnessDir` honors it above probing (explicit `opts.harnessDir` / `MSTAR_HARNESS_DIR` still win), `sddWorkspace` follows, and the canonical `.gitignore` snippets (engine / CLI init fence / plan-conventions) ignore `.mstarc` by default. Resolution order SSOT updated in `mstar-plan-conventions` § {HARNESS_DIR} 解析顺序.

<!-- CN -->
- 新增 gitignored 的仓库本地配置 **`.mstarc`**（`[config] harness_dir=<dir>`）：harness 根非默认名的仓库可在其中程序化声明根目录——`resolveHarnessDir` 优先于探测读取它（显式 `opts.harnessDir` / `MSTAR_HARNESS_DIR` 仍最高优先），`sddWorkspace` 同步遵循，canonical `.gitignore` 片段（engine / CLI init fence / plan-conventions）默认忽略 `.mstarc`。解析顺序 SSOT 已更新至 `mstar-plan-conventions` § {HARNESS_DIR} 解析顺序。
