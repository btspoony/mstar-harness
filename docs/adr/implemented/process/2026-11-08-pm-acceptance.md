# ADR: PM owns evidence-backed acceptance without a QA role

Status: implemented — PM Acceptance is the sole acceptance responsibility; independent QC is unchanged.
Date: 2026-11-08
Scope: Runtime roles, acceptance policy and completion evidence

## Problem

A separate acceptance-only QA seat reconstructs context already held by the primary PM and adds a serial dispatch/report handoff. That handoff is not independent code review and does not itself add runtime proof. Removing the seat without retaining its evidence duties would instead make QC approval or an implementer's summary appear sufficient for acceptance.

## Decision

The primary PM owns L4 acceptance for every delivery scope. Each required AC maps to relevant reproducible evidence, original input identity, an honest result and target-applicability reasoning. L1 implementation evidence, fresh L2 task review and independent L3 QC retain their distinct duties. QC verdicts are review evidence, not test logs. Residual cleanup, risk acceptance and separately authorized real-environment/E2E work keep their existing authority boundaries.

PM reuses applicable evidence and may fill a named gap with a short bounded acceptance check. This exception does not authorize implementation, test authoring, long suites or specialist ops; existing dev/ops roles supply that evidence while PM retains sign-off. Procedures and the report template have one owner: `skills/mstar-roles/references/project-manager/acceptance.md`.

The existing `qa: {gate, decision, report}` completion carrier remains, restricted for new submissions to `pm-acceptance`, `pass` and a real report. Optional `qaGate` is a checked fixed value, not another route. Completed QA evidence retains its actual authorship and timestamps. Active retired-gate configurations transition through ordinary prepare and completion retry, preserving progress, issues, source metadata and unrelated rows rather than repairing storage manually.

## Alternatives considered

- **Keep risk-tiered QA dispatch:** preserves the context reconstruction and alternate acceptance owner precisely for medium/bugfix/UI/residual work, contrary to the single-owner decision.
- **Rename QA or have QC accept:** changes the label or collapses independent review into acceptance without adding evidence. Neither solves the handoff or provenance problem.
- **Let PM execute all verification:** avoids dispatch but absorbs specialist implementation/environment authority and long-running work. A bounded gap-check exception is sufficient instead.
- **Rename the complete evidence transport:** creates broad API/storage churn unrelated to acceptance ownership. Keeping a historical carrier spelling does not keep a live role or dispatch alias.

## Consequences

PM bears explicit acceptance accountability and must not pass missing, failed or partially covered criteria. Specialist reports remain evidence inputs, never a replacement acceptance authority. Removing a separate seat reduces context transfer, not evidence requirements; model compliance still needs evaluation and cannot be established by static policy searches. Historical reports remain readable without falsely claiming PM executed them. Future changes must not reintroduce risk-triggered QA dispatch or reinterpret QC approval as runtime proof.
