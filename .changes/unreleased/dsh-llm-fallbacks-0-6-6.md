---
packages: root, dsh, cli
---

- **`dsh-llm-fallbacks` pin bumped `0.6.5` → `0.6.6`**: the two hand-written literals move together — the `@mstar-harness/dsh` devDependency (`packages/dsh/package.json`) and the CLI install-spec constant (`packages/cli/package.json` → `mstar.dshLlmFallbacks`, read by `init` / `doctor --target dsh`) — and the lock re-resolves the row to `0.6.6`. `0.6.6` requires the `@deepseek-ai/dsh-*` `^0.2.1-rc.2` peer cohort, so the pin is consistent only on that cohort line (this branch carries it). Nothing upgrades an already-installed host: `doctor --target dsh` reports the older row `drifted` until `init --target dsh` re-adds the pinned spec.

<!-- CN -->
- **`dsh-llm-fallbacks` 固定版本由 `0.6.5` 升至 `0.6.6`**：两处手写字面量同步移动——`@mstar-harness/dsh` 开发依赖（`packages/dsh/package.json`）与 CLI 安装 spec 常量（`packages/cli/package.json` → `mstar.dshLlmFallbacks`，由 `init` / `doctor --target dsh` 读取），lock 将该行重新解析为 `0.6.6`。`0.6.6` 要求 `@deepseek-ai/dsh-*` 的 `^0.2.1-rc.2` peer 走廊，因此该 pin 仅在这一走廊线上自洽（本分支已携带）。不会升级任何已安装宿主：在 `init --target dsh` 按新 pin 重新 add 之前，`doctor --target dsh` 会把旧行报为 `drifted`。
