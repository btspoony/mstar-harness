---
category: Harness
packages: root, dsh
---

- **The four dsh read-only fan-out scripts are real files now.** `mstar-qc-tri`, `mstar-audit-fanout`, `mstar-pr-seats` and `mstar-review-single` moved byte-identically out of the `dsh-workflow-scripts.md` fenced blocks into `packages/dsh/workflows/*.js` (each body's SHA-256 recorded before the file was created). Inlined in a skill, the shipped artifact could not be read or diffed as a script and could be edited without review.
- **The reference is a call contract.** `skills/mstar-host/references/dsh-workflow-scripts.md` drops from 626 to 115 lines: per script it keeps when to use it, its `meta` identity, the required `args` and their guard, the read-only guarantee, the seat-count routing summary — including the one-seat SDD task review that must not take a roster slot — and the failure surface. No orchestration instruction was cut.
- **`reportsDir` is no longer a required argument.** `mstar-pr-seats` never read it — the seats are read-only and return their findings in the result, so the review run directory belongs to the caller. The guard no longer rejects a call that omits it.
- **The delivery surface is derived, not pinned.** `scripts/dsh-workflow-files-contract.test.ts` reads the shipped set from `packages/dsh/workflows/` and asserts every body parses, `package.json` ships that directory, and the skill's `meta` identities and `**File**` anchors name exactly those files — a rename, an added script or an unshipped directory fails without editing the test. `scripts/dsh-workflow-script-bounds.test.ts` executes the shipped `mstar-audit-fanout.js` instead of extracting its text from Markdown, so the pool-depth behaviour is measured on the file that actually runs.
- `packages/dsh/README.md` gains `§ Workflow scripts` — file, purpose and required `args` — with the Chinese side mirrored and `README.i18n.yaml` re-recorded. The package's `files` list now includes `workflows`, so a published tarball carries the four scripts (`npm pack --dry-run` lists all four), and the recorded package digest in `scripts/packaging-manifests/{manifest,dsh}.json` follows that manifest edit.

<!-- CN -->
- **dsh 四个只读扇出脚本现在是真实文件。** `mstar-qc-tri`、`mstar-audit-fanout`、`mstar-pr-seats` 与 `mstar-review-single` 从 `dsh-workflow-scripts.md` 的围栏块**逐字节**迁入 `packages/dsh/workflows/*.js`（创建文件前先记录每个正文的 SHA-256）。内联在 skill 里时，这份已发布产物既不能被当作脚本读取或 diff，也能在无审查的情况下被改写。
- **参考文档变为调用契约。** `skills/mstar-host/references/dsh-workflow-scripts.md` 由 626 行降至 115 行：每个脚本保留何时使用、`meta` 身份、必需 `args` 及其守卫、只读保证、席位数路由摘要——包括不得占用 roster 席位的单席 SDD task 审查——以及失败面。编排指令一条未删。
- **`reportsDir` 不再是必填参数。** `mstar-pr-seats` 从未读取它——席位是只读的，findings 由结果返回，review run 目录归调用方所有。守卫不再因调用缺省该参数而拒绝。
- **交付面由源派生，而非钉死。** `scripts/dsh-workflow-files-contract.test.ts` 从 `packages/dsh/workflows/` 读取已发布集合，断言每个正文可解析、`package.json` 会发布该目录、且 skill 的 `meta` 身份与 `**File**` 锚点正好指向这些文件——重命名、新增脚本或目录未发布都会失败，无需改测试。`scripts/dsh-workflow-script-bounds.test.ts` 改为执行已发布的 `mstar-audit-fanout.js`，不再从 Markdown 抽取文本，因此池深行为测量的是真正运行的那份文件。
- `packages/dsh/README.md` 新增 `§ Workflow scripts`——文件、用途与必需 `args`——中文侧同步镜像，`README.i18n.yaml` 已重录。该包 `files` 现包含 `workflows`，因此发布的 tarball 会带上这四个脚本（`npm pack --dry-run` 四个全列），`scripts/packaging-manifests/{manifest,dsh}.json` 中记录的包摘要同步该清单改动。
