# Implementer continuation prompt (sticky session)

Use when PM continues **`SDD implementer session: sticky`** for Task N>1. Host: **resume** same agent when supported (`sticky-implementer-session.md`).

```
Dispatch:
  Resume: [HOST_AGENT_ID from implementer-session.json]
  Name: <CamelCaseId>                 # omp/Cursor name
  Assignment header: canonical fields (`mstar-roles/references/project-manager/dispatch-and-assignment.md`) — MUST include **`Task budget (implement / ops rounds)`**: <budget copied from THIS plan task> in the header region, before the first Task heading / horizontal rule / `#` heading of the body; a `Task budget` string only inside the body section cannot satisfy the engine header gate, and a previous task's budget is not inherited as authorization for this task
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
    - Plan: [PLAN_FILE] — PM coordination context: [CONTEXT_FILE] (never use it to select your checkout)
    - Brief: [BRIEF_FILE] — Report: [REPORT_FILE]
    - First step on resume: re-observe `pwd` and the checked-out branch — a sticky session may wake in a different cwd; on mismatch with [FEATURE_CWD]/[WORKING_BRANCH], stop and report BLOCKED — do not write.
    - These destinations bind the handoff, not the host: a later deliberate `chdir`, absolute-path write outside [FEATURE_CWD], or host-native edit tool (apply_patch) is NOT blocked. Execute allowed commands directly with the tool workdir fixed to the verified [FEATURE_CWD] / [WORKING_BRANCH]. Hosted leaves must not invoke `mstar sdd exec --context` or resolve cwd from mutable shared context; that entry is reserved for PM serialized CLI launch (file-handoffs.md § Bound child launch).

    ## Context not in the brief

    [Interfaces from earlier tasks only if not already in your session]

    ## Report file

    Write your full report to: [REPORT_FILE] — follow the fresh implementer prompt's report format (`implementer-prompt.md` § Report format), including the residuals-disclosure row.

    ## Scope and stop

    Use only the brief's owned files, relevant inputs and named checks. Do not restart global exploration, extend the task, or run local full suites without the user's explicit scoped permission. Reuse unaffected evidence. Stop once the assigned acceptance criteria are evidenced; report concrete missing context instead of over-analyzing settled work.

    **Task budget / overrun**: the resumed Assignment header declares **`Task budget (implement / ops rounds)`** for THIS task — one implementer round closing its Files and verification gates (value copied from the plan task; a previous task's budget is not inherited as authorization for this task — a continuation is not an automatic budget extension). The value is validated in the header region only, so a `Task budget` string inside this body section cannot satisfy the engine header gate. If the declared round cannot close its Files and verification gates, stop adding work and return `NEEDS_CONTEXT` or `BLOCKED` — persist on disk the completed steps, the remaining implementation and its pending checks, evidence paths, worktree/branch state, and the concrete boundary reached; an incomplete round never reports `DONE` / `DONE_WITH_CONCERNS` as a substitute for the remaining work. **Budget pressure MUST NOT shorten or waive any assigned scoped verification.** Split/re-dispatch authority → `mstar-artifacts/references/plan-quality-bar.md` item 7.

    ## Your job

    1. Implement exactly what this brief specifies (prior tasks are done)
    2. Run only assigned affected unit tests or applicable scoped-check evidence; use file-handoffs.md § Verification evidence and retain unaffected prior evidence. When this task's Assignment names a PM-fixed capture request, capture the authorized check once with `mstar sdd evidence capture --request <absolute-task-request.json> -- <executable> [args...]` and cite the retained run's record/raw logs
    3. Commit on Working branch
    4. Write report file with actual evidence; return short summary only

    ## When stuck

    Report BLOCKED or NEEDS_CONTEXT — PM may reset session to fresh.
```

First task on a plan uses **`implementer-prompt.md`** (not this file).
