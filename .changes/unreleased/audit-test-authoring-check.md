---
category: Harness
packages: root
---

- **Test-authoring audit check:** codebase, test-suite and PR reviews now report incidental, source-shape, wiring or environment-constant assertions with the conclusion “delete, or replace with a product-behaviour assertion”. Aligned implementer and reviewer contracts include the four PR #280 counter-examples while preserving product-behaviour assertions and fails-first regression defences; rejected assertions are never renamed or re-pinned.

<!-- CN -->
- **测试编写审计检查：**代码库、测试套件及 PR 审查现在须报告偶然性、源码形状、接线或环境常量断言，并给出“删除，或替换为产品行为断言”的结论。实现与审查契约同步纳入 PR #280 的四个反例，同时保留产品行为断言与修复前先失败的回归防线；被拒绝的断言不得改名或重新固定期望值。
