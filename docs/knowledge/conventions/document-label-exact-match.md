---
module: packages/engine plan-markdown parsing (plan registration, plan-path resolution and the prepare amendment)
date: 2026-09-23
last_updated: 2026-11-09
problem_type: convention
category: conventions
severity: high
plan_id: "20260921-handoff-identity-recovery"
applies_when:
  - "Parsing keyed labels out of harness-authored Markdown (plans, Assignments, compasses, review reports)"
  - "Adding a descriptive sibling label next to a contractual one"
  - "Reviewing a label parser for prefix, contains or case-folding matches"
tags:
  - header-parsing
  - closed-label-set
  - prefix-match
  - plan-admission
  - refusal-diagnostics
---

# Label-keyed document parsing consults a closed label set, never a prefix

## Context

Plan admission reads a reviewed plan Markdown's keyed labels and refuses when a declaration disagrees with the metadata being registered or appended. Real plans carry **descriptive siblings that share a prefix** with the labels the contract consults — the dominant example is

```markdown
**Working branch:** feature/20260921-execution-session-core
**Working branch policy:** Feature branch from iteration/...; merge target ...; delivery target main.
```

A parser that matched labels by prefix, substring or a loosened pattern would read `Working branch policy` as a `Working branch` declaration. The consumed value would then be a sentence rather than a ref, and — worse — a plan that declares **no** branch at all but carries the prose would satisfy a check whose entire purpose is to bind the row to a real branch. The failure is invisible in review because such a document looks *more* complete, not less, and it reaches protected state (the appended row's branch metadata).

## Guidance

**Declare the consulted label set once, as data, and skip every other label.** The parser keeps one constant of the labels the contract actually consults (`packages/engine/src/plan-path.ts`, consumed by registration and the prepare amendment through `planDeclaredHeaders`):

```ts
const PLAN_CONSULTED_HEADERS: Record<string, true> = {
  plan_id: true,
  "main worktree branch": true,
  "working branch": true,
};
// ...
const label = match[1]!.trim();
const key = label.toLowerCase();
if (PLAN_CONSULTED_HEADERS[key] !== true) continue;   // exact key lookup, never a prefix
```

Supporting rules that make the set safe:

- **Normalize exactly what the producer varies.** Labels are compared case-folded; the accepted authored forms are the markup variants the plan corpus uses (`**Label:** value`, `**Label**: value`, plain `Label: value`). Normalizing further (trimming words, splitting on spaces, accepting a prefix) is what creates the alias.
- **A label outside the set is body content, not a declaration.** Without the closed set, a repeated body label (`**Files:**` once per task, each with a different value) reads as a conflicting declaration. The closed set is also what keeps repetition legal.
- **Skip fenced code.** Track the fence marker character and run length so a quoted example of a header is never read as a declaration, and a shorter backtick run inside a longer fence cannot close it early.
- **Refuse contradictory declarations of a consulted label** rather than picking one (`plan-path.conflicting-declaration`, carrying path, label, prior and value).
- **Refuse a missing declaration with actionable facts.** The refusal names the missing label and the reviewed plan path and carries structured details (plan id, field, path); tests assert those facts, not a pinned sentence. The refusal must leave protected bytes byte-identical — it happens before any mutation.
- **One parser, reused.** Registration, the amendment append path and readiness all read declarations through the same exported parser so a label can never be consulted under two different rules.

## Why This Matters

A prefix-tolerant parser turns a *descriptive* line into an *authoritative* one, so the admission gate silently accepts documents it exists to reject — and it does so for exactly the documents written by people trying to be helpful (adding explanation next to a contract). The mistake is nearly invisible: the parser passes its positive fixture, the descriptive label is read as valid, and no test fails until someone omits the real declaration. Because the accepted value then flows into the row's `metadata.working_branch` (and, at completion, into `handoff.source_branch`), a prose value can be stored as an anchor that no ref can match, converting a clear admission refusal into a confusing downstream failure.

## When to Apply

- Writing or reviewing any parser over harness-authored Markdown: `{PLAN_DIR}` plans, scoped Assignments, iteration compasses, review bundles.
- Adding a new label to such a document: if it shares a prefix with a consulted label, only exact matching keeps it descriptive.
- Reviewing a parser for `startsWith`, `includes`, regex alternation over label text, or "helpful" trimming — each is an alias in the making.
- Structuring the positive and negative fixtures for such a parser: the positive case must carry the descriptive sibling beside the real declaration and assert that the recorded value comes from the real one; the negative case must carry **only** the descriptive text and assert the missing-declaration refusal with unchanged protected bytes.

## Examples

### Before

`if (line.startsWith("working branch")) { record(line.slice(...)) }` — accepts `**Working branch policy:** …` as the branch declaration; the positive fixture passes for the wrong reason, and a policy-only plan is admitted with prose as its branch anchor.

### After

Exact lookup in the consulted set: a plan carrying both labels records the value of `Working branch`; a plan carrying only the policy sentence refuses with the missing-label diagnostic (`coordination.prepare-amendment.invalid-plan` on the amendment route) and byte-identical protected artifacts.

## Source

Iteration `iter-20260921-execution-2b-cutover`, plan `20260921-handoff-identity-recovery` (P7 regression task), over the parser in `packages/engine/src/plan-path.ts` with its amendment consumer in `packages/engine/src/coordination.ts`. Evidence: the plan QC consolidated and the L4 QA report under `{SDD_DIR}/review/` for that plan, and the L2 review of the P7 fixture in the same bundle. Related: `architecture-patterns/guarded-self-amendment-bootstrap.md` (the writer whose admission this parser feeds), `workflow-patterns/scoped-plan-gate-pinning.md` (archived) (the Assignment header seal and the bare-`Working branch` rule).
