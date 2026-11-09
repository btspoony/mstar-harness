---
category: Harness
packages: engine, commands, cli, root
---

- Added `mstar lint --type specs` and `--type adr`. Specs are checked by `lintSpecsTree` / `lintSpecsDoc`: `{class}/` location, no `-v<N>` suffix or date prefix, no history directory, the required `Scope` / `Current state` / `Invariants` / `Where it lives` / `Change obligations` skeleton, banned ADR sections, README index links and local-path disclosure. ADR trees are checked by `lintAdrTree`: four buckets (`proposed` / `implemented` / `rejected` / `archived`), class membership, `Status` agreeing with the directory, one `Archived: YYYY-MM-DD — …` line on archived records, required and banned sections, filename shape and fence closure.
- Made `scripts/adr-check.ts` a thin adapter over `lintAdrTree`, so the repository's Guard 12 gate and the product command share one implementation.
- Defined the three document layers in `mstar-artifacts/references/knowledge-and-designs.md`: knowledge = reusable experience and methodology, specs = the current state kept true to code, ADR = one decision with its real alternatives and cost. Added the spec skeleton and admission, the ADR four-state lifecycle with archived admission and freeze, per-layer naming, the retirement rule (tracked layers hold no version history; history lives in Git and ADRs), and the process-artifact table. The lifecycle rule lands here; the repository's own `docs/adr` contract and archive directories follow in the stacked PR.
- Narrowed the boundary prose in `mstar-conventions` and `mstar-knowledge` to pointers and updated the `mstar-artifacts` index.

<!-- CN -->
- 新增 `mstar lint --type specs` 与 `--type adr`。specs 由 `lintSpecsTree` / `lintSpecsDoc` 校验：`{class}/` 位置、禁止 `-v<N>` 后缀与日期前缀、禁止历史目录、必填 `Scope` / `Current state` / `Invariants` / `Where it lives` / `Change obligations` 骨架、禁用 ADR 小节、README 索引链接与本地路径披露。ADR 树由 `lintAdrTree` 校验：四桶（`proposed` / `implemented` / `rejected` / `archived`）、class 成员、`Status` 与目录一致、archived 记录的 `Archived: YYYY-MM-DD — …` 行、必填/禁用小节、文件名形状与围栏闭合。
- 将 `scripts/adr-check.ts` 改为 `lintAdrTree` 的薄壳，使仓库的 Guard 12 门禁与产品命令共享同一实现。
- 在 `mstar-artifacts/references/knowledge-and-designs.md` 定义三层文档：knowledge 为可复用经验与方法论，specs 为随代码保持为真的当前状态，ADR 为单一决策及其真实备选与代价；补充 specs 骨架与准入、ADR 四态生命周期（含 archived 准入与冻结）、按层命名、退化规则（tracked 层不承载版本历史，历史在 Git 与 ADR）以及过程产物表。生命周期规则在此 PR 落地；本仓库自己的 `docs/adr` 合同与归档目录在堆叠 PR 中跟进。
- 将 `mstar-conventions` 与 `mstar-knowledge` 的边界表述收窄为指针，并更新 `mstar-artifacts` 索引。
