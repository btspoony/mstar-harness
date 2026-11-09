---
module: qc orchestration / host model routing
date: 2026-09-16
last_updated: 2026-09-16
problem_type: tooling_decision
category: tooling-decisions
severity: medium
plan_id: <plan-id> (plan QC tri wave of 2026-09-16)
applies_when:
  - "a dispatched seat returns no report and the failure is a provider-level error"
  - "a seat's configured primary account is exhausted during a review wave"
  - "deciding whether a wave's identity gate still holds after a seat death"
tags:
  - qc
  - seat-identity
  - provider-exhaustion
  - model-fallback
  - evidence-honesty
  - orchestration
---

# QC seat with an exhausted provider account: verify state, re-dispatch the same identity, never re-wire the wave

## Context

A tri-review wave binds three distinct role identities in one dispatch turn, each with its own configured model chain. When one seat's configured primary account is exhausted at the provider level, the seat can die with a hard error and write no report — and that failure is easy to misclassify as a broken dispatch, a lost seat, or a seat that reviewed and found nothing.

Observed in a plan QC tri wave: the failing seat's configured primary belonged to an account that the usage read showed at 100% used (0.00 remaining, weekly reset roughly two days away). The seat's first two invocations died on the provider's hard 403 without writing a report — one after roughly three minutes of reads, one in well under a second. A minimal probe spawn and then the real third invocation both served successfully through the configured chain, and the seat reported a serving model different from its configured primary. No host configuration was changed for the wave, and the wave kept its three distinct identities and its three reports.

## Guidance

1. **Read a no-report death as provider state, not as a review result.** A seat that dies before writing has produced no verdict: it is unavailable, not negative, and not `Unconfirmed` evidence of a defect. Absence of a report must never be counted as a finding, as a pass, or as a review-coverage gap when the wave is consolidated — the wave is short one report until the seat is re-dispatched.

2. **Verify provider state first, and record what it says.** Check the account the seat's configured primary belongs to (a usage/credits read) before touching dispatch. The number explains the death; it is not a substitute for a report, and it must not be used to quietly re-scope the seat.

3. **Re-dispatch the same seat identity.** The identity gate is about three distinct role identities and one dispatch turn — not about which model serves them. Re-dispatch the seat that failed, under the same identity and the same assignment. Do not reassign its scope to a sibling seat, do not collapse the tri wave into fewer seats, and do not let the surviving seats absorb a lens they were not bound to: doing so changes the guarantee the wave exists to provide.

4. **Probe minimally, then run the real dispatch.** A cheap probe spawn establishes that the chain serves at all; the real invocation is the evidence. Both served through the configured chain in the observed wave. A probe is a diagnostic only — it never stands in for the seat's own report.

5. **Treat a seat's self-reported model as its own declaration.** The host does not independently attribute a serving model to a seat, so a fallback that changes the serving model neither invalidates the seat's identity nor taints its report; the reported model is recorded as the seat's declaration. This is the same honesty limit the evaluation runner carries (no model-identity field in the stream; the observed model stays null with a recorded reason) — see `tooling-decisions/skill-eval-baseline-operations.md` for the general statement; this document only applies it to a review wave.

6. **Do not edit global host model configuration mid-wave.** No configuration change was made in the observed wave and none was needed: the per-agent chain engaged by itself. Editing global model settings mid-wave moves the serving surface for seats that already reported, which weakens the wave's model-independence claim instead of repairing it. If a config change is genuinely required, it belongs before the wave, not inside it.

7. **Record the availability note in the gate record.** Write down, where the gate decision lives (the consolidated review record and the plan/compass gate summary): the account state observed, how many invocations died and after how much work, that a probe and the real invocation served, and what remains unestablished. An unrecorded seat death reads later as a silent degradation of the wave.

8. **Separate the identity claim from the model-family claim.** A wave with three distinct serving families satisfies the model-independence gate, and that statement must name its basis (the three families the seats reported, each of which is a self-declaration). The seat-count/identity gate and the model-family statement are two different claims; a wave that lost and re-dispatched a seat still has to establish both.

## What this round did not establish

- Whether the fallback chain engages on a **first-call** failure as opposed to a turn that has already emitted output. The wave observed one death after substantial reads and one that died almost immediately, and both were superseded by a successful invocation; the engagement rule itself was not isolated.
- Whether the deaths were caused solely by account exhaustion. The recorded account state and the hard provider error are consistent with it, but no provider-side explanation was obtained.
- The retry/fallback configuration values read during the wave (`retry.enabled` and `retry.modelFallback` true, no provider disabled) come from the round's own host-config inspection; no artifact cited in this document re-derives them, so they are recorded here as that inspection's observation.

## Why This Matters

The cost of misclassifying a dead seat is asymmetric. Counting it as a reviewer fabricates coverage the wave never had; re-wiring the wave to route around it silently changes the identity model the gate exists to enforce, and the change is invisible in the final verdict. Re-dispatching the same identity is the cheapest action that restores a real report without altering the wave's guarantees — and because the chain can serve a different model than the configured primary, the seat's declaration has to be recorded as a declaration rather than treated as host-attributed fact.

## When to Apply

- A dispatched seat returns no report and the failure is a provider-level error (auth/permission/quota), especially a hard 403.
- A usage read shows the seat's configured account exhausted before or during a review wave.
- Consolidating a wave with fewer reports than seats, or deciding whether to describe a wave as degraded.
- Any host whose per-agent model chain can silently serve a different model than the seat's configured primary.

## Examples

- Synthetic shape: the second seat's configured primary reports 100% used; two invocations die with a provider error and create no report file. Handling: verify the account state, re-dispatch the same seat unchanged, and record the availability note; when the seat reports, its report names a different serving model, its verdict counts normally, and the consolidated record states that three distinct families served the wave (each family as the seat's own declaration).
- Anti-pattern: reassigning the dead seat's scope to a surviving seat "to save a turn" — the wave then has two identities and one identity covers two lenses, so the three-identity claim can no longer be made even though three reports exist.
- Anti-pattern: editing global model settings mid-wave to route around the exhausted account — seats that already reported were served by the old surface, so the wave's independence statement becomes unverifiable.

## Source

Plan QC tri-review availability note plus the plan and compass gate summaries for plan `<plan-id>`; evidence under `{SDD_DIR}/<plan-id>/review/`. Facts quoted: the configured-primary account at 100% used in the usage read, two no-report invocations (one after substantial reads, one immediately), a probe plus the real invocation both serving through the configured chain, a different serving model reported by the seat, no host config change, and three distinct serving families in the consolidated wave.

## Related

- `tooling-decisions/skill-eval-baseline-operations.md` — the general model-identity honesty limit this document applies to QC seats.
- `architecture-patterns/dispatch-binding-fail-closed.md` — the binding gate the identity claims of a wave rest on (fail closed, never skip the precheck).
