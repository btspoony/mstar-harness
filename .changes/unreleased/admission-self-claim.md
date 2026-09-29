---
category: Harness
packages: root
---

- Made admission cost proportional to contention (**fixes #308, claim half**): the pre-activation plan bind now has a **claim bootstrap**. `mstar plan bind --assignment <absolute-md-path>` on an unclaimed, unprepared `Todo`/`Blocked` row (no `coordination.session`, no handoff, no lease) writes the row's plan-pm session binding and emits the session envelope, claims **no** lease and leaves the status untouched — so an agent that finds a row nobody has prepared can start from the Assignment it was handed instead of waiting on the coordinator seat. A second claim on the claimed row is `coordination.duplicate-holder`, and the locator-less `--workflow/--plan` form keeps its `coordination.not-prepared` refusal unchanged.
- `prepare` gained exactly one seat: the plan session the addressed row is itself bound to — the claim's own claimant — while that row is still unprepared. It is proved against the row under the snapshot lock (session id **and** canonical envelope file), so a leaf, foreign or other-session identity keeps the existing `coordination.session-role` refusal, and the coordinator seat is unchanged. The same session then binds again to claim the lease (same identity, same envelope) and the row reaches `InProgress`.
- `plan show` advertises `prepare` to that claimant on its claimed-but-unprepared row, and `skills/mstar-iteration/references/plan-scoped-pm.md` §1/§2/§4.1/§6 plus `commands/iteration-drive.md`'s scoped-route row describe the chain (claim → prepare → bind) and the locator-only rule.

<!-- CN -->
- 让准入成本与争用程度成正比（**修复 #308 的 self-claim 一半**）：pre-activation 的 plan bind 新增 **claim bootstrap**。在无人认领且尚未 prepared 的 `Todo`/`Blocked` 行上（无 `coordination.session`、无 handoff、无 lease），`mstar plan bind --assignment <绝对 md 路径>` 写入该行的 plan-pm session 绑定并生成 session envelope，**不**取 lease、不改行状态——因此拿到 Assignment 的 agent 可以直接开工，不必等 coordinator 席位。对已 claim 的行再次 claim 为 `coordination.duplicate-holder`；无 locator 的 `--workflow/--plan` 形态保持原有的 `coordination.not-prepared` 拒绝不变。
- `prepare` 只新增一个合法席位：该行自身绑定的那个 plan session（claim 的 claimant），且该行仍未 prepared。该身份在快照锁内对行校验（session id **与** canonical envelope 文件），因此 leaf / foreign / 其他 session 身份保持既有 `coordination.session-role` 拒绝，coordinator 席位行为不变。同一 session 随后再次 bind 以取得 lease（同一身份、同一 envelope），行进入 `InProgress`。
- `plan show` 会向该 claimant 在“已 claim 未 prepared”的行上宣告 `prepare`；`skills/mstar-iteration/references/plan-scoped-pm.md` §1/§2/§4.1/§6 与 `commands/iteration-drive.md` 的 scoped route 行同步描述该链路（claim → prepare → bind）与 locator-only 规则。
