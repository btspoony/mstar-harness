---
category: Harness
packages: root
---

- Closed the design-system check chain: `check:snapshot`, `check:declarations`, `check:selectors` and `check:tones` in `packages/ui` now read the **tracked** `packages/ui/design-system/prototype.html` instead of a local prototype outside the repository, and each exits 1 naming that path when the baseline is unreadable. A comparator can no longer report green while comparing nothing.
- Removed the opt-in `STRICT_SNAPSHOT` / `STRICT_DECLARATIONS` / `STRICT_SELECTORS` / `STRICT_TONES` escape hatches: fail-closed is the only mode.
- Added a `test-ui` CI job (`.github/workflows/ci.yml`) that runs `packages/ui`'s test suite and the four checks as separate named steps, so a failing comparator is identified in the log.
- Deleted the unread `packages/ui/src/styles/prototype-structure.ts` fixture (`PROTOTYPE_PANELS`, `PROTOTYPE_DISCLOSURE_ANCESTRY`, `PROTOTYPE_FLOW_TABLE_ANCESTRY`): no importer, no consumer.
- `packages/ui/design-system/README.md` and `DESIGN.md` now describe the current chain; the stale `.mstar`-era rationale is gone.

<!-- CN -->
- 打通设计系统校验链:`packages/ui` 的 `check:snapshot`、`check:declarations`、`check:selectors`、`check:tones` 改为读取**仓库内被跟踪**的 `packages/ui/design-system/prototype.html`,不再依赖仓库外的本地原型;基线不可读时各自以 `exit 1` 结束并点明该路径。比对脚本不可能再在"什么都没比"的情况下报绿。
- 移除 `STRICT_SNAPSHOT` / `STRICT_DECLARATIONS` / `STRICT_SELECTORS` / `STRICT_TONES` 这些可选开关:失败即失败成为唯一模式。
- 新增 `test-ui` CI 作业(`.github/workflows/ci.yml`),把 `packages/ui` 的测试套件与四个校验各自作为具名步骤运行,失败的比对项在日志中可直接定位。
- 删除无人引用的 `packages/ui/src/styles/prototype-structure.ts`(`PROTOTYPE_PANELS`、`PROTOTYPE_DISCLOSURE_ANCESTRY`、`PROTOTYPE_FLOW_TABLE_ANCESTRY`):无导入方、无使用方。
- `packages/ui/design-system/README.md` 与 `DESIGN.md` 同步描述当前链路,删除 `.mstar` 时代的过时说法。
