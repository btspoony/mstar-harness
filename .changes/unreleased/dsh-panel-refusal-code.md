---
packages: dsh
---

- **A milestone write refused through the transport envelope now reports the engine's own code.** `milestoneWrite` collapsed every `{ ok: false }` answer into `code: 'transport-error'` while the engine's code survived only inside the message, so a domain refusal (`milestone.invalid-input`, a stale store revision, the emptiness rule) read as a transport failure to the UI and took the ambiguity path. The code is carried as received; `transport-error` is reserved for an answer with no usable code, which is the only case the retry policy treats as ambiguous. Messages are unchanged.

<!-- CN -->
- **经传输信封被拒的 milestone 写现在回报引擎自己的 code。** `milestoneWrite` 把每个 `{ ok: false }` 答复都折成 `code: 'transport-error'`，引擎的 code 只留在 message 里，于是领域拒绝（`milestone.invalid-input`、过期 store revision、非空拒绝）对 UI 表现为传输失败并走歧义路径。现在按收到的 code 原样返回；仅当答复没有可用 code 时才用 `transport-error`——也只有这种情况重试策略才视为歧义。message 未变。
