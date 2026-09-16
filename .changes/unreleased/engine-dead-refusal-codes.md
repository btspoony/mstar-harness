---
category: Changed
packages: engine
---

- Removed the dead refusal codes `coordination.not-implemented` and `coordination.lock` from `COORDINATION_ERROR_CODES`; both had zero throw sites, no test assertions, and were never part of the public export surface, so the registry now contains only live codes.

<!-- CN -->
- 从 `COORDINATION_ERROR_CODES` 移除死拒绝码 `coordination.not-implemented` 与 `coordination.lock`；两者均无抛出点、无测试断言、也不在公开导出面上，注册表现已只含存活代码。
