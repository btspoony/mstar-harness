# ADR: Optimize and errata the mstar skill corpus under Guard 9–11

Status: proposed — skill corpus is mechanically green but budget-saturated and carries post-v4.4.0 nomenclature drift that will re-break agent routing without a sequenced correction policy
Date: 2026-11-10
Scope: `skills/**` authoring policy, Guard 9–11 maintenance order, Wave A `docs/knowledge/**` errata targets, and first-wave file targets (no engine semantic change in the proposal itself)

## Problem

The skill corpus at v4.4.0 (`a6721f52`) passes Guard 9–12 and the runtime five-question lint, yet it is not healthy for continued growth:

1. **Budget saturation without headroom.** 69 of 123 budgeted skill files sit at ≥95% of their Guard 9 caps. Multiple `SKILL.md` bodies are at or one line under the ceiling (`mstar-branch-worktree` 287/290, `mstar-conventions` 269/270, `mstar-knowledge` 245/250, `mstar-use-cli` 140/140, `mstar-artifacts` 70/70). Raising caps without first migrating content into `references/` would violate the authoring order in `mstar-skill-authoring` (migrate → compress → raise) and would keep routing tokens high.
2. **Progressive-disclosure debt.** Several large bodies still answer more than the five body questions in place: worktree cleanup machinery and L1 diagnostics live in `mstar-branch-worktree/SKILL.md` with only one reference file; `mstar-dispatch-gates`, `mstar-phase-gates`, and `mstar-harness-core` have no `references/` at all despite dense HARD rules. Agents that load those topics pay for every variant on every activation.
3. **Nomenclature errata after shipped renames.** QA → PM Acceptance and `mstar-compound` → `mstar-knowledge` landed, but residual wording still says `QC/QA` as if QA were a live seat (`skills/mstar-artifacts/references/plan-quality-bar.md`), and project knowledge docs still instruct writers through `mstar-compound` (`docs/knowledge/best-practices/knowledge-usage-gate.md` and related). Carrier spellings such as `qa.md` / `qa_gate` remain intentional and must not be mass-renamed; role/seat language must.
4. **Allowlisted HARD duplication still open.** Guard 10 still exempts three identical Repo-write Git discipline lines across `frontend-dev.md`, `fullstack-dev-shared.md`, and `ops-engineer.md`. The allowlist itself states the exemption ends when those files point at `leaf-executor-core.md` instead — that round has not happened.
5. **Trigger-contract drift.** Several descriptions exceed a tight trigger contract (`mstar-prose` ~486 chars, `mstar-pr-loop` ~353, `mstar-design-system` ~359, bilingual essay-length `mstar-knowledge` / `mstar-skill-authoring`). Long descriptions raise over-activation risk and tempt agents to follow the summary instead of the body (authoring principle 3).
6. **Routing load on the PM path.** `mstar-harness-core`'s typical-append table for `@project-manager` lists a large set of topics. Without a minimization pass, a single orchestration turn can load far more than the 1–3 skill target in `mstar-skill-authoring`.

Without a recorded sequencing policy, future skill PRs will keep raising budgets, re-copy HARD rules, and leave stale seat names in place — re-breaking token budgets and acceptance language after each rename.

## Proposal

Adopt an **incremental, budget-first corpus optimization and errata policy** owned by `mstar-skill-authoring` Guards 9–11. Class is **process**: the decision governs how the skill corpus is maintained and corrected; later implementation PRs may change agent-visible surfaces. `bun run validation:drift` is the automated floor (current line counts, manifest coverage, HARD duplication, ADR skeleton) — it does **not** prove migrate-before-raise, new headroom targets, Guard 11 reflow, or description/routing minimization; those remain human-review duties on each wave PR.

### Policy (non-negotiable order)

1. **Migrate before compress before raise.** Touching a file at ≥95% of its Guard 9 cap requires moving variant detail into `references/` (or deleting non-five-question prose) in the same PR before any `maxLines` increase. Cap raises without migration are refused.
2. **One HARD rule, one owner.** New HARD text lands in a single owner file; other files point with `→ <skill> § <section>`. Close the three-file Guard 10 allowlist in the first implementation wave by replacing the duplicated Git NEVER lines with pointers to `mstar-roles/references/_shared/leaf-executor-core.md`, then delete those allowlist entries in the same commit.
3. **Errata is role language, not carrier spelling.** Replace live-seat wording `QC/QA` / `qa-engineer` / `mstar-compound` (as a skill to load) with `QC/PM Acceptance` / PM Acceptance / `mstar-knowledge` where the text means a role or topic. Keep intentional historical carriers (`qa.md`, `qa_gate`, `qaGate`, migration bak of `qa-engineer.toml`, fixture names) unless a separate ADR renames the transport.
4. **Description is a trigger contract.** Rewrite overlong descriptions to symptoms / exclusions only; never summarize the workflow. Target roughly the existing short contracts (≤ ~220 characters when English-only is enough); bilingual triggers stay bilingual only when both languages carry distinct activation cues.
5. **Routing minimization.** Preset and typical-append lists in `mstar-roles` / `mstar-harness-core` name the minimum set for the task class; optional topics stay behind explicit Assignment `Skill presets:` or phase-local references. Do not load every topic "just in case."
6. **Guard 11 opportunistic reflow.** When a file is already edited for migration or errata, merge its multi-line paragraphs into single physical lines. No whole-tree reflow PR.
7. **Legacy archive stays.** `mstar-engine-legacy` remains the inbound-only engine-absent boundary; do not delete it or broaden its trigger. Mark and slim only if its body drifts above the five questions.

### Sequencing (implementation waves after this ADR is accepted)

| Wave | Scope | First-wave file targets |
|------|--------|-------------------------|
| **A — Errata** | Nomenclature + pointers only; no budget raises | `skills/mstar-artifacts/references/plan-quality-bar.md` (`QC/QA` → `QC/PM Acceptance`); knowledge docs that still say load/`mstar-compound` → `mstar-knowledge`; close Guard 10 allowlist on the three role files |
| **B — Body → references** | Progressive disclosure for at-cap bodies | Split from `mstar-branch-worktree/SKILL.md`: cleanup ownership/refusals/lanes → `references/worktree-cleanup.md` (or split further); L1 host diagnostics → `references/l1-refusal-diagnostics.md`. From `mstar-conventions/SKILL.md`: gitignore recipe + catalog field tables already partially referenced — finish moving bootstrap/catalog depth. Seed `references/` for `mstar-dispatch-gates` (anti-recursion vs parallel readiness) and `mstar-phase-gates` (playbook vs hotfix) if still over headroom after compress. |
| **C — Triggers + routing** | Description contracts + load tables | Trim `mstar-prose`, `mstar-pr-loop`, `mstar-design-system`, `mstar-knowledge`, `mstar-skill-authoring` descriptions; audit `@project-manager` typical-append in `mstar-harness-core` against principle 3 (1–3 skills per task). |
| **D — Evidence** | Paired checks for behavior-shaping edits | For each wave that changes trigger or HARD routing, leave SkillsBench-style before/after or pressure prompts per `mstar-skill-authoring` § Evidence; `bun run validation:drift` green; `mstar skill lint` on touched skills. |

This ADR lands **policy and sequencing only**. Full skill rewrites ship in follow-up PRs that promote this record to `implemented/` when Wave A–C acceptance criteria below are met (or when a smaller accepted subset is completed and the Status/Consequences are updated accordingly).

## Alternatives considered

- **Big-bang rewrite of every `mstar-*` skill in one PR.** Maximizes consistency in theory; in practice it mixes errata, budget moves, and trigger edits so review cannot isolate regressions, and it forces simultaneous cap churn across 123 files. Rejected.
- **Delete-legacy-only (`mstar-engine-legacy` and unused references).** Removes little token weight (legacy is already ~39 lines and correctly gated) and leaves the saturated bodies and stale seat language untouched. Insufficient.
- **Raise Guard 9 caps to match current sizes.** Stops the bleeding on CI without reducing what agents load; contradicts `mstar-skill-authoring` ("caps are a guardrail, not a shrink target" still requires migrate-first when touching the ceiling). Rejected as a first move.
- **Do nothing until the next feature forces a skill edit.** Guarantees opportunistic edits will raise caps and copy HARD rules under schedule pressure; nomenclature drift will keep teaching retired seats. Rejected.
- **Incremental budget-first + errata policy (this proposal).** Preserves mechanical gates, names concrete first-wave files, separates carrier spellings from role language, and keeps legacy archive. Chosen.

## Acceptance criteria

Observable once implementation waves land (this proposal PR alone does not satisfy them):

1. Wave A merged: no live-seat `QC/QA` / `mstar-compound`-as-skill-to-load wording remains under `skills/**` or in the Wave A–targeted `docs/knowledge/**` paths for role/topic meaning; intentional historical carriers remain unchanged per policy §3; Guard 10 allowlist no longer lists the three Git NEVER duplicates; `bun run validation:drift` still exits 0.
2. Wave B merged: each first-wave at-cap `SKILL.md` (`mstar-branch-worktree`, `mstar-conventions`, and any other body edited in that wave) has ≥10% headroom under its Guard 9 cap **without** a cap raise, or a same-PR raise is justified only after migration; new reference files are linked from the body's References table with load-when cues.
3. Wave C merged: the five long descriptions listed above are trigger contracts (symptoms/exclusions), not workflow summaries; `mstar-harness-core` typical-append / role presets document a minimization rule pointing at principle 3.
4. Touched skills pass `mstar skill lint <dir>`; behavior-shaping waves leave paired evidence per authoring Guard principles 4 and 6.
5. This record is promoted `proposed → implemented` in one PR that rewrites Proposal → present-tense Decision and folds criteria/risks into Consequences — no half-moved file.

## Risks

- **Over-splitting references** can hide HARD rules behind too many files and recreate duplication. Mitigation: every split keeps a single owner section and updates inbound pointers in the same PR; Guard 10 stays fail-closed.
- **Errata false positives** could rename intentional carriers (`qa.md`, CLI `--qa-gate`, historical reports). Mitigation: policy §3 explicitly preserves carriers; review checklist names them.
- **Trigger narrowing** may under-activate a skill that previously matched broad prose. Mitigation: Wave C pairs each description edit with at least one positive and one negative activation example in the PR body; held-out prompts per authoring principle 6.
- **Partial waves without promotion** leave this ADR stuck in `proposed/` while behavior already changed. Mitigation: acceptance criterion 5 — promote when the accepted subset is done, or supersede with a new record; never edit skills under a silent policy.
