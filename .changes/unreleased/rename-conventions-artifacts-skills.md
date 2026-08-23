---
category: Harness
packages: root, opencode, engine, dsh
---

- Renamed `mstar-plan-conventions` → **`mstar-conventions`** and `mstar-plan-artifacts` → **`mstar-artifacts`**: the two skills are general harness conventions (paths, artifacts), not plan-specific, so the `plan-` prefix was dropped. All live surfaces swept (`skills/**` load orders, index rows and cross-cites, `commands/**`, `AGENTS.md`, `README.md` + `README_CN.md` skill tables, `docs/cli.md`, `.cursor/` routing-eval fixtures + local validation, `scripts/` guards, engine/dsh/cli source comments and path literals, dsh test expectations). Historical changelogs and engine test-fixture prose are untouched — old names there are correct as historical record.

<!-- CN -->
- 技能更名：`mstar-plan-conventions` → **`mstar-conventions`**、`mstar-plan-artifacts` → **`mstar-artifacts`**——两个技能是通用 harness 约定（路径、产物），并非 plan 专属，故去掉 `plan-` 前缀。所有活表面已同步（`skills/**` 加载顺序、索引行与交叉引用、`commands/**`、`AGENTS.md`、`README.md` + `README_CN.md` 技能表、`docs/cli.md`、`.cursor/` routing-eval fixtures 与本地校验、`scripts/` 守卫、engine/dsh/cli 源码注释与路径字面量、dsh 测试预期）。历史 changelog 与 engine 测试 fixture 散文保持原样——其中的旧名称作为历史记录是正确的。
