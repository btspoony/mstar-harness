# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `mstar-sdd` (recommended) or inline execution. Steps use checkbox (`- [ ]`) syntax.

**Goal:** [One sentence]

**Architecture:** [2–3 sentences]

**Tech Stack:** [Key technologies]

**Execution:** mstar-sdd | inline

## Global Constraints

[Project-wide requirements — version floors, naming, exact values — copied verbatim from spec. Every task implicitly includes this section.]

---

### Task 1: [Component Name]

**Files:**
- Create: `exact/path/to/file`
- Modify: `exact/path/existing.py`
- Test: `tests/path/test.py`

**Interfaces:**
- Consumes: [signatures from earlier tasks]
- Produces: [what later tasks rely on]

- [ ] **Step 1: Write the failing test**

```python
# complete test code
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pytest tests/path/test.py -v`

- [ ] **Step 3: Minimal implementation**

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

## Plan self-review (PM before locked)

1. **Spec coverage:** every spec requirement maps to a task
2. **Placeholder scan:** no TBD, no "add tests" without code
3. **Type consistency:** names match across tasks

## SDD runtime (ephemeral)

When using `mstar-sdd`, artifacts live under `{SDD_DIR}` (see `mstar-plan-conventions`). Do not duplicate briefs/reports in this file.
