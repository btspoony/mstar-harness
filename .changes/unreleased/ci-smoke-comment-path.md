---
category: Harness
packages: root
---

- **The two CI comments that explain the generated dashboard module now name the path the generator really writes.** Both the `CLI smoke check` and `Build CLI` blocks pointed at `src/dashboard/assets.generated.ts` — no such file exists in either package — while `packages/cli/scripts/build-web.ts` emits `packages/commands/src/dashboard/assets.generated.ts`, the module `packages/commands/src/dashboard/server.ts` imports. The reason each step must come after the one before it (`typecheck` for the smoke check, the commands build for the CLI build) is unchanged.

<!-- CN -->
- **解释生成式 dashboard 模块的两处 CI 注释改为点名生成器真正写出的路径。** `CLI smoke check` 与 `Build CLI` 两处原先指向 `src/dashboard/assets.generated.ts`——两个包中都不存在该文件——而 `packages/cli/scripts/build-web.ts` 实际产出的是 `packages/commands/src/dashboard/assets.generated.ts`，即 `packages/commands/src/dashboard/server.ts` 所导入的模块。各步骤必须排在其前置步骤之后的原因（smoke check 依赖 typecheck，CLI build 依赖 commands 构建）保持不变。
