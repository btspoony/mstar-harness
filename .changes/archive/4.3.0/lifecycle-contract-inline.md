---
category: Harness
packages: root
---

- `mstar-artifacts/references/plan-workflow-lifecycle-contract.md` is rewritten from 161 append-only lines to 59 lines in which every clause is live: the three dated amendments are inlined into the sections they govern, the clauses those amendments themselves declared frozen/historical (§3 file evidence/ordering, §4(a) file registration primitives, §4(g) file close ordering, §6 file-route seam members, §7 scope-decision table whose answers were already restated live) are deleted, and every `packages/engine/src/*:<lines>` anchor is dropped in favor of the symbol name — the file's own header declared those ranges orientation-only.
- The retired file execution route is kept as one historical line (it existed until 2026-10) instead of ~80 lines of frozen description; the ACTIVE store route, delivery-kind declaration, §3 route table, §4a–g evidence contracts, §5 failure semantics and §6 seams S1–S3 all survive with unchanged section numbering, so existing `§1`/`§4a`/`§5` pointers elsewhere in the corpus keep resolving.
- The `mstar migrate` contradiction is settled from source: the 2026-10-10 "kept migration tooling writes staging via `mstar migrate`" clause contradicted the 2026-10-12 amendment and `status-and-residuals.md`. Verified behavior (CLI run 2026-11-08): `mstar migrate` refuses with `migrate.verb-retired` (exit 1) and names the `mstar store upgrade --operator <name> --harness <control-root>` recovery; the contract now states exactly that, agreeing with `status-and-residuals.md`.
- Dependents repointed at surviving sections: `SKILL.md` (4 pointers, "closing amendment File-route retirement" wording removed), `status-and-residuals.md` (root-register close → §4g; "structural-amendment writer" wording removed), `plan-quality-bar.md` §8 (→ §3 routes / §4 evidence contracts), `templates/plan.main.md` (→ §3–§5).

<!-- CN -->
- `mstar-artifacts/references/plan-workflow-lifecycle-contract.md` 由 161 行 append-only 改写为 59 行全 live 条文：三条带日期的 amendment 内联进各自统辖的章节；被 amendment 自身宣布冻结/历史化的条款（§3 文件证据与顺序、§4(a) 文件注册原语、§4(g) 文件关闭顺序、§6 文件路线 seam 成员、§7 答案已在正文复述的决策表）删除；所有 `packages/engine/src/*:<lines>` 锚点改为符号名——文件自己的头部就声明这些区间仅为导览。
- 已退役的文件执行路线保留为一行历史陈述（存在至 2026-10），而非约 80 行冻结描述；ACTIVE store 路线、delivery-kind 声明、§3 路由表、§4a–g 证据契约、§5 失败语义与 §6 seam S1–S3 全部保留且章节编号不变，语料中既有的 `§1`/`§4a`/`§5` 指针继续可解析。
- `mstar migrate` 矛盾按源码裁定：2026-10-10 的「保留迁移工具经 `mstar migrate` 写 staging」条款与 2026-10-12 amendment 及 `status-and-residuals.md` 相互矛盾。实测行为（2026-11-08 运行 CLI）：`mstar migrate` 以 `migrate.verb-retired` 拒绝（exit 1）并指名 `mstar store upgrade --operator <name> --harness <control-root>` 恢复路径；契约现在如实陈述，与 `status-and-residuals.md` 一致。
- 依赖方改指存活章节：`SKILL.md`（4 处指针，删除 "closing amendment File-route retirement" 措辞）、`status-and-residuals.md`（root-register close → §4g；删除 "structural-amendment writer" 措辞）、`plan-quality-bar.md` §8（→ §3 路由 / §4 证据契约）、`templates/plan.main.md`（→ §3–§5）。
