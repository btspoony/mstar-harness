---
category: Harness
packages: root
---

- **Issue writes are actor-only:** every unscoped issue write verb, including `link`, records through the store without a session envelope or workflow requirement.
- Plan-scoped `mstar plan issue-add` and `mstar plan issue-close` retain their plan-session behavior; plan/iteration link targets are recorded labels, not existence-checked authorities.

<!-- CN -->
- **Issue 写入改为仅基于 actor：**所有非 plan-scoped issue 写动词（包括 `link`）均直接记录到 store，不再要求 session envelope 或 workflow。
- `mstar plan issue-add` 与 `mstar plan issue-close` 保留 plan session 行为；plan/iteration 链接目标仅作为标签记录，不校验其是否存在。
