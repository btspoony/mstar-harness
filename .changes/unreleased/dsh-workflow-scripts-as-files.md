---
category: Harness
packages: root, dsh
---

- **The four dsh read-only fan-out scripts are real files now.** `mstar-qc-tri`, `mstar-audit-fanout`, `mstar-pr-seats` and `mstar-review-single` moved byte-identically out of the `dsh-workflow-scripts.md` fenced blocks into `packages/dsh/workflows/*.js` (each body's SHA-256 recorded before the file was created). Inlined in a skill, the shipped artifact could not be read or diffed as a script and could be edited without review.
- **The reference is a call contract.** `skills/mstar-host/references/dsh-workflow-scripts.md` drops from 626 to 115 lines: per script it keeps when to use it, its `meta` identity, the required `args` and their guard, the read-only guarantee, the seat-count routing summary — including the one-seat SDD task review that must not take a roster slot — and the failure surface. No orchestration instruction was cut.
- **Silent edits now fail.** `scripts/dsh-workflow-files-hash.test.ts` pins each shipped body's SHA-256 and the shipped file set; `scripts/dsh-workflow-script-bounds.test.ts` executes the shipped `mstar-audit-fanout.js` instead of extracting its text from Markdown, so the pool-depth behaviour is measured on the file that actually runs.
- `packages/dsh/README.md` gains `§ Workflow scripts` — file, purpose and required `args` — with the Chinese side mirrored and `README.i18n.yaml` re-recorded. The package's `files` list now includes `workflows`, so a published tarball carries the four scripts (`npm pack --dry-run` lists all four), and the recorded package digest in `scripts/packaging-manifests/{manifest,dsh}.json` follows that manifest edit.

<!-- CN -->
- **dsh 四个只读扇出脚本现在是真实文件。** `mstar-qc-tri`、`mstar-audit-fanout`、`mstar-pr-seats` 与 `mstar-review-single` 从 `dsh-workflow-scripts.md` 的围栏块**逐字节**迁入 `packages/dsh/workflows/*.js`（创建文件前先记录每个正文的 SHA-256）。内联在 skill 里时，这份已发布产物既不能被当作脚本读取或 diff，也能在无审查的情况下被改写。
- **参考文档变为调用契约。** `skills/mstar-host/references/dsh-workflow-scripts.md` 由 626 行降至 115 行：每个脚本保留何时使用、`meta` 身份、必需 `args` 及其守卫、只读保证、席位数路由摘要——包括不得占用 roster 席位的单席 SDD task 审查——以及失败面。编排指令一条未删。
- **静默改动现在会失败。** `scripts/dsh-workflow-files-hash.test.ts` 钉住每个已发布正文的 SHA-256 与文件集合；`scripts/dsh-workflow-script-bounds.test.ts` 改为执行已发布的 `mstar-audit-fanout.js`，不再从 Markdown 抽取文本，因此池深行为测量的是真正运行的那份文件。
- `packages/dsh/README.md` 新增 `§ Workflow scripts`——文件、用途与必需 `args`——中文侧同步镜像，`README.i18n.yaml` 已重录。该包 `files` 现包含 `workflows`，因此发布的 tarball 会带上这四个脚本（`npm pack --dry-run` 四个全列），`scripts/packaging-manifests/{manifest,dsh}.json` 中记录的包摘要同步该清单改动。
