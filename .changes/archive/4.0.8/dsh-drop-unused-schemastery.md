---
packages: dsh
---

- **Removed the unused npm `schemastery` devDependency from the dsh plugin.** The plugin imports the hosted `@deepseek-ai/schemastery` peer fork only, so the devDependency backed no import; `bun.lock` drops it (and its `cosmokit` transitive) with no other dependency change.

<!-- CN -->
- **移除 dsh 插件中未被使用的 npm `schemastery` devDependency。** 该插件只导入宿主提供的 `@deepseek-ai/schemastery` peer fork，该 devDependency 没有任何导入支撑；`bun.lock` 随之移除它（及其传递依赖 `cosmokit`），其余依赖不变。
