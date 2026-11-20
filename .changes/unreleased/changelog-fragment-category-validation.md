---
category: Fixed
packages: root
---

- An unreleased changelog fragment whose `category:` is not one of the six changelog kinds is now rejected by the PR test suite, not only by release preparation; the stale `Harness` fragment that failed the last release prep was corrected to `Added`.

<!-- CN -->
- 未发布的 changelog fragment 若 `category:` 不属于六种变更类型，现在会由 PR 测试套件拒绝，而不再只在 release 准备阶段才被发现；导致上次 release 准备失败的遗留 `Harness` fragment 已修正为 `Added`。
