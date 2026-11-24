---
category: Fixed
packages: root
---

- **The cutover-required disclosure no longer implies a released 4.8.x build can use the store after activation.** The execution schema is never lowered, so that build refuses it as `store.schema-unsupported` even after the cutover; the failure now says so and names this newer build as the one that completes the ladder.

<!-- CN -->
- **cutover-required 披露不再暗示已发布的 4.8.x 版本在激活后可用该库。** execution schema 从不回退，因此该版本即使走完 cutover 仍以 `store.schema-unsupported` 拒绝；失败信息现在明说这一点，并指名由这个更新的版本完成迁移阶梯。
