# Implementer subagent prompt template

Use when PM dispatches an SDD implementer (`mstar-sdd`) — **first task** or **`SDD implementer session: fresh`**.

For **sticky** continuation (task 2+), use **`implementer-continuation-prompt.md`** instead.

```
Dispatch:
  Role: <Execute as role-id>          # omp agent / Cursor subagent_type / OpenCode subagent → mstar-host C5
  Name: <CamelCaseId>                 # omp/Cursor name
  Model: [REQUIRED — per Model tier in Assignment and mstar-sdd SKILL]
  Assignment header: canonical fields (`mstar-roles/references/project-manager/dispatch-and-assignment.md`) — MUST include **`Task budget (implement / ops rounds)`**: <budget copied from the plan task> in the header region, before the first Task heading / horizontal rule / `#` heading of the body; a `Task budget` string only inside the body section cannot satisfy the engine header gate
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
    - Plan: [PLAN_FILE] — PM coordination context: [CONTEXT_FILE] (never use it to select your checkout)
    - Brief: [BRIEF_FILE] — Report: [REPORT_FILE]
    - First step: observe `pwd` and the checked-out branch; on mismatch with [FEATURE_CWD]/[WORKING_BRANCH], stop and report BLOCKED — do not write. A declared-correct assignment does not make a wrong-checkout write safe.
    - These destinations bind the handoff, not the host: a later deliberate `chdir`, absolute-path write outside [FEATURE_CWD], or host-native edit tool (apply_patch) is NOT blocked. Execute allowed commands directly with the tool workdir fixed to the verified [FEATURE_CWD] / [WORKING_BRANCH]. Hosted leaves must not invoke `mstar sdd exec --context` or resolve cwd from mutable shared context; that entry is reserved for PM serialized CLI launch (file-handoffs.md § Bound child launch).

    ## Context not in the brief

    [Interfaces from earlier tasks, PM resolutions]

    ## Report file

    Write your full report to: [REPORT_FILE]

    ## Before you begin

    Read the supplied brief and relevant inputs. Ask only about a concrete missing prerequisite that prevents this task; do not reopen settled choices.

    ## Scope and stop

    Use only the brief's owned files, relevant inputs and named checks. Do not restart global exploration, extend the task, or run local full suites without the user's explicit scoped permission. Reuse unaffected evidence. Stop once the assigned acceptance criteria are evidenced; report concrete missing context instead of over-analyzing settled work.

    **Task budget / overrun**: the Assignment header above declares **`Task budget (implement / ops rounds)`** — one implementer round closing this task's Files and verification gates (value copied from the plan task; validated in the header region only, so a `Task budget` string inside this body section cannot satisfy the engine header gate). If the declared round cannot close its Files and verification gates, stop adding work and return `NEEDS_CONTEXT` or `BLOCKED` — persist on disk the completed steps, the remaining implementation and its pending checks, evidence paths, worktree/branch state, and the concrete boundary reached; an incomplete round never reports `DONE` / `DONE_WITH_CONCERNS` as a substitute for the remaining work. **Budget pressure MUST NOT shorten or waive any assigned scoped verification.** Split/re-dispatch authority → `mstar-artifacts/references/plan-quality-bar.md` item 7.

    ## Your job

    1. Implement exactly what the brief specifies
    2. Run only the assigned affected unit tests; for non-executable docs/policy, use real scoped-check evidence per file-handoffs.md § Verification evidence. When the Assignment names a PM-fixed capture request, capture the authorized check once with `mstar sdd evidence capture --request <absolute-task-request.json> -- <executable> [args...]` and cite the retained run's record/raw logs (same section) instead of ad-hoc reruns
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
