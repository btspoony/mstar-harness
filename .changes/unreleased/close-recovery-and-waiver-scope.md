---
category: Changed
packages: commands, root
---

- **`status workflow-close` no longer answers one refusal with two recoveries.** `coordination.git-unavailable` covers both an unreadable Git state and the delivery-diff scratch write that failed under `TMPDIR`; the former keeps the control-root instruction, the latter now names `TMPDIR` so the appended recovery agrees with the engine's own message.
- **The accepted-limits record states its waiver at its real width.** The `I-000196` subsection waives `model` and `assistance` only, and now says the `seat`/`shard`/`sessionId` duty `check-annotations` still enforces is outside it. The record also names which three of the five limits carry an in-code reference instead of claiming all five do.

<!-- CN -->
- **`status workflow-close` 不再用一个拒绝给出两个恢复指引。** `coordination.git-unavailable` 同时覆盖 Git 状态不可读与 `TMPDIR` 下交付 diff 临时文件写失败；前者保留控制根指引，后者改为指出 `TMPDIR`，与引擎自身消息一致。
- **已采纳边界记录按实际宽度陈述豁免。** `I-000196` 小节只豁免 `model` 与 `assistance`，并说明 `check-annotations` 仍在执行的 `seat`/`shard`/`sessionId` 义务不在豁免内。记录也改为点名五条边界中哪三条在代码内有引用，而非声称全部五条都有。
