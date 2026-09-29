---
category: Harness
packages: root
---

- **The `bind` stale-pin adoption now re-seals BOTH halves of the pair `prepare` sealed** (spec §D2): a prepared row **nobody else holds** whose plan document moved — the ordinary case while an iteration revises plan prose — adopts the measured drift exactly like a moved Assignment, refreshing `coordination.prepared.plan_sha256` to the bytes that bind acts under in the same commit and recording both moves in one `coordination.self_amendments` entry (`plan_old_sha256` / `plan_new_sha256`, recorded together only when that half moved). A plan document that is **gone** is still never adopted: a missing sealed input has no bytes to re-pin and keeps its structured refusal, so the missing-plan-half semantics are untouched (<https://github.com/btspoony/mstar-harness/pull/312>).
- The amendment's own `operation_id` now hashes the plan-half digests too, so two adoptions differing only in the plan move are two records; the validator accepts the new pair as an optional all-or-nothing pair of differing bare sha256 hex digests and leaves every existing one-half record valid.
- Unchanged: the prepare-commit TOCTOU recheck (`assertSealedInputsUnchanged`), the Assignment-only `assertPreparedFresh` on every other path, the DB route's own pin behaviour, and a fresh bind — which reads no plan file at all when the Assignment still matches. Updated `mstar-artifacts/references/status-and-residuals.md` and `mstar-host/references/omp.md`.

<!-- CN -->
- **`bind` 的 stale-pin adoption 现在会同时重封 `prepare` 所封的两个半边**（规范 §D2）：**无人持有**的 prepared 行在 plan 文档发生漂移时（迭代中修订 plan 正文的常见情形）与 Assignment 漂移一样被采纳——在同一次提交中把 `coordination.prepared.plan_sha256` 刷新为本次 bind 所依据的字节，并把两处漂移记入同一条 `coordination.self_amendments`（`plan_old_sha256` / `plan_new_sha256`，仅当该半边确实移动时成对记录）。plan 文档**缺失**仍然绝不采纳：缺失的 sealed 输入没有可重封的字节，保持其结构化拒绝，缺失 plan 半边的语义不变（<https://github.com/btspoony/mstar-harness/pull/312>）。
- 该审计记录的 `operation_id` 现在也纳入 plan 半边摘要，因此仅在 plan 漂移上不同的两次采纳是两条记录；验证器把新字段作为可选的“成对出现、两个不同的小写 sha256 摘要”接受，既有只记一个半边的记录依旧合法。
- 保持不变：prepare 提交窗口的 TOCTOU 复查（`assertSealedInputsUnchanged`）、其余路径上仅针对 Assignment 的 `assertPreparedFresh`、DB 路由自身的 pin 行为，以及 fresh bind——当 Assignment 未漂移时根本不读 plan 文件。同步更新 `mstar-artifacts/references/status-and-residuals.md` 与 `mstar-host/references/omp.md`。
