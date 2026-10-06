---
category: Harness
packages: root
---

- **Issue writes are actor-only:** every unscoped issue write verb, including `link`, records through the store without a session envelope or workflow requirement.
- Plan issue-add/issue-close use the workflow's primary coordinator and explicit plan address; plan/iteration link targets remain labels, not independently checked authorities.

<!-- CN -->
- **Issue 写入改为仅基于 actor：**所有非 plan-scoped issue 写动词（包括 `link`）均直接记录到 store，不再要求 session envelope 或 workflow。
- Plan issue-add/issue-close 使用 workflow 的唯一 primary coordinator 与明确 plan 地址；plan/iteration 链接目标仍为标签，不构成独立权限校验。
