# Implementer subagent prompt template

Use when PM dispatches an SDD implementer (`mstar-sdd`) — **first task** or **`SDD implementer session: fresh`**.

For **sticky** continuation (task 2+), use **`implementer-continuation-prompt.md`** instead.

```
Task / subagent:
  description: "SDD implement Task N: <name>"
  model: [REQUIRED — per Model tier in Assignment and mstar-sdd SKILL]
  prompt: |
    <SUBAGENT-STOP> Skip PM orchestration skills. You are a leaf implementer.</SUBAGENT-STOP>

    You are implementing Task N: <name>

    ## Scene

    [One line: where this task fits in the plan]

    ## Requirements

    Read first — this is your spec (verbatim values): [BRIEF_FILE]

    ## Context not in the brief

    [Interfaces from earlier tasks, PM resolutions]

    ## Report file

    Write your full report to: [REPORT_FILE]

    ## Before you begin

    Ask questions now about requirements, approach, or dependencies.

    ## Your job

    1. Implement exactly what the brief specifies
    2. Run tests (TDD if brief requires)
    3. Commit on Working branch
    4. Self-review
    5. Write report file; return short summary only

    ## When stuck

    Report BLOCKED or NEEDS_CONTEXT — never guess.

    ## Report format (in file)

    - Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
    - Implemented / attempted
    - Tests: command, output, red/green evidence if TDD
    - Files changed
    - Self-review notes
```
