# 回归固化参考（Regression Fixation Reference）

行为塑形改动（skill 正文流程、命令序列、CLI 行为面）的 paired evidence 武器库之一（P6 **重武器选项**）。默认证据仍是 SKILL.md「验证门控」的 P6 before/after + 应用案例；仅当行为可脚本化、且该行为面值得长期固化时，用本手法。

## 何时用（When）

- 行为面有**可执行产物**：skill 正文里的流程脚本 / 命令序列 / CLI 调用链。
- 该面曾出过行为 bug，或改动触碰宿主边界（解析、打包、路径解析、子进程执行）。
- 例外：纯文案 / 无可观测行为的规则微调 → 走默认 P6，不加载本参考。

## 手法（Technique）

1. **真实产物当被测对象（real artifact as test subject）**
   不 import 源码、不 mock 掉被测面本身——直接运行用户/agent 实际触达的产物（built bundle、命令序列、宿主钩子驱动的完整流程）。产物侧跑通，才能覆盖「源码 import 跑不到」的缺陷面（bundle 解码、产物路径解析、子进程环境）。
   → 本仓实例：`packages/cli/test/bundle-smoke.test.ts`（2026-08-16 落地）对 **built bundle** `dist/mstar-harness.js` 子进程执行 `dispatch validate` 并断言 exit code，而非 import `src/index.ts`。

2. **Mock 宿主钩子（mock host hooks）**
   把宿主边界替换为受控桩：mstar 面对应 dispatch / file IO / CLI 调用。固定输入（fixture 文件、argv、环境变量），断言行为输出（exit code、stdout/stderr、副作用文件）。钩子命名沿用宿主自身词汇，不引入外部系统 hook 名。

3. **双路径断言一致（dual-path assertion）**
   同一断言集对两条路径各跑一遍并断言一致：**真实模块路径**（import 产物 / 源码）与**被测路径**（vm 求值真实脚本 / 子进程 bundle）。任一路径偏离 → 立即暴露「实现与产物行为漂移」。

4. **修复固化（fix solidification）**
   行为 bug 修复流程：先写复现用例见 FAIL → 修 → 用例见 PASS → 进回归集。此后每次改动重跑回归集，同类 bug 不再复发（回归集随修复轮增长）。

## 最小骨架（Skeleton，零外部依赖）

```js
// node:test + vm：求值「真实脚本文本」，不复制逻辑到测试
import test from "node:test";
import vm from "node:vm";

const script = readFileSync("flow.js", "utf8"); // 真实产物
const sandbox = { dispatch: mockDispatch, fileIO: mockFileIO }; // mock 宿主钩子
vm.runInNewContext(script, sandbox);             // 被测路径
assert.deepEqual(sandbox.events, expected);      // 断言行为输出
// 双路径：同一断言集对真实模块路径再跑一遍，assert 一致
```

bun test 同理：`Bun.spawnSync` 子进程跑 bundle + `expect` 断言（见本仓 bundle-smoke 实例）。

## 边界（Boundaries）

- **零外部依赖**：Node 内置 `vm` / `node:test`（或 bun test）即可，不引入第三方测试框架。
- **不强制**：默认仍是 P6 before/after + 应用案例；本参考是重武器选项。
- **只固化可观测行为**：模型判断、触发精确性等不可脚本化断言的面，仍走压力场景（SKILL.md「验证门控」）。
