# Review responsibility boundaries (1.0.0+)

## Four layers (orthogonal — do not collapse)

| Layer | Who | When | Scope | Input |
|-------|-----|------|-------|--------|
| **L1** Implementer | dev subagent | Per task | Write code + **run** TDD / verification evidence | `task-N-brief.md` |
| **L2** Task reviewer | PM-dispatched subagent (SDD) | Per task, after implementer | Spec + quality for **one task** (diff-first; no full suite) | brief, report, **task-level** diff |
| **L3** Plan QC tri (cross-review) | `qc-specialist` + `qc-specialist-2` + `qc-specialist-3` | After **all** tasks on branch | **Code-review seat** — diff, language/logic, security & contract lenses on **whole branch**; **not** the test-execution path | Branch `review-package` MERGE_BASE..HEAD |
| **L4** QA | `qa-engineer` when **`QA gate: mandatory`**; else PM acceptance | After QC gate | DoD acceptance, residual verify, targeted/full **command** verification, Done recommendation | Review bundle + plan + **L1 evidence** + `status.json` |

PM sets **`QA gate`** per `mstar-roles/references/project-manager/qa-trigger-matrix.md`. L4 execution when dispatched → `mstar-roles/references/qa-engineer/acceptance-gate.md`.

### L3 vs L4 vs L1 — who runs commands?

| Duty | Owner | QC (`qc-specialist*`) |
|------|-------|------------------------|
| Produce runnable test/build evidence | **L1** implementer | **Does not** own |
| Diff / logic / vulnerability / contract review | **L3** QC (and L2 task reviewer) | **Primary job** |
| Map DoD → evidence; re-run gaps; close residuals | **L4** QA (or PM acceptance) | **Does not** own |
| Full / targeted test suites, builds, installs | **L1** and/or **L4** | **NEVER** — leave to QA/dev |

**Why:** SDD plan QC is **N=3 parallel** on a **shared** `Review cwd`. Build/test/lint toolchains contend for caches and locks and falsely `Blocked` peer reviewers. QC is a **reviewer**, not a second QA lane.

**SDD rule:** Layers L1–L2 run **per task** (serial). Layer L3 is **mandatory full tri-review** (`N=3`) whenever **`Execution mode: sdd`** — single-plan **and** iteration **and** multi-plan iteration. Layer L3 is **not** optional “final single review”.

**Non-SDD (`Execution mode: inline`):** hotfix / single-stream — plan QC may be **single-seat** (`qc.md`) or skipped per PM routing.

Per-task spec/quality is **done** in L2 before L3. QC seats do not re-derive each task from scratch; they cross-review the **whole branch** for gaps L2 could not see.

## Plan QC tri (SDD mandatory)

- Assignment: **`QC mode: full tri-review`** (implicit when `Execution mode: sdd`; PM may state explicitly).
- **N=3** same dispatch message: QC#1 architecture/maintainability → `{SDD_DIR}/review/qc1.md`; QC#2 security/correctness → `{SDD_DIR}/review/qc2.md`; QC#3 performance/reliability → `{SDD_DIR}/review/qc3.md`.
- PM **`{SDD_DIR}/review/qc-consolidated.md`** — cross-review synthesis; PM gate input and source for durable main-plan summary.
- Dispatch must include **Review package path** (branch diff file).
- **NEVER** substitute a single `qc-specialist` for L3 when SDD was used, unless user override: `QC mode: single — override: <reason>`.

## Plan QC single-seat (inline / exception only)

- Report: `{SDD_DIR}/review/qc.md`
- `Execution mode: inline` hotfix paths; or explicit override on SDD plan.
- `N=1`; no `qc-consolidated.md` required.

## Fix waves

| After | Fix dispatch |
|-------|----------------|
| Task review Critical/Important | Task fix subagent → task re-review (L2) |
| Plan QC Critical/Important | **One** fix subagent with **complete** finding list → **targeted** QC re-review (listed seats) |

## Minor findings

Task reviewer Minor → `{SDD_DIR}/progress.md` § Minor. Plan QC Minor → `{SDD_DIR}/review/qcN.md` + optional residual via PM.
