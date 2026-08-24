---
packages: root
---
- **Release prep** now opens a **new** `release vX.Y.Z` PR when the previous one for that branch is closed or merged. It no longer treats `gh pr view` success on a closed PR as “update in place” (that left #131 closed and no new 3.2.2 PR).

<!-- CN -->
- **Release prep** 在同名分支上的上一份 PR 已关闭或已合并时会**新建** `release vX.Y.Z`，不再把 `gh pr view` 对 closed PR 成功当成原地更新（此前会改 #131 正文却不新建 3.2.2 PR）。
