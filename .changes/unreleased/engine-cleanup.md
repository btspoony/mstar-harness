---
category: Harness
packages: root, engine, dsh
---

- **Engine public surface**: `redactSecrets` is no longer re-exported from the `@mstar-harness/engine` barrel (breaking for downstream imports of the bare package); the audit-module utility is now reachable via the new `@mstar-harness/engine/src/audit` subpath, and the `RedactResult` / `SecretFinding` types stay in the barrel. Barrel importers must migrate to the subpath.
- **dsh**: the audit seam (`packages/dsh/src/gates/seams.ts`) now imports `redactSecrets` from the `./src/audit` subpath instead of the barrel.

<!-- CN -->
- **Engine 公共面**：`redactSecrets` 不再从 `@mstar-harness/engine` barrel 再导出（对从裸包导入的下游为破坏性变更）；该审计模块工具改由新增的 `@mstar-harness/engine/src/audit` 子路径提供，`RedactResult` / `SecretFinding` 类型仍留在 barrel。barrel 引用方需迁移到子路径。
- **dsh**：审计 seam（`packages/dsh/src/gates/seams.ts`）改为从 `./src/audit` 子路径导入 `redactSecrets`，不再走 barrel。
