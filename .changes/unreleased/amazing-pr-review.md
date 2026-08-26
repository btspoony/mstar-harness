---
category: Harness
packages: root, opencode
---

- Renamed `/pr-deep-review` → `/amazing-pr-review` with a clean cutover (no alias) and added three review strengths: `quick` (single-pass, 1 seat, collect + review in one pass) / `default` (the no-flag landing tier — 2 domain seats, collection folded in, reduced seats) / `deep` (the former full three-stage pipeline: collect → domain review → main-agent synthesis, 4–7 seats). The tier is chosen by an explicit keyword or inferred from the change shape; the default tier no longer fans out the full seat plan.

<!-- CN -->
- 将 `/pr-deep-review` 改名为 `/amazing-pr-review`（干净切换，无 alias），并落地三档强度：`quick`（单趟 1 席，收集 + 审查同席）/ `default`（无 flag 默认档——2 个领域席，收集合入领域席，席位精简）/ `deep`（原完整三阶段流水线：collect → domain review → main-agent synthesis，4–7 席）。档位由显式关键字或变更形状推断；默认档不再全量扇出完整席位计划。
