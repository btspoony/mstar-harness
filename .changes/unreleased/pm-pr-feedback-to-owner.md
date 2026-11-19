---
category: Harness
packages: root
---

- Route post-open PR CI failures and review findings back to the owning dispatched implementer session; record the PR/session association and replace an owner only with evidence that it cannot resume.
- Allow a first owner assignment only after checking the PR/branch's Assignment records, PM Task Board/status records and any available host dispatch history verifies that no implementer was ever assigned. Incomplete history, human PR authorship or a single missing record is not proof; when unconfirmed, follow existing owner recovery.

<!-- CN -->
- PR 打开后的 CI 失败与评审意见回给原持有 PR 的已派发实现会话；记录 PR/会话关联，仅在有证据表明原会话无法恢复时重新委派。
- 仅在检查 PR/分支的 Assignment 记录、PM Task Board/status 记录及可用宿主派发历史，确认从未分配实现者后，才允许首次派发持有会话。历史不完整、人工创建 PR 或单条记录缺失均不构成证明；无法确认时沿用既有持有者恢复流程。
