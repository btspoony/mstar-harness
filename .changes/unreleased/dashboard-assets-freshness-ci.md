---
packages: root
---

- Guard the inlined dashboard assets in CI: a rebuild of `packages/commands/src/dashboard/assets.generated.ts` that is not a no-op now fails the `build` job right after `typecheck` (issue #532).

<!-- CN -->
- 在 CI 中守护内联 dashboard 资源：重新生成 `packages/commands/src/dashboard/assets.generated.ts` 若产生差异，`build` 任务会在 `typecheck` 之后立即失败（issue #532）。
