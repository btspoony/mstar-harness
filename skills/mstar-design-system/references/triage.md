# Triage

Every difference is one of three things. The classification decides whether code changes, the
contract changes, or nothing changes — and getting it wrong in the first direction is how rounds
inflate.

## Three-way classification

| Class | Meaning | Test | Action |
|-------|---------|------|--------|
| **Defect** | the baseline states a value or a unit, and the implementation disagrees | the baseline is explicit, readable, and covers this unit | change the implementation |
| **Decision** | the baseline is silent, or states something the product no longer wants | the baseline does not settle it, or settling it needs product intent | record the choice and its reason where the design contract lives — the contract document, or the baseline's own README when the baseline is not a written contract; then align the implementation to that record |
| **Phantom** | the difference exists only in the comparison method | reading the tracked source instead of the render removes the difference | change nothing; fix the probe or the comparison scope |

The order of tests matters. Ask "is it in the baseline at all?" before "does it match?" — a
difference against a value the baseline never states is not a defect, and treating it as one adds
code that the next round will have to remove.

A **decision** is the only class that writes to that record. It needs a reason because the
next reader cannot distinguish a deliberate choice from an oversight, and the next round will treat
an unexplained silence as licence to guess.

## Decision record format

Record decisions where the contract lives, one block per decision:

```
unit:        <screen / component / token>
baseline:    <what the baseline says, or "silent">
implementation: <what the implementation does>
class:       decision
reason:      <why this is right for the product; what was rejected>
```

Keep it short enough that a reviewer reads it. A decision with no rejected alternative is usually a
defect that was renamed.

## Phantom catalogue

Each entry below is a real difference that looked like a defect and was not. Check this list before
opening a finding; extend it when a new phantom class is found.

| Phantom | Looks like | Why it is not a defect | How to confirm |
|---------|-----------|------------------------|----------------|
| **Row-meta default** | the implementation shows a metadata cell the baseline does not | a documented default permits the cell, but the comparison omitted that default | confirm the documented default applies to this unit; absence alone is not approval — without that evidence, record a decision |
| **Localized heading** | copy, casing, or line breaking differs from the baseline | the baseline is in one language, the implementation in another; the unit and its placement are identical | compare the unit's role and position, not its text |
| **Breadcrumb depth** | a navigation element is present in one side only | the baseline was captured at one route depth, so an ancestor trail exists on one side | check the baseline's captured route before treating it as a missing component |

The shared lesson: **every phantom in this catalogue was opened from a render — a thumbnail, a
preview, an exported image — not from the tracked source, and was settled by checking the source.**
For the first entry that check is a `grep` of the source for a documented default; for the
localized-heading entry it is reading the unit's role and position, because the text legitimately
differs; for the breadcrumb entry it is the route the baseline was captured at, not a search. A
finding opened from a render is a hypothesis until the tracked source settles it.

## What a phantom is not

A phantom is not "a difference that is hard to fix", and not "a difference the reviewer disagrees
with". If the baseline states the value and the implementation differs, it is a defect however
expensive the fix; if the baseline is silent and the product needs a decision, it is a decision
however small. Call it a phantom only when the comparison method, not either artifact, produced it.

## Residuals

Differences left open at the end of a round are neither classified away nor dropped: each one is a
defect or a decision without closure, and it belongs in the round's report with the unit and the
reason it stayed open. A difference that vanishes from the report while still being visible in the
product is the failure mode this file exists to prevent.
