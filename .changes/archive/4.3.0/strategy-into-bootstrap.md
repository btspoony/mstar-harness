---
category: Harness
packages: root
---

- Deleted `mstar-strategy` and gave its artifact to `mstar-knowledge`: the skill and `references/project-knowledge-bootstrap.md` delegated to each other — the skill sent readers to "bootstrap Phase 2", bootstrap sent them back to the skill, and bootstrap cited a `mstar-strategy § Phase 2` section that never existed. Bootstrap now owns the creation flow, in one direction.
- New `mstar-knowledge/references/strategy-document.md` holds the `STRATEGY.md` artifact contract: the six required sections and three optional ones with what each must contain, the `mstar lint` six-section validation, the five-question creation interview, the maintenance triggers and update rules, the `Not to do` list, and the `STRATEGY.md` vs `AGENTS.md`/`CONCEPTS.md`/plan boundary table. No behavioural rule was dropped.
- Bootstrap Phase 2 gains four named sections (`STRATEGY.md shape`, `Six-section validation`, `Creation interview`, `Maintenance triggers`) and keeps the absent/stale/current handling as one paragraph. The file stays at 167 lines under its unchanged 170 ceiling: the detail moved to its own reference instead of the ceiling being raised.
- Repaired every live reference: `mstar-harness-core`'s PM preset and topic index (25 → 24 skills), `mstar-roles`' PM/architect/product-manager presets, `mstar-conventions` (skill text and both `artifact-storage-paths.md` writer rows), `mstar-iteration`'s Phase 1 context step, `mstar-use-cli`'s `mstar lint` owner column, `docs/runtime-reference.md`, `scripts/skill-budgets.manifest.json`, and the engine's `lintStrategySections` comments and `lint.strategy.missing-section` message (the drift guard resolves engine spec citations against `skills/<skill>/SKILL.md`, so that citation had to move with the section).
- Folded the T2 review fix F1: `mstar-knowledge`'s `### Never` list regains `Do not "archive" — delete instead` — its norm survived as Core rule 6, but the merge contract (§6) permits de-duplication only for byte-identical text, so the bullet is restored.

<!-- CN -->
- 删除 `mstar-strategy`，其产物归属 `mstar-knowledge`：该 skill 与 `references/project-knowledge-bootstrap.md` 互相委派 —— skill 把读者送去「bootstrap Phase 2」，bootstrap 又送回该 skill，且 bootstrap 引用了从不存在的 `mstar-strategy § Phase 2`。现在由 bootstrap 单向拥有创建流程。
- 新增 `mstar-knowledge/references/strategy-document.md` 承载 `STRATEGY.md` 产物契约：六个必需节 + 三个可选节及各节必含内容、`mstar lint` 六节校验、五问创建访谈、维护触发与更新规则、`Not to do` 清单，以及 `STRATEGY.md` 与 `AGENTS.md`/`CONCEPTS.md`/plan 的边界表。行为规则一条未丢。
- bootstrap Phase 2 获得四个具名小节（`STRATEGY.md shape`、`Six-section validation`、`Creation interview`、`Maintenance triggers`），absent/stale/current 处理保留为一段。文件在 170 行上限不变的前提下停在 167 行：细节移入独立 reference，而不是抬高上限。
- 修复全部活跃引用：`mstar-harness-core` 的 PM preset 与专题索引（25 → 24 个 skill）、`mstar-roles` 的 PM/architect/product-manager preset、`mstar-conventions`（skill 正文与 `artifact-storage-paths.md` 两处写入方）、`mstar-iteration` 的 Phase 1 上下文步骤、`mstar-use-cli` 的 `mstar lint` 归属列、`docs/runtime-reference.md`、`scripts/skill-budgets.manifest.json`，以及引擎 `lintStrategySections` 注释与 `lint.strategy.missing-section` 消息（drift 护栏会把引擎 spec 引用解析到 `skills/<skill>/SKILL.md`，故该引用必须随节迁移）。
- 折入 T2 评审修复 F1：`mstar-knowledge` 的 `### Never` 清单恢复 `Do not "archive" — delete instead` —— 该规范以 Core rule 6 存活，但合并契约 §6 仅允许对逐字节相同的文本去重，故恢复该条。
