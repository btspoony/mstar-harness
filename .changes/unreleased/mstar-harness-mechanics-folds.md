---
category: Harness
packages: root
---

- **History-rewrite push safety**: `mstar-branch-worktree` gains a "History rewrite 与推送安全" section — any history rewrite of an already-pushed branch must first `git fetch` and record the remote **exact OID**, then publish with `--force-with-lease=<branch>:<observed-oid>` (bare `--force` prohibited); after the rewrite, prior review threads / approvals / check results are no longer current evidence and must be re-reviewed before merging; `mstar-iteration`'s phase-4-5 reference now points at that section as the SSOT for rewrite / force-with-lease / evidence-invalidation rules.
- **Authoring devices library**: `skillsbench-authoring.md` gains 6 small composable authoring techniques (calibrated examples file, recall batteries, overcorrection traps, required-explicit-input, questions ≠ write authority, invocation boundary), each mapped onto one or two SkillsBench principles with in-harness instances.
- **Bilingual minimal-update rule**: `AGENTS.md` Core Rules now require the minimal counterpart edit for paired docs (README.md/README_CN.md, packages/dsh README triplets) — never re-translate a document to apply an update — with pairing hashes re-recorded (`git hash-object`) in the same change set.

<!-- CN -->
- **历史改写推送安全**：`mstar-branch-worktree` 新增「History rewrite 与推送安全」节——已推送分支的任何 history rewrite 须先 `git fetch` 记录远端**精确 OID**，再以 `--force-with-lease=<branch>:<observed-oid>` 发布（禁止裸 `--force`）；改写后既有 review threads / approvals / check 结果不再构成当前证据，merge 结论前须重审；`mstar-iteration` phase-4-5 reference 现以该节为 rewrite / force-with-lease / 证据失效规则的 SSOT。
- **装置库（Authoring devices）**：`skillsbench-authoring.md` 新增 6 个小型可组合撰写装置（calibrated examples file、recall batteries、overcorrection traps、required-explicit-input、questions ≠ write authority、invocation boundary），每个映射至一至两条 SkillsBench 原则并附仓内实例。
- **双语最小对照编辑规则**：`AGENTS.md` Core Rules 新增规则——配对文档（README.md/README_CN.md、packages/dsh README 三件套）更新时只做最小对照编辑，**绝不**为应用一处更新而整篇重译，并在同一变更集内重录配对哈希（`git hash-object`）。
