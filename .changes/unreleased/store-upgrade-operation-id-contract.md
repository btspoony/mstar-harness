---
category: Fixed
packages: root
---

- **`store upgrade` honours `--operation`, and refuses a malformed id before it advances the schema.** The caller's id is the idempotency key of the exact request, so a clean retry replays its retained reservation and receipt instead of minting a fresh operation; a retry that adds an acknowledgement is a different request and refuses `execution.operation-conflict`, which the option's own help now states instead of promising a same-id retry. A malformed id is rejected at the entry of `upgradeStoreMinimal`, so the irreversible schema advance and the prior authority are untouched.

<!-- CN -->
- **`store upgrade` 遵守 `--operation`，并在推进 schema 之前拒绝非法 id。** 调用方的 id 是该确切请求的幂等键，因此干净的重试会重放既有预留与收据，而不再另生成一个操作；附带新 acknowledgement 的重试属于不同请求，以 `execution.operation-conflict` 拒绝——选项帮助现在写明这一点，而不再承诺同 id 重试。非法 id 在 `upgradeStoreMinimal` 入口即被拒绝，因此不可逆的 schema 推进与既有权威状态保持不变。
