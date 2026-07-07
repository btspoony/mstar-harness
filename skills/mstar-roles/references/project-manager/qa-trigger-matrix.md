# QA Trigger Matrix (PM Reference)

Extension of `references/project-manager.md`. Use when choosing **`QA gate`** and **`QA mode`** on Assignments and before plan `Done`. NEVER rules → same file § PM-Specific NEVER Rules (QA gate bullets).

## Assignment fields (SSOT)

| Field | Values | Meaning |
| --- | --- | --- |
| **`QA gate`** | `mandatory` | After QC passes, dispatch `qa-engineer` |
| | `pm-acceptance` | Do **not** dispatch QA; PM completes acceptance checklist and may mark `Done` |
| | `report-only` | Primary route is investigation/repro only; dispatch `qa-engineer` (QC tri may be skipped per rules) |
| **`QA mode`** | `acceptance-only` (default when QA dispatched) | Evidence reuse first; map plan DoD to existing QC/dev evidence |
| | `full` | Full verification run when QC lacks test evidence, fix wave, high-risk, or user override |
| | `report-only` | No business-code changes unless explicitly allowed |

**Deprecated:** `QA note: skipped / self-check` — use **`QA gate: pm-acceptance`** plus **`QA gate reason: <tier>`**.

Set **`QA gate`** on the **first implement Assignment** (or plan frontmatter) and keep it consistent through QC closure unless scope/risk changes force an upgrade to `mandatory`.

## Trigger matrix (default)

| Scenario | Default `QA gate` | Default `QA mode` (if QA dispatched) |
| --- | --- | --- |
| Hotfix / `Execution mode: inline` | `pm-acceptance` | N/A |
| Small feature: non-UI, no open R#, QC clean `Approve` (not `Approve with residuals`) | `pm-acceptance` | N/A |
| Bug fix (RCA + regression scope; default route) | `mandatory` | `acceptance-only` |
| Medium / Large feature | `mandatory` | `acceptance-only` |
| `Approve with residuals` or any open R# in `status.json` | `mandatory` | `acceptance-only` (includes R# verify) |
| UI-visible change (`Task category: visual` or observable evidence gate) | `mandatory` | `acceptance-only` (UI observable evidence required; escalate to `full` if missing) |
| High-risk ops | `mandatory` | `full` |
| QA report-only primary route | `report-only` | `report-only` |
| Product-docs-only / tech-spec-only (no runtime diff) | N/A | — |
| User explicit full QA request | `mandatory` | `full` |

**Upgrade rule:** If conditions change mid-round (e.g. QC becomes `Approve with residuals`, UI scope added, open R# registered), change `QA gate` from `pm-acceptance` to `mandatory` before `Done`.

## PM acceptance checklist (required before `Done` when `QA gate: pm-acceptance`)

PM completes this in **Status Update** (or plan closure note). PM **does not** run bash tests or reproduction in the orchestration thread.

1. **QC verdict:** `qc-consolidated.md` or `qc.md` shows `Approve` with **Critical = 0** and **Warning = 0** (not `Approve with residuals`).
2. **DoD mapping:** Each plan Acceptance Criterion maps to **existing** evidence (dev Completion Report, QC `Tools run`, SDD TDD triple, CI links) — cite paths/commands, do not re-execute.
3. **Residuals:** `status.json` has **no open R#** for this `plan_id` (or documented waiver per `mstar-plan-artifacts`).
4. **Checkout alignment:** `Working branch` and `Review range / Diff basis` match QC report verified lines.
5. **`QA gate reason`:** One line naming the tier (e.g. `hotfix-inline`, `small-feature-clean-qc`).

```markdown
## PM Acceptance (qa gate: pm-acceptance)
- QA gate reason: <tier>
- QC report: <path> — Approve, Critical/Warning 0
- DoD mapping: <AC-id> → <evidence ref> …
- Residuals: none open | waived R# …
- Checkout: Working branch <name>; Review range <basis> (per QC Scope)
```
