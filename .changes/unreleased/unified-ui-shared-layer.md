---
category: Harness
packages: root
---

- Added the shared UI package **`@mstar-harness/ui`** (private, consumed as source, shipped as declarations) and its **unified design system**: `DESIGN.md` is now the single token authority for both the standalone dashboard and the dsh panel — one `--ms-*` name set with a light value set in `:root` and a dark value set under `[data-ms-theme="dark"]`, implemented once in `packages/ui/src/styles/tokens.css` with an element layer in `base.css`.
- Added two accessibility rules the design system now enforces instead of assuming: **tone luminance separation** (the five status tones occupy fixed, non-overlapping L\* bands with a measured minimum gap of 3 L\*, so they stay distinguishable in greyscale) and a **forced-colors behaviour for the status dot** (each tone gets a distinct shape under `@media (forced-colors: active)`, so status never depends on colour). Measured contrast for every text, border and status role is recorded in `DESIGN.md`.
- Added `packages/ui/src/styles/tokens.test.ts`, the token contract: light/dark role parity, every declared token consumed or claimed by the task that will consume it, no bare colour literal outside the token file, the scheme selected by attribute and never by `prefers-color-scheme`, the forced-colors block, and `DESIGN.md` ↔ `tokens.css` name-set equality. Retired `packages/dsh/DESIGN.md` and `packages/dsh/DESIGN.dark.md` so no second, competing token set survives, and registered the new package in `scripts/release-surfaces.ts`.

<!-- CN -->
- 新增共享 UI 包 **`@mstar-harness/ui`**（private，以源码消费、只产出声明）及其**统一设计系统**：`DESIGN.md` 成为独立 dashboard 与 dsh 面板唯一的令牌权威 —— 一套 `--ms-*` 名称，`:root` 为浅色值、`[data-ms-theme="dark"]` 为深色值，只在 `packages/ui/src/styles/tokens.css` 实现一次，并在 `base.css` 提供元素层。
- 新增两条由设计系统强制、而非依赖约定的可访问性规则：**状态色亮度分离**（五个状态色的 L\* 分别落在固定且互不重叠的亮度带内，实测最小间隔 3 L\*，因此在灰度下仍可区分），以及**状态点在强制颜色模式下的行为**（`@media (forced-colors: active)` 下每种状态改用不同形状，状态永不只靠颜色）。所有文字、边框与状态角色的实测对比度都记录在 `DESIGN.md`。
- 新增 `packages/ui/src/styles/tokens.test.ts` 作为令牌契约：浅/深色角色对等、每个声明令牌要么被消费要么被后续任务认领、令牌文件之外不得出现裸颜色字面量、配色由属性而非 `prefers-color-scheme` 选择、强制颜色块存在、`DESIGN.md` 与 `tokens.css` 名称集合一致。退役 `packages/dsh/DESIGN.md` 与 `packages/dsh/DESIGN.dark.md`，避免出现第二套竞争令牌；并在 `scripts/release-surfaces.ts` 注册新包。
