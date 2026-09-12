# Implementer continuation prompt (sticky session)

Use when PM continues **`SDD implementer session: sticky`** for Task N>1. Host: **resume** same agent when supported (`sticky-implementer-session.md`).

```
Dispatch:
  Resume: [HOST_AGENT_ID from implementer-session.json]
  Name: <CamelCaseId>                 # omp/Cursor name
  Model: [same tier as session start unless PM upgrades]
  Prompt body:
    <SUBAGENT-STOP> Skip PM orchestration skills. You are a leaf implementer continuing a sticky SDD session.</SUBAGENT-STOP>

    Continue as the same implementer on plan <plan-id>, Working branch: <branch>.

    ## Completed (do not redo)

    Read: [SDD_DIR]/progress.md and [SDD_DIR]/implementer-session.json

    ## This task

    Task N: <name>

    Read first — your spec (verbatim): [BRIEF_FILE]

    ## Destinations (absolute — re-validate on resume)

    - Control harness root (briefs/reports/diffs live here): [CONTROL_ROOT]
    - Feature worktree — cwd for all source edits, branch [WORKING_BRANCH]: [FEATURE_CWD]
    - Plan: [PLAN_FILE] — Context file: [CONTEXT_FILE]
    - Brief: [BRIEF_FILE] — Report: [REPORT_FILE]
    - First step on resume: re-observe `pwd` and the checked-out branch — a sticky session may wake in a different cwd; on mismatch with [FEATURE_CWD]/[WORKING_BRANCH], stop and report BLOCKED — do not write.
    - These destinations bind the handoff, not the host: a later deliberate `chdir`, absolute-path write outside [FEATURE_CWD], or host-native edit tool (apply_patch) is NOT blocked. CLI-launchable children are started via `mstar sdd exec --context [CONTEXT_FILE] -- <argv>` (starting cwd = feature worktree).

    ## Context not in the brief

    [Interfaces from earlier tasks only if not already in your session]

    ## Report file

    Write your full report to: [REPORT_FILE]

    ## Scope and stop

    Use only the brief's owned files, relevant inputs and named checks. Do not restart global exploration, extend the task, or run local full suites without the user's explicit scoped permission. Reuse unaffected evidence. Stop once the assigned acceptance criteria are evidenced; report concrete missing context instead of over-analyzing settled work.

    ## Your job

    1. Implement exactly what this brief specifies (prior tasks are done)
    2. Run only assigned affected unit tests or applicable scoped-check evidence; use file-handoffs.md § Verification evidence and retain unaffected prior evidence
    3. Commit on Working branch
    4. Write report file with actual evidence; return short summary only

    ## When stuck

    Report BLOCKED or NEEDS_CONTEXT — PM may reset session to fresh.
```

First task on a plan uses **`implementer-prompt.md`** (not this file).
