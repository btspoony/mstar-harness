---
packages: root, opencode
---

- **Bash SDD/rollup scripts removed (engine CLI is the documented path)**: `skills/mstar-sdd/scripts/{sdd-workspace,task-brief,review-package}` and `skills/mstar-plan-artifacts/scripts/tech-debt-rollup.sh` are deleted. Skill text now documents `mstar sdd workspace|task-brief|review-package` and the engine `techDebtRollup` import (`mstar status validate` remains the schema gate); parity tests compare engine output against stored golden fixtures captured from the byte-proven ports (slice 2).

<!-- CN -->
- **移除 Bash SDD/rollup 脚本（引擎 CLI 成为文档化路径）**：删除 `skills/mstar-sdd/scripts/{sdd-workspace,task-brief,review-package}` 与 `skills/mstar-plan-artifacts/scripts/tech-debt-rollup.sh`。技能正文改为文档化 `mstar sdd workspace|task-brief|review-package` 与引擎 `techDebtRollup` import（schema 门禁仍为 `mstar status validate`）；奇偶校验测试改为对照由已证明 byte-parity 的移植产物（slice 2）捕获的 golden fixtures。
