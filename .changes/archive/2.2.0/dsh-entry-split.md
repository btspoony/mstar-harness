---
packages: root
---

- **dsh plugin**: `src/index.ts` slimmed from a 3184-line monolith to a module index over `src/gates/*` (pure refactor, zero behavior change — the 27-name export surface is frozen identical by `tests/export-surface.spec.ts`, and the export-surface type layer now runs in CI via `typecheck:tests` (`bunx tsc --noEmit -p tests/tsconfig.json`)).

<!-- CN -->
- **dsh 插件**：`src/index.ts` 由 3184 行单体瘦身为 `src/gates/*` 之上的模块索引（纯重构、零行为变更——27 名导出面由 `tests/export-surface.spec.ts` 冻结不变，导出面类型层现经 `typecheck:tests`（`bunx tsc --noEmit -p tests/tsconfig.json`）进入 CI 类型检查）。
