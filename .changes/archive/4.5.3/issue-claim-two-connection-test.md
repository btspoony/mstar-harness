---
packages: engine
---

- **The send right is the ledger's, not a connection's.** The claim test now opens two independent store connections before the first claim: exactly one claim succeeds, the loser is handed the row the winner opened, and a push over the losing connection sends no second create.

<!-- CN -->
- **发送权归账本，不归某条连接。** claim 测试现于首次 claim 前打开两条独立 store 连接：只有一次 claim 成功，落败方拿到胜者开的行，且经落败连接发起 push 不会发出第二次 create。
