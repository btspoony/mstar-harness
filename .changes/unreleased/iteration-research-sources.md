---
category: Harness
packages: root
---

- **Iteration Phase 1 now reads ADR proposals and open issues as research sources.** §1.1 gains two steps: resolve `{ADR_DIR}` via `mstar path resolve` and read `proposed/**/*.md` `Problem` / `Proposal` / `Acceptance criteria`, and read the issue store through `mstar status tech-debt` plus `mstar issue list --disposition open`. Both record an absent source explicitly, and bucket or capture semantics stay with their owning docs instead of being restated.
- **The autonomous direction-lock ranking covers both sources.** Open issues rank directly after a committed deferral (`critical` / `high` first, milestone-linked issues as delivery evidence), proposed ADRs rank above strategy alignment, and every shortlisted candidate must cite a path or an issue id.

<!-- CN -->
- **迭代 Phase 1 现把 ADR proposals 与 open issues 作为研究来源。** §1.1 新增两步：经 `mstar path resolve` 解析 `{ADR_DIR}` 并读 `proposed/**/*.md` 的 `Problem` / `Proposal` / `Acceptance criteria`，以及经 `mstar status tech-debt` 与 `mstar issue list --disposition open` 读 issue store。两者都在来源缺失时明确记录 absence，桶语义与捕获契约仍留在各自权威文档、不复述。
- **autonomous direction lock 的排序覆盖这两个来源。** open issues 紧跟已承诺的 deferral（`critical` / `high` 优先，关联 milestone 的 issue 视为交付证据），proposed ADRs 排在战略对齐之前，且每个入选候选须引用 path 或 issue id。
