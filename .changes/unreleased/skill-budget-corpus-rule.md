---
category: Harness
packages: root
---

- `mstar-skill-authoring` now states the `skills/**` corpus gates in place of the unenforceable "long bodies barely help" sentence: per-file line ceilings in `scripts/skill-budgets.manifest.json` (Guard 9), duplicate HARD-rule wording (Guard 10) and paragraph anchoring (Guard 11), all under `bun run validation:drift`. **Guard 9 blocks** on a file over its ceiling, a stale manifest entry, or a shipped skill file with no entry; **Guard 10 blocks** on a duplicate HARD-rule group; **Guard 11 is advisory today** and prints its measured count plus the offending lines.
- The ceiling policy is stated as an operative rule rather than history: ceilings are guardrails, not reduction targets, so a file at or below its ceiling never has to shrink, and the only legal response to a ceiling is **relocate → condense → raise**, with the raise justified in the same PR. The advisory wording binds new and modified text now — a repeated HARD-rule sentence becomes a pointer to its canonical home, and a new or modified paragraph is written on one physical line.
- `AGENTS.md` names `bun run validation:drift` as the enforcement surface for `skills/**`, and points at the manifest for the ceilings and at `mstar-skill-authoring` for the rules themselves.

<!-- CN -->
- `mstar-skill-authoring` 现在改用 `skills/**` 语料门禁取代原先不可执行的"过长 body 几乎无提升"一句：`scripts/skill-budgets.manifest.json` 中的逐文件行数上限（Guard 9）、跨文件重复 HARD 规则（Guard 10）与段落锚定（Guard 11），全部由 `bun run validation:drift` 执行。**Guard 9 为阻断级**：文件超过自身上限、manifest 条目过期、或随包 skill 文件没有条目都会失败；**Guard 10 为阻断级**：重复的 HARD 规则组即失败；**Guard 11 今天为建议级**，打印实测数量及违规位置。
- 上限政策以可执行规则而非历史叙述写就：上限是护栏而非缩减目标，处于或低于上限的文件永不要求缩短；对上限的唯一合法响应是 **迁移 → 压缩 → 提高上限**，且提高上限须在同一 PR 内说明理由。建议级措辞即刻约束新增与修改的文字——重复的 HARD 规则句改写为指向规范处的指针，新增或修改的段落写成单个物理行。
- `AGENTS.md` 指明 `bun run validation:drift` 是 `skills/**` 的执行面，并指向 manifest 查看上限、指向 `mstar-skill-authoring` 查看规则本身。
