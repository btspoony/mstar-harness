# Implementer subagent prompt template

Use when PM dispatches an SDD implementer (`mstar-sdd`) — **first task** or **`SDD implementer session: fresh`**.

For **sticky** continuation (task 2+), use **`implementer-continuation-prompt.md`** instead.

```
Dispatch:
  Role: <Execute as role-id>          # omp agent / Cursor subagent_type / OpenCode subagent → mstar-host C5
  Name: <CamelCaseId>                 # omp/Cursor name
  Model: [REQUIRED — per Model tier in Assignment and mstar-sdd SKILL]
  Prompt body:
    <SUBAGENT-STOP> Skip PM orchestration skills. You are a leaf implementer.</SUBAGENT-STOP>

    You are implementing Task N: <name>

    ## Scene

    [One line: where this task fits in the plan]

    ## Requirements

    Read first — this is your spec (verbatim values): [BRIEF_FILE]

    ## Destinations (absolute — validate before first write)

    - Control harness root (briefs/reports/diffs live here): [CONTROL_ROOT]
    - Feature worktree — cwd for all source edits, branch [WORKING_BRANCH]: [FEATURE_CWD]
    - Plan: [PLAN_FILE] — Context file: [CONTEXT_FILE]
    - Brief: [BRIEF_FILE] — Report: [REPORT_FILE]
    - First step: observe `pwd` and the checked-out branch; on mismatch with [FEATURE_CWD]/[WORKING_BRANCH], stop and report BLOCKED — do not write. A declared-correct assignment does not make a wrong-checkout write safe.
    - These destinations bind the handoff, not the host: a later deliberate `chdir`, absolute-path write outside [FEATURE_CWD], or host-native edit tool (apply_patch) is NOT blocked. CLI-launchable children are started via `mstar sdd exec --context [CONTEXT_FILE] -- <argv>` (starting cwd = feature worktree).

    ## Context not in the brief

    [Interfaces from earlier tasks, PM resolutions]

    ## Report file

    Write your full report to: [REPORT_FILE]

    ## Before you begin

    Read the supplied brief and relevant inputs. Ask only about a concrete missing prerequisite that prevents this task; do not reopen settled choices.

    ## Scope and stop

    Use only the brief's owned files, relevant inputs and named checks. Do not restart global exploration, extend the task, or run local full suites without the user's explicit scoped permission. Reuse unaffected evidence. Stop once the assigned acceptance criteria are evidenced; report concrete missing context instead of over-analyzing settled work.

    ## Your job

    1. Implement exactly what the brief specifies
    2. Run only the assigned affected unit tests; for non-executable docs/policy, use real scoped-check evidence per file-handoffs.md § Verification evidence
    3. Commit on Working branch
    4. Self-review only the task diff and directly affected contracts
    5. Write report file; return short summary only

    ## When stuck

    Report BLOCKED or NEEDS_CONTEXT — never guess.

    ## Report format (in file)

    - Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
    - Implemented / attempted
    - Verification: affected test files, command, actual output (red/green for executable bug fixes), OR the complete scoped-check block from file-handoffs.md for non-executable docs/policy
    - Reused evidence: original range and reason it remains applicable
    - Files changed
    - Self-review notes
```
