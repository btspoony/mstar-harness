---
category: Harness
packages: root
---

- Aligned the **harness skill corpus and iteration commands** with the ACTIVE `store.db` execution authority: workflow/plan rows, root register, leases, sessions and branch anchors are store-backed, and root `status.json` / workflow `snapshot.json` / `sessions/*.json` instructions remain only as explicit pre-activation or engine-absent fallbacks.
- Replaced retired residual-register and README index duties with **store issues and catalog operations** (`mstar plan issue-add`, `mstar issue add`, `mstar catalog discover/import/link`), preserved append-only workflow notes and authored plan/assignment surfaces, and removed duplicated lease-protocol prose from `mstar-iteration`.
- Clarified store `init`/`upgrade`/`activate` versus the pre-activation bootstrap template in `mstar-conventions` / `mstar-artifacts`, completed the `mstar-use-cli` command-family and execution-refusal indexes, and centralized findings-cleanup semantics at the artifacts authority.
- Aligned `.cursor/skills/mstar-routing-eval/` gate fixtures with the same split: ACTIVE store-transaction/execution-lease arbitration wording, file-flock cases labeled pre-activation (case IDs and expected routes unchanged).

<!-- CN -->
- 将 **harness 技能语料与迭代命令**对齐 ACTIVE `store.db` 执行权威：workflow/plan 行、root register、lease、session 与分支锚点均以 store 为载体；root `status.json` / workflow `snapshot.json` / `sessions/*.json` 指令仅保留为显式标注的激活前或无引擎回退。
- 用 **store issue 与 catalog 动词**（`mstar plan issue-add`、`mstar issue add`、`mstar catalog discover/import/link`）替代已退役 residual register 与 README 登记义务，保留 append-only workflow notes 与 authored plan/assignment 面，并删除 `mstar-iteration` 中重复的 lease 协议正文。
- 澄清 `mstar-conventions` / `mstar-artifacts` 中 store `init`/`upgrade`/`activate` 与激活前 bootstrap 模板的分工，补齐 `mstar-use-cli` 命令族与执行拒绝码索引，并将 findings-cleanup 语义集中到 artifacts 权威。
- 将 `.cursor/skills/mstar-routing-eval/` 门禁 fixtures 同步到该拆分：ACTIVE 用 store 事务 / execution lease 仲裁措辞，文件 flock 场景显式标注 pre-activation（case ID 与期望路由不变）。
