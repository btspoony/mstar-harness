---
category: Harness
packages: root
---

- Landed the **capture duty** as settled by compass D18: a confirmed finding becomes an issue in `{HARNESS_DIR}/store.db` at the moment it is confirmed — capture records evidence only, disposition is a separate authorized act, and a recurrence appends an occurrence instead of opening a second issue.
- Made **`mstar-project-governance`「Issue capture」the single authority** (issue contract §6 verbatim): the seat that owns the confirmed outcome captures — the PM seat and a PR-review round's main agent at Stage 3 — while leaf audit/QC/QA seats return evidence and never write the store. The other five owner texts carry pointer landings only.
- Re-pointed the residual-register prose in the artifacts family (`SKILL.md` + `references/status-and-residuals.md`), `mstar-audit` (incl. the PR-review reference) and `mstar-review-qc`, and added the minimal delivery-loop sentence to `mstar-harness-core`: the register is **migration history**, open items are **store issues**, and `mstar status tech-debt` / `mstar status findings-cleanup` read the store. Retired register writers (`mstar status backlog-register` / `backlog-close`) refuse and name the issue verbs; skills never restate flags.

<!-- CN -->
- 按 compass D18 落地 **capture duty**：确认的 finding 在确认当刻落为 `{HARNESS_DIR}/store.db` 的 issue —— 捕获只记证据，处置是独立的授权动作；同一 finding 再次出现追加 occurrence，而不是新开第二个 issue。
- **`mstar-project-governance`「Issue capture」成为唯一权威**（issue contract §6 逐字）：确认其结论的席位负责捕获 —— PM 席位，以及 PR-review 轮次 Stage 3 的 main agent；leaf audit/QC/QA 席位只回证据、不写 store。其余五处只做指针落点。
- `mstar-artifacts` 家族（`SKILL.md` + `references/status-and-residuals.md`）、`mstar-audit`（含 PR-review 参考）与 `mstar-review-qc` 的 residual register 表述改为指向 issue store，并在 `mstar-harness-core` 补最小交付循环句：register 是**迁移历史**，open item 是 store 的 **issue**，`mstar status tech-debt` / `mstar status findings-cleanup` 读 store。已退役的 register 写入动词（`mstar status backlog-register` / `backlog-close`）拒绝并指向 issue 动词；技能文不复述标志。
