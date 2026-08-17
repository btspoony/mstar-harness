---
category: Changed
packages: cli, root
---

- **dsh install target**: `npx @mstar-harness/cli init --target dsh` now installs the full dsh capability in one command — it runs **two independent** `dsh plugin --profile web add` calls (`@mstar-harness/dsh` first, then `dsh-llm-fallbacks`; never folded into a patch file). `doctor --target dsh` reports each plugin row as `uninstalled` / `disabled` / `mounted` and exits non-zero on any uninstalled or disabled row. `--no-fallbacks` (dsh target only) skips the `dsh-llm-fallbacks` row; `--dry-run` previews without probing or executing; re-runs are idempotent (already-installed rows skipped). README pair, `INSTALL.md`, and `docs/cli.md` updated.

<!-- CN -->
- **dsh 安装目标**：`npx @mstar-harness/cli init --target dsh` 现可一条命令装齐 dsh 全量能力——它运行**两条独立** `dsh plugin --profile web add` 调用（先 `@mstar-harness/dsh`，再 `dsh-llm-fallbacks`；绝不折叠进 patch 文件）。`doctor --target dsh` 逐行报告 `uninstalled` / `disabled` / `mounted`，存在未安装或禁用行时以非 0 退出。`--no-fallbacks`（仅 dsh target 生效）跳过 `dsh-llm-fallbacks` 行；`--dry-run` 纯预览，不探测不执行；重复执行幂等（已装行跳过）。README 双语对、`INSTALL.md`、`docs/cli.md` 已同步。
