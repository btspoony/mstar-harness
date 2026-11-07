---
category: Harness
packages: root
---

- Added **Guard 9** to `bun run validation:drift`: every shipped `skills/**` Markdown file is capped by `scripts/skill-budgets.manifest.json`, whose ceilings are the file's size at introduction (rounded up to a multiple of 10, floor 20). A file over its ceiling fails, and so does manifest drift in either direction — a stale entry (`manifest-stale`) or a shipped file with no ceiling (`budget-missing`).
- The ceilings are guardrails frozen at today's sizes, not reduction targets: a file at or below its ceiling never has to shrink, and raising a ceiling is legal when the PR justifies the added words (relocate → condense → raise).

<!-- CN -->
- 在 `bun run validation:drift` 中新增 **Guard 9**：每个随包发布的 `skills/**` Markdown 文件由 `scripts/skill-budgets.manifest.json` 设定行数上限，上限取文件引入时的体积（向上取整到 10 的倍数，下限 20）。超过上限的文件失败；manifest 双向漂移同样失败——过期条目（`manifest-stale`）或未登记上限的发布文件（`budget-missing`）。
- 上限是冻结在当下体积的护栏，不是缩减目标：处于或低于上限的文件永远不需要缩短；只要 PR 说明了新增文字的理由，"迁移 → 压缩 → 提高上限"中的提高上限就是允许的。
