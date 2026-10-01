---
category: Added
packages: root
---

- Add a maintenance policy rule requiring every user-facing refusal to name the actual cause and an exact recovery reachable through a supported, documented interface. A gate with no paired recovery, a refusal that leaves the operator with nothing to do, and a generic blocked message that masks an identifiable cause are all defects; a new hard limit must ship with its recovery and a test.

<!-- CN -->
- 新增维护策略：任何面向用户的拒绝都必须说明**实际原因**，并给出可通过**受支持且已文档化**的接口执行的确切恢复步骤。没有配套恢复的门禁、让操作者无事可做的拒绝、以及用通用"blocked"文案掩盖已知原因的写法，均属缺陷；新增硬性限制必须同一次变更带上恢复方案与测试。
