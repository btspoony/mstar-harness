# ADR: Optimize and errata the mstar skill corpus under Guard 9–11

Status: implemented — Waves A–C (#702/#703/#704) landed the migrate→compress→raise, one-HARD-owner, role-language errata, trigger-contract, and routing-minimization policy under Guards 9–11
Date: 2026-11-10
Scope: `skills/**` authoring policy, Guard 9–11 maintenance order, Wave A `docs/knowledge/**` errata targets, and first-wave file targets (no engine semantic change)

## Problem

The skill corpus at v4.4.0 (`a6721f52`) passes Guard 9–12 and the runtime five-question lint, yet it is not healthy for continued growth:

1. **Budget saturation without headroom.** 69 of 123 budgeted skill files sit at ≥95% of their Guard 9 caps. Multiple `SKILL.md` bodies are at or one line under the ceiling (`mstar-branch-worktree` 287/290, `mstar-conventions` 269/270, `mstar-knowledge` 245/250, `mstar-use-cli` 140/140, `mstar-artifacts` 70/70). Raising caps without first migrating content into `references/` would violate the authoring order in `mstar-skill-authoring` (migrate → compress → raise) and would keep routing tokens high.
2. **Progressive-disclosure debt.** Several large bodies still answer more than the five body questions in place: worktree cleanup machinery and L1 diagnostics live in `mstar-branch-worktree/SKILL.md` with only one reference file; `mstar-dispatch-gates`, `mstar-phase-gates`, and `mstar-harness-core` have no `references/` at all despite dense HARD rules. Agents that load those topics pay for every variant on every activation.
3. **Nomenclature errata after shipped renames.** QA → PM Acceptance and `mstar-compound` → `mstar-knowledge` landed, but residual wording still says `QC/QA` as if QA were a live seat (`skills/mstar-artifacts/references/plan-quality-bar.md`), and project knowledge docs still instruct writers through `mstar-compound` (`docs/knowledge/best-practices/knowledge-usage-gate.md` and related). Carrier spellings such as `qa.md` / `qa_gate` remain intentional and must not be mass-renamed; role/seat language must.
4. **Allowlisted HARD duplication still open.** Guard 10 still exempts three identical Repo-write Git discipline lines across `frontend-dev.md`, `fullstack-dev-shared.md`, and `ops-engineer.md`. The allowlist itself states the exemption ends when those files point at `leaf-executor-core.md` instead — that round has not happened.
5. **Trigger-contract drift.** Several descriptions exceed a tight trigger contract (`mstar-prose` ~486 chars, `mstar-pr-loop` ~353, `mstar-design-system` ~359, bilingual essay-length `mstar-knowledge` / `mstar-skill-authoring`). Long descriptions raise over-activation risk and tempt agents to follow the summary instead of the body (authoring principle 3).
6. **Routing load on the PM path.** `mstar-harness-core`'s typical-append table for `@project-manager` lists a large set of topics. Without a minimization pass, a single orchestration turn can load far more than the 1–3 skill target in `mstar-skill-authoring`.

Without a recorded sequencing policy, future skill PRs will keep raising budgets, re-copy HARD rules, and leave stale seat names in place — re-breaking token budgets and acceptance language after each rename.

## Decision

The skill corpus is maintained under an **incremental, budget-first optimization and errata policy** owned by `mstar-skill-authoring` Guards 9–11. Class is **process**: the decision governs how the skill corpus is maintained and corrected. `bun run validation:drift` is the automated floor (line counts, manifest coverage, HARD duplication, ADR skeleton) — it does **not** prove migrate-before-raise, new headroom targets, Guard 11 reflow, or description/routing minimization; those remain human-review duties on each skill PR.

Present policy (non-negotiable order):

1. **Migrate before compress before raise.** Touching a file at ≥95% of its Guard 9 cap requires moving variant detail into `references/` (or deleting non-five-question prose) in the same PR before any `maxLines` increase. Cap raises without migration are refused.
2. **One HARD rule, one owner.** New HARD text lands in a single owner file; other files point with `→ <skill> § <section>` (Guard 10 pointer style). The three-file Git NEVER allowlist is closed by pointers to `mstar-roles/references/_shared/leaf-executor-core.md`.
3. **Errata is role language, not carrier spelling.** Live-seat wording `QC/QA` / `qa-engineer` / `mstar-compound` (as a skill to load) becomes `QC/PM Acceptance` / PM Acceptance / `mstar-knowledge` where the text means a role or topic. Intentional historical carriers (`qa.md`, `qa_gate`, `qaGate`, migration bak of `qa-engineer.toml`, fixture names) stay unless a separate ADR renames the transport.
4. **Description is a trigger contract.** Overlong descriptions are symptoms / exclusions only; they never summarize the workflow. Rough target is ≤ ~220 characters when English-only is enough; bilingual triggers stay bilingual only when both languages carry distinct activation cues.
5. **Routing minimization.** Preset and typical-append lists in `mstar-roles` / `mstar-harness-core` name the minimum set for the task class (1–3 topical skills per task); optional topics stay behind explicit Assignment `Skill presets:` or phase-local references. Agents do not load every topic "just in case."
6. **Guard 11 opportunistic reflow.** When a file is already edited for migration or errata, multi-line paragraphs merge into single physical lines. There is no whole-tree reflow PR.
7. **Legacy archive stays inbound-only.** `mstar-engine-legacy` remains the engine-absent boundary; it is not deleted and its trigger is not broadened. Mark and slim only if its body drifts above the five questions.

Waves A–C are the accepted implementation of this policy:

| Wave | Scope | Landing |
|------|--------|---------|
| **A — Errata** | Nomenclature + pointers only; no budget raises | [#702](https://github.com/btspoony/mstar-harness/pull/702) / [#699](https://github.com/btspoony/mstar-harness/issues/699) |
| **B — Body → references** | Progressive disclosure for at-cap bodies | [#703](https://github.com/btspoony/mstar-harness/pull/703) / [#700](https://github.com/btspoony/mstar-harness/issues/700) |
| **C — Triggers + routing** | Description contracts + load tables; this ADR promotion | [#704](https://github.com/btspoony/mstar-harness/pull/704) / [#701](https://github.com/btspoony/mstar-harness/issues/701) |

Wave D (paired SkillsBench-style evidence for behavior-shaping edits) remains the ongoing authoring duty on future waves, not a separate policy change.

## Alternatives considered

- **Big-bang rewrite of every `mstar-*` skill in one PR.** Maximizes consistency in theory; in practice it mixes errata, budget moves, and trigger edits so review cannot isolate regressions, and it forces simultaneous cap churn across 123 files. Rejected.
- **Delete-legacy-only (`mstar-engine-legacy` and unused references).** Removes little token weight (legacy is already ~39 lines and correctly gated) and leaves the saturated bodies and stale seat language untouched. Insufficient.
- **Raise Guard 9 caps to match current sizes.** Stops the bleeding on CI without reducing what agents load; contradicts `mstar-skill-authoring` ("caps are a guardrail, not a shrink target" still requires migrate-first when touching the ceiling). Rejected as a first move.
- **Do nothing until the next feature forces a skill edit.** Guarantees opportunistic edits will raise caps and copy HARD rules under schedule pressure; nomenclature drift will keep teaching retired seats. Rejected.
- **Incremental budget-first + errata policy (this decision).** Preserves mechanical gates, names concrete first-wave files, separates carrier spellings from role language, and keeps legacy archive. Chosen.

## Consequences

- Live-seat `QC/QA` / `mstar-compound`-as-skill-to-load wording is gone under `skills/**` and the Wave A–targeted `docs/knowledge/**` paths for role/topic meaning; intentional historical carriers remain unchanged. Guard 10 no longer allowlists the three Git NEVER duplicates.
- First-wave at-cap bodies (`mstar-branch-worktree`, `mstar-conventions`, and peers edited in Wave B) hold ≥10% Guard 9 headroom without a first-move cap raise, with new reference files linked from each body's References table.
- The five long descriptions named in the Problem are trigger contracts (symptoms/exclusions), not workflow summaries; `mstar-harness-core` typical-append / role presets document a 1–3 skill minimization rule.
- This record promotes with Wave C in [#704](https://github.com/btspoony/mstar-harness/pull/704); Waves A–C together are the accepted subset that closes the original acceptance bar. Future skill PRs that touch a Guard 9 ceiling must migrate before raising; silent policy drift is refused.
- **Residual risk — over-splitting references** can hide HARD rules behind too many files and recreate duplication. Mitigation: every split keeps a single owner section and updates inbound pointers in the same PR; Guard 10 stays fail-closed.
- **Residual risk — errata false positives** could rename intentional carriers (`qa.md`, CLI `--qa-gate`, historical reports). Mitigation: Decision §3 explicitly preserves carriers; review checklists name them.
- **Residual risk — trigger under-activation** may miss a skill that previously matched broad prose. Mitigation: Wave C pairs each description edit with positive/negative activation examples in the PR body; held-out prompts per authoring principle 6 remain the ongoing duty.
