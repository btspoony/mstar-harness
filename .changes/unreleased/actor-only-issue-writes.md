---
category: Harness
packages: root, engine
---

- **Issue writes are actor-only:** every unscoped issue write verb, including `link`, records through the store without a session envelope or workflow requirement.
- Plan issue-add/issue-close use the workflow's primary coordinator and explicit plan address; plan/iteration link targets remain labels, not independently checked authorities.
- **Workflow creator fidelity.** Imported workflow creator identity is preserved, and first-bind adoption is limited to workflows with a NULL creator.

<!-- CN -->
- **Issue 写入改为仅基于 actor：**所有非 plan-scoped issue 写动词（包括 `link`）均直接记录到 store，不再要求 session envelope 或 workflow。
- Plan issue-add/issue-close 使用 workflow 的唯一 primary coordinator 与明确 plan 地址；plan/iteration 链接目标仍为标签，不构成独立权限校验。
- **工作流创建者信息保真。** 导入时保留工作流创建者身份；首次绑定仅允许创建者为 NULL 的工作流采用。
