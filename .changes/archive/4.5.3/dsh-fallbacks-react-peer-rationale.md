---
packages: dsh
---

- **The accepted nested React 18 from the `dsh-llm-fallbacks` dev dependency is stated, not worked around.** The package pins an external `react ^18` peer, so this React 19 workspace carries a nested React 18 tree for that dev-only plugin. It cannot reach shipped behavior — the package's `./client` surface is not mounted into the dashboard React tree and `src` never imports the package (only the test suite does) — so runtime is unaffected and no lockfile churn, alias or override is added. The decision and its reasoning live in `docs/adr/implemented/architecture/2026-11-12-fallbacks-dependency-boundaries.md`; the `packages/dsh` README pair cites it instead of restating the rationale.

<!-- CN -->
- **`dsh-llm-fallbacks` 开发依赖带来的嵌套 React 18 被记录，而非绕开。** 该包钉定外部 `react ^18` peer，因此在 React 19 的工作区里，这份仅开发期可用的插件会自带一棵 React 18 树。它无法影响出厂行为——该包的 `./client` 面未挂进 dashboard 的 React 树，且 `src` 从不导入该包（只有测试套件导入）——运行时不受影响，也不引入 lockfile 变动、alias 或 override。决策与理由记于 `docs/adr/implemented/architecture/2026-11-12-fallbacks-dependency-boundaries.md`；`packages/dsh` 的中英 README 对只指向该记录，不复述理由。
