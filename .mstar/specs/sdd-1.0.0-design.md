# SDD 1.0.0 Design Spec (Morning Star Harness)

**Status: Locked — release-scoped (mstar-harness 1.0.0); partly superseded.** Implementation SSOT for the 1.0.0 SDD + single-QC release, kept as the historical record. It predates the v3.x path layout and the current skill corpus: `{PLAN_DIR}/reports/` is no longer a durable report home (raw QC/QA reports live in `{SDD_DIR}/review/`) and the relative `**SDD dir**: .mstar/sdd/<plan-id>/` example no longer holds (`SDD dir` must be absolute). Verify against `mstar-sdd` / `mstar-artifacts` before treating any statement here as current.

## Path symbols

| Symbol | Default path |
|--------|----------------|
| `{HARNESS_DIR}` | `.mstar/` (legacy `.agents/`) |
| `{PLAN_DIR}` | `{HARNESS_DIR}/plans/` |
| `{SDD_DIR}` | `{HARNESS_DIR}/sdd/<plan-id>/` |

`{PLAN_DIR}/` and `{PLAN_DIR}/reports/` stay durable SSOT. `{SDD_DIR}` is ephemeral runtime scratch (gitignored).

## SDD file contract

| File | Writer | Reader | Lifecycle |
|------|--------|--------|-----------|
| `progress.md` | PM | PM (compaction resume) | Append per completed task |
| `task-N-brief.md` | `task-brief` script | implementer, task reviewer | Per task |
| `task-N-report.md` | implementer | PM, task reviewer, fix subagent | Per task; fix appends |
| `review-<base>..<head>.diff` | `review-package` script | task reviewer | Per review pass |
| `branch-review-<base>..<head>.diff` | `review-package` (MERGE_BASE..HEAD) | plan QC | Once before QC |

Naming: brief `task-N-brief.md` → report `task-N-report.md`. Never paste these into PM dispatch prompts — pass paths only.

## Assignment fields (SDD implement wave)

```markdown
**Execution mode**: sdd | inline
**SDD dir**: .mstar/sdd/<plan-id>/
**Model tier**: fast | standard | capable
```

QC wave (**SDD — mandatory tri**):

```markdown
**QC mode**: full tri-review
**Review package path**: <path to branch-review-*.diff>
**Model tier**: capable
```

Inline exception: `**QC mode**: single` when `Execution mode: inline`.

## Model tier semantics

| Tier | Typical use |
|------|-------------|
| `fast` | Transcription tasks (plan contains complete code); single-file mechanical fixes |
| `standard` | Prose implementers; task reviewers; default QC when diff is moderate |
| `capable` | Integration judgment; plan-level QC on large/subtle branch diffs |

**Turn count beats token price:** reviewers and prose implementers use `standard` as floor; do not default omitted model to session's most capable tier.

## Implementer statuses

`DONE` | `DONE_WITH_CONCERNS` | `NEEDS_CONTEXT` | `BLOCKED`

PM must not hard-retry `BLOCKED` with same model without changing inputs.

## Review discipline

- Per-task BASE SHA recorded before implementer dispatch; **never `HEAD~1`** for review-package.
- Task reviewer: read-only checkout; read diff file once; do not re-run full suite.
- `⚠️ Cannot verify from diff` → PM resolves before marking task complete.
- Fix loop: report must include covering tests, command, output before re-review.
- Minor findings → `progress.md` minor section for plan QC triage.

## QC default (1.0.0)

- **`Execution mode: sdd`**: mandatory **tri-review** — `qc1`…`qc3` + consolidated, **N=3** same message. Plan QC reads **branch** review-package.
- **`inline`**: single-seat `qc.md` permitted.
- Critical/Important QC findings → **one** fix dispatch with full list.

## Cleanup

- `.mstar/sdd/` in project `.gitignore` + `{SDD_DIR}/.gitignore` with `*`.
- Optional `rm -rf {SDD_DIR}` on plan Done or worktree remove.
- `git clean -fdx` destroys ledger; recover via `status.json` `task_commits[]` + `git log`.

## Breaking changes (1.0.0)

See root `CHANGELOG.md` § [1.0.0].

## Superpowers v6 alignment

Core: file handoff, merged task reviewer, explicit model tier, progress ledger, pre-flight scan, Global Constraints + Interfaces in plans.

Intentional Mstar divergence: PM orchestration; **L2 task reviewer + L3 tri cross-review** (not v6 single final reviewer only); `{SDD_DIR}` per plan-id; QA + residual + iteration phases retained.
