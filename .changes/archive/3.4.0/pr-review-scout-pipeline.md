---
category: Harness
packages: root, opencode
---

- Reworked single-PR deep review into a **three-stage pipeline** (collect → domain review → synthesis): lightweight read-only collect seats fan out by domain, mstar built-in roles review code + security per domain, and the main agent dedupes, three-way vets, and publishes the single GitHub Review. Posting ownership moved to the main agent — review seats never post. Fan-out is scale-driven, reusing the existing ~300-line sizing band.

<!-- CN -->
- 将单 PR 深审重构为**三阶段流水线**（收集 → 领域审查 → 主代理合成）：轻量只读收集席按领域扇出，mstar 内置角色按领域做 code+security 审查，主代理去重、三路核验并发布唯一一条 GitHub Review。发布权移交主代理，领域席/收集席不发布。扇出规模驱动，复用既有 ~300 行规模带。
