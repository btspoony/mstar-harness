# Finding Format

The structured shape every audit finding must take — whether produced by a subagent or by a direct audit pass. Extracted from `audit-playbook.md` for quick reference and subagent dispatch.

## Why structure matters

Findings flow into a prioritization table and then into self-contained plans. Without structure, the auditor cannot compare leverage across categories, and the plan author cannot judge effort honestly. The format forces evidence before opinion.

## Template

```markdown
### [CATEGORY-NN] Short imperative title

- **Evidence**: `path/file.ts:123` — one-sentence description of what's there.
  (Repeat per location; 2–5 strongest locations, note "and ~N similar sites" if widespread.)
- **Impact**: What goes wrong / what's being paid because of this.
  Concrete: "every order-list render issues 1+N queries", not "suboptimal".
- **Effort**: XS | S | M | L | XL — for the *fix*, including tests.
  (Morning Star agent-oriented effort scale.)
- **Risk**: What the fix could break; LOW/MED/HIGH plus one line why.
- **Confidence**: HIGH (read the code, certain) / MED (strong signal, needs verification) /
  LOW (smell, needs investigation). LOW-confidence findings may be reported but get an
  "investigate" plan, not a "fix" plan.
- **Fix sketch**: 2–3 lines naming the restructuring move when the finding is structural; not the plan — just enough to judge effort honestly.
```

## Structural remedies

When the finding is structural, the Fix sketch names the restructuring move — e.g. replace a conditional chain with a typed dispatcher · collapse duplicate branches · separate orchestration from business logic · move feature logic to its owning layer · reuse the canonical helper · make the type boundary explicit · delete the pass-through wrapper · extract/split the oversized file. Prefer the remedy that removes moving pieces over one that relocates the same complexity.

## Category codes

| Code | Category |
|------|----------|
| `BUG` | Correctness / bugs |
| `SEC` | Security |
| `PERF` | Performance |
| `TEST` | Test coverage |
| `DEBT` | Tech debt & architecture |
| `DEP` | Dependencies & migrations |
| `DX` | DX & tooling |
| `DOCS` | Documentation |
| `DIR` | Direction (features & roadmap) |

## Direction findings — adaptations

Direction findings (`DIR-NN`) use the same format with two field changes:

- **Impact** = product/user value (who wants this and why now), not "what's broken."
- **Confidence** = how grounded the evidence is (not certainty it's the right call).

Plans for selected direction findings are usually *design/spike plans* (investigate, prototype, define the API, list open questions), not build-everything plans.

## What disqualifies a finding

- **No evidence**: "probably has N+1 queries" without a `file:line` is not a finding.
- **By-design behavior**: standard platform conventions (honoring `https_proxy`, reading `~/.netrc`) or tradeoffs explicitly recorded in an ADR. Flag only when the implementation adds risk beyond the convention.
- **Secret value reproduced**: never. Reference `file:line` and credential type only.
- **Could apply to any project**: direction suggestions without repo-specific grounding ("add dark mode", "add AI") are noise.

## Prioritization

Order by **leverage = impact ÷ effort, discounted by confidence and fix-risk**.

Tiebreakers:
1. Findings that unblock others (verification baseline, characterization tests) float up.
2. HIGH-confidence security findings float above equivalent-leverage non-security findings.
3. Prefer findings with a clean verification story.
4. "Not worth doing" is valid — record with one line of reasoning in the "considered and rejected" index section.
