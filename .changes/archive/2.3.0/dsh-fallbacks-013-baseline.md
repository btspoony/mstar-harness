---
category: Harness
packages: dsh
---

- **dsh plugin**: `dsh-llm-fallbacks` registry dependency re-anchored to `^0.1.3` (was `^0.1.0-alpha.4`); the fallbacks-probe version-gate test re-anchored to the resolved `0.1.3` (the exact 6-key `FallbacksService` surface assertion is unchanged and remains the executable drift STOP gate). Dist keeps the type-only import — zero runtime imports of the package.

<!-- CN -->
- **dsh 插件**：`dsh-llm-fallbacks` registry 依赖重新锚定至 `^0.1.3`（原 `^0.1.0-alpha.4`）；fallbacks-probe 版本门禁测试重新锚定至解析版本 `0.1.3`（6 键 `FallbacksService` 表面断言不变，仍为可执行的漂移 STOP 门禁）。dist 保持仅类型导入——对该包零运行时导入。
