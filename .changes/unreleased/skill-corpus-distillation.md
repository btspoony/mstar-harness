---
category: Harness
packages: root
---

- Added **Guard 13**: the `mstar-harness-core` skill index and the `skills/mstar-*` directories must agree in both directions.
- Added **Guard 14**: a widened lint exemption (an allowlist entry or a raised skill-budget ceiling) must carry the artifact it exempts in the same change, compared by parsed JSON rather than line counts.
- Added the `skill-corpus-audit` audit variant: concept overlap, stale references, promotion candidates and resident-description cost, with a reason-quality rule and an owner approval gate.
- Added a `Depth Lens` with seven fixed terms and four decisions tests, and a `Spec-Fidelity Lens` for acceptance-criterion traceability; both attach to QC1 without adding a seat.
- `clarify` now asks every frontier question without an unsettled prerequisite in one round, and asks a style or convention fork alone.
- Skill authoring now states completion criteria (clarity and demand) and the no-op / negation judgements.
- The PR body must carry Evidence and Merge danger (`Door` / `Blast radius`); `mstar-pr-loop` reports their presence.
- Audit findings classify their fix as `mechanical` (routes to a deterministic check) or `judgement` (routes to a standard), and a plan task lists the direct consumers its change affects.

<!-- CN -->
- 新增 **Guard 13**：`mstar-harness-core` 的 skill 索引与 `skills/mstar-*` 目录须双向一致。
- 新增 **Guard 14**：放宽 lint 豁免（allowlist 条目或提高 skill 预算上限）必须在同一变更集中带上它所豁免的产物，按解析后的 JSON 比较而非行数。
- 新增 `skill-corpus-audit` 审计变体：概念重叠、过时引用、提升候选与常驻 description 成本，附理由质量规则与 owner 批准门。
- 新增 `Depth Lens`（七个固定词与四项判定测试）与 `Spec-Fidelity Lens`（验收标准可追溯）；两者挂在 QC1 上，不增加席位。
- `clarify` 现按 frontier 一轮问完无未定前置的问题，风格/惯例分叉单独提问。
- skill 撰写新增完成判据（clarity 与 demand）以及 no-op / negation 判定。
- PR 正文须含 Evidence 与 Merge danger（`Door` / `Blast radius`）；`mstar-pr-loop` 报告其是否存在。
- 审计发现的修复分为 `mechanical`（转确定性检查）与 `judgement`（转标准），plan 任务须列出其变更影响的直接消费者。
