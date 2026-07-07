# Implementer continuation prompt (sticky session)

Use when PM continues **`SDD implementer session: sticky`** for Task N>1. Host: **resume** same agent when supported (`sticky-implementer-session.md`).

```
Task / subagent:
  resume: [HOST_AGENT_ID from implementer-session.json]
  description: "SDD continue Task N: <name>"
  model: [same tier as session start unless PM upgrades]
  prompt: |
    <SUBAGENT-STOP> Skip PM orchestration skills. You are a leaf implementer continuing a sticky SDD session.</SUBAGENT-STOP>

    Continue as the same implementer on plan <plan-id>, Working branch: <branch>.

    ## Completed (do not redo)

    Read: [SDD_DIR]/progress.md and [SDD_DIR]/implementer-session.json

    ## This task

    Task N: <name>

    Read first — your spec (verbatim): [BRIEF_FILE]

    ## Context not in the brief

    [Interfaces from earlier tasks only if not already in your session]

    ## Report file

    Write your full report to: [REPORT_FILE]

    ## Your job

    1. Implement exactly what this brief specifies (prior tasks are done)
    2. Run tests; commit on Working branch
    3. Write report file; return short summary only

    ## When stuck

    Report BLOCKED or NEEDS_CONTEXT — PM may reset session to fresh.
```

First task on a plan uses **`implementer-prompt.md`** (not this file).
