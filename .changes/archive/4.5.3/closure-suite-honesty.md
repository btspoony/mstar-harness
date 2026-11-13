---
category: Harness
packages: root
---

- **The closure suite states only what it proves.** Its `reviewed re-freeze` test claimed to enforce per-row `beforeSha256` blobs; it never compared a digest. The digests stay in `ablations.json` as freeze history, and the suite now asserts what it actually checks — BASE ancestry and anchor presence/disposition.
- **Policy prose is not pinned anywhere in the suite.** Wording and phrase assertions inside `closure.test.ts` (phase-1 review-chain ordering, `status: locked`, lease identifiers, preset members "named in the role reference", cross-link titles) were deleted rather than re-pinned; the structural facts that remain are headings, file existence and reachability.
- **The five rules that used to be asserted by sentence now name their real owners.** Done ownership = `mstar-harness-core` state machine + PM Acceptance; `none` never waives gates = the role references and the shared leaf boundary; enforcement honesty = the `code-reviewer` seat; PM required reading = the PM role reference; phase transitions = `evaluatePhaseGate` and the PHASE6 behavior suites.

<!-- CN -->
- **closure 套件只声明它真正证明的东西。** 其 `reviewed re-freeze` 测试声称强制逐行 `beforeSha256` blob，实际从未比较任何摘要。摘要留在 `ablations.json` 作为冻结历史，套件改为只断言它真正检查的内容 —— BASE 祖先关系与 anchor 存在性/处置。
- **套件内不再钉任何策略散文。** `closure.test.ts` 里的措辞与短语断言（Phase 1 评审链顺序、`status: locked`、lease 标识符、「preset 成员在角色 reference 中被点名」、交叉引用标题）一律删除而非重新钉死；保留的结构性事实仅为标题、文件存在性与可达性。
- **原先靠句子断言的五条规则改为记录真实归属方。** Done 归属 = `mstar-harness-core` 状态机 + PM Acceptance；`none` 不豁免门禁 = 角色 reference 与共享 leaf 边界；执行诚实 = `code-reviewer` 席位；PM 必读 = PM 角色 reference；阶段跃迁 = `evaluatePhaseGate` 与 PHASE6 行为套件。
