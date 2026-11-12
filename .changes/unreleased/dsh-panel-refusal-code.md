---
packages: dsh
---

- **A milestone write refused in the gateway envelope now keeps its own code.** `milestoneWrite` collapsed every `{ ok: false }` answer into `code: 'transport-error'`, so a failure carrying a `gateway/*` code (`gateway/internal` for a thrown handler, `gateway/cancelled` for an aborted carrier) reached the write channel as a transport failure. The code is carried as received; `transport-error` is reserved for an answer with no usable code. Engine refusals (`milestone.invalid-input`, `store.revision-conflict`, `milestone.not-empty`) are unaffected: they arrive as the method's value and were already decoded there, messages included.

<!-- CN -->
- **经网关信封被拒的 milestone 写现在保留自己的 code。** `milestoneWrite` 把每个 `{ ok: false }` 答复都折成 `code: 'transport-error'`，于是携带 `gateway/*` code 的失败（handler 抛错的 `gateway/internal`、carrier 被取消的 `gateway/cancelled`）到达写通道时表现为传输失败。现在按收到的 code 原样返回；仅当答复没有可用 code 时才用 `transport-error`。引擎自身的拒绝（`milestone.invalid-input`、`store.revision-conflict`、`milestone.not-empty`）不受影响：它们作为方法返回值到达，本来就在那里解码，message 亦然。
