---
category: Fixed
packages: commands,engine
---

- **`store upgrade` honours `--operation`, and refuses a malformed id before it advances the execution schema.** The caller's id is the idempotency key of the exact request, so a clean retry replays its retained reservation and receipt instead of minting a fresh operation; a retry that adds a request-identity option (`--ack-skip-workflow`, `--ack-skip-compass` or `--delivery`) is a different request and refuses `execution.operation-conflict`, which the option's own help now states instead of promising a same-id retry. `--ack-skip-dsh` is not part of that identity — it only disposes DSH host-state facts — so the `store.upgrade-dsh-source-refused` recovery, which reissues the same entry with a selector added, replays the already-committed execution half instead of conflicting. A malformed id is rejected at the entry of `upgradeStoreMinimal`, so the execution schema advance and the execution authority are untouched by that refusal; the collaboration lane is not, because `store upgrade` advances an existing v1 lane before that validation runs, so a corrected retry resumes on an already-advanced collaboration lane.

<!-- CN -->
- **`store upgrade` 遵守 `--operation`，并在推进 execution schema 之前拒绝非法 id。** 调用方的 id 是该确切请求的幂等键，因此干净的重试会重放既有预留与收据，而不再另生成一个操作；附带新的请求身份选项（`--ack-skip-workflow`、`--ack-skip-compass` 或 `--delivery`）的重试属于不同请求，以 `execution.operation-conflict` 拒绝——选项帮助现在写明这一点，而不再承诺同 id 重试。`--ack-skip-dsh` 不属于该身份——它只处置 DSH host-state 事实——因此 `store.upgrade-dsh-source-refused` 的恢复方式（同一个条目加一个 selector 重发）会重放已提交的 execution 部分，而不是冲突。非法 id 在 `upgradeStoreMinimal` 入口即被拒绝，因此该拒绝不会触碰 execution schema 推进与 execution 权威状态；但 collaboration lane 不受此保护，因为 `store upgrade` 在该校验之前就会推进既有的 v1 lane，修正 id 后的重试是在一个已推进的 collaboration lane 上继续。
