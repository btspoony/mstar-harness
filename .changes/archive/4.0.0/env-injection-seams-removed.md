---
category: Changed
packages: engine
---

- Remove environment-controlled projection churn and authority-read failures, and replace activation/retirement test seams with explicit test-owned hooks.
- Replace the store open/migration test seams with explicit parameters: `openStore`/`initializeStore` take an optional bounded-wait value, and the init/migration failure injections are test-owned callbacks — no invocation environment can select native store behavior.

<!-- CN -->
- 移除由环境变量控制的投影变更与权威读取故障，并将激活/退役测试接缝替换为显式的测试自有钩子。
- 将存储打开/迁移的测试接缝替换为显式参数：`openStore`/`initializeStore` 接受可选的有界等待值，初始化/迁移故障注入改为测试自有的回调 —— 调用环境无法再选择存储的原生行为。
