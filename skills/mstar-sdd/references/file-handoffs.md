# File handoffs (Morning Star SDD)

PM and subagents move artifacts as **files**, not pasted text. Pasted content stays in PM context for every later turn.

## Before implementer dispatch

**PM owns helper execution and shared coordination writes.** Keep one canonical per-plan `{SDD_DIR}` root; only PM writes its `context.json` and `progress.md`. Subdirectories namespace artifacts, not a second SDD root. Scheduling → `mstar-sdd` § Ready-task scheduling.

PM runs context-dependent `mstar sdd workspace`, `task-brief`, and `review-package` helpers serially for the corresponding assigned checkout/branch. These helpers may update shared context; parallel hosted leaves never invoke them. Before each dispatch, PM fixes absolute task-specific brief/report/diff destinations and copies `Worktree path` / branch into the Assignment. Updating context for another task must not change an already-dispatched leaf's inputs.

1. `export SDD_DIR=$(mstar sdd workspace <plan-id>)`
   - Iteration L1 (implementer cwd = feature worktree):
     `export MSTAR_CONTROL_ROOT=<main repo root>` — the **derived main worktree** root, verified by Git probing before the fail-closed guard
     or `mstar sdd workspace <plan-id> <main-repo-root>`
     so `{SDD_DIR}` lands on the control harness (default-gitignored plans/status/sdd). Do not create a second SDD tree under the feature checkout.
2. PM writes `$SDD_DIR/context.json` for the current helper operation — parallel hosted handoffs pin these values in their Assignment instead of consulting mutable plan context:

   ```json
   {
     "planId": "<plan-id>",
     "controlHarnessRoot": "<absolute control harness root>",
     "featureCwd": "<absolute feature worktree>",
     "workingBranch": "<assigned branch>",
     "planFile": "<absolute plan path under the control harness>",
     "sddDir": "<absolute $SDD_DIR>"
   }
   ```

   All paths absolute; `planFile`/`sddDir` must resolve inside the control harness; `featureCwd` must be the assigned feature worktree on `workingBranch`. The declared control root is authoritative — never re-inferred from the feature cwd, and it must canonicalize to the Git-derived main worktree root (an integration/foreign checkout is refused, not redirected).
3. `mstar sdd task-brief <plan-file> <N> --context "$SDD_DIR/context.json"` — bound producer: validates the artifact destination **before** mkdir/write and prints the absolute brief path (`{SDD_DIR}/task-N-brief.md`).
4. Record `BASE_SHA` (`BASE_SHA=$(git -C "$FEATURE_CWD" rev-parse HEAD)` before dispatch). For dependent tasks, first satisfy `mstar-sdd` § Ready-task scheduling: PM serially integrates reviewed prerequisite commits and records their ancestry in this base. Include those commit/base IDs and the check result in the handoff; review approval alone is insufficient.
5. Dispatch implementer with:
   - One line scene-setting (where task fits)
   - Absolute brief path: read first — verbatim requirements
   - Interfaces / decisions brief cannot know
   - Absolute report path: `$SDD_DIR/task-N-report.md`
   - Absolute control root, feature cwd, branch and plan paths, plus task-specific brief/report/diff paths fixed for this dispatch; the context path is PM coordination metadata, not a leaf checkout selector
   - `Model tier` → host-specific model (required)
   - **`SDD implementer session`**: `fresh` (new subagent) or `sticky` (resume — see **`sticky-implementer-session.md`**)

## Implementer report file

Implementer writes full report to `task-N-report.md`. Return to PM only:

- Status: `DONE` | `DONE_WITH_CONCERNS` | `NEEDS_CONTEXT` | `BLOCKED`
- Commits (SHAs)
- One-line verification summary (affected tests or scoped static evidence)
- Concerns (if any)

## Verification evidence

Choose evidence from the actual diff, not the file extension. Scope limits → `mstar-harness-core` § 定向执行与验证边界.

- **Executable logic**: report the affected test file(s), exact command/selector and actual output; bug fixes include the reproduction red/green evidence. No `Verification mode` is needed for this test triple.
- **Non-executable documentation or prompt/skill policy**: use `Verification mode: scoped-check` with real scoped static or before/after observable evidence. This mode cannot exempt executable code, configuration logic or executable snippets from corresponding tests. Mixed changes retain executable test evidence and do not claim a scoped-check exemption for the task.

```markdown
Verification mode: scoped-check
Changed files: <actual non-executable files>
Tests: N/A
Reason: <why scoped evidence fits the actual change>
Check command: <exact targeted command actually run>
Check result: <actual exit/result and observed output>
```

`Check result` accepts concrete static-tool output (for example `docs/guide.md:12: scoped rule`); a test-style PASS/exit token is not required. It must be nonempty and non-placeholder. Whether an observation is truthful and sufficient remains PM/QC's responsibility.

For appended fixes, begin each new block with `## Verification round: <concrete label>` (for example `fix 1`). Only the last such round is active; earlier rounds remain history and cannot fill missing fields. A report without round headings is one active block. The active round supplies its complete applicable evidence, including `Verification mode` for scoped checks; executable rounds retain their own test triple without a mode. A blank/placeholder round label is invalid.

Replace every placeholder with actual evidence. Unknown or duplicate modes within the active round, missing/empty/placeholder fields, and bare `Tests: N/A` fail; do not copy the template as a report. `assertSddTddTriple` / `mstar lint <task-report>` validate structure only. PM/QC check the actual changed range, applicability and evidence honesty; the checker cannot establish that commands ran or intercept arbitrary shell execution. For policy changes, record the before/after expectation and triggering scenario alongside the concrete check; no broad model-eval matrix is implied.

## After implementer DONE

PM sets `FEATURE_CWD` from the completed task's immutable Assignment `Worktree path`, verifies its assigned branch, and restores context to that same checkout/branch. Generate the task-specific review package serially from this path; do not use the PM shell cwd for task endpoints. Leaves keep their dispatched inputs unchanged.

1. `HEAD_SHA=$(git -C "$FEATURE_CWD" rev-parse HEAD)`
2. `mstar sdd review-package "$BASE_SHA" "$HEAD_SHA" --context "$SDD_DIR/context.json"` — context `featureCwd` must equal the same `$FEATURE_CWD` used for `HEAD_SHA`; probes git there, writes the diff into the control sddDir, prints absolute paths.
3. Dispatch task reviewer with: brief path, report path, diff path, Global Constraints (verbatim from plan).

**Never use `HEAD~1` as BASE** — multi-commit tasks truncate.

## Bound child launch (CLI-launchable children)

**PM-only serialized launch:** when the implementer is a CLI command rather than a hosted subagent, PM holds the serialized context operation through context validation and child spawn, using the launch Assignment's fixed checkout/branch. Do not rotate context until the launch resolves. Hosted leaves never use this entry for their assigned checks; they run allowed commands directly from their verified assigned feature workdir and branch:

```bash
mstar sdd exec --context "$SDD_DIR/context.json" -- <argv...>
```

- Resolves and re-validates the context (identity/branch/lease/nesting), then spawns the argv directly with cwd = `featureCwd`, `shell: false`, stdio and environment inherited unchanged. Exits: 1 = context/gate refusal (no child started), 2 = usage, 127 = spawn not found, child exit preserved, signal termination 128+n.
- This binds the child's **starting cwd only** — it is not a sandbox. A child that later `chdir`s, passes an overriding cwd flag, writes an absolute path elsewhere, or uses host-native edit tooling (`apply_patch`, native-session edits) is **not blocked**; no arbitrary-shell interception is claimed.

## Native hosted subagents — destination contract

Hosted subagents are not cwd-bound by the launcher, so their dispatch prompt must carry the absolute destination contract (templates: `implementer-prompt.md`, `implementer-continuation-prompt.md`, `task-reviewer-prompt.md`) and their first step is to observe, then write:

1. Observe `pwd` and the checked-out branch in the tool's workdir; both must equal the immutable Assignment `Worktree path` / branch (`featureCwd`/`workingBranch`), never a newly read value from mutable plan context. On mismatch, stop and report — a declared-correct assignment does not make a wrong-checkout write safe.
2. Source edits go through the assigned feature workdir; write the report only to its fixed task-specific path and consume brief/diff artifacts only from the dispatched paths. Do not modify shared context/progress or invoke context-writing workspace/task-brief/review-package helpers; request missing artifacts from PM.

## Fix loop

Fix subagent appends a new `## Verification round: <concrete label>` to the same `task-N-report.md`, followed by the complete affected executable test triple or applicable `scoped-check` block above, with actual output (warnings remain findings). Reuse unaffected evidence, citing its original range and why it remains applicable. Re-dispatch the owning reviewer for the assigned finding/fix delta when the required evidence is present.

The per-task fix loop applies the same fix-round mechanics as plan-level QC fix waves (SKILL.md · "After all tasks" — unverified rounds count, affected finding/fix-delta re-entry, capped cross-round excerpt, honest non-convergence): from round ≥2 the excerpt of prior rounds' findings/dispositions goes into the fix dispatch brief, and the round tally/verification history lands in `$SDD_DIR/progress.md`.

## Progress ledger

On clean task review, PM alone appends to `$SDD_DIR/progress.md`:

```text
Task N: complete (<base>..<head>, review clean)
```

Minor findings: append under `## Minor (for plan QC)` in same file.

## Plan-level QC package

After all tasks, PM generates the package serially from the integrated checkout with its corresponding context:

```bash
MERGE_BASE=$(git merge-base <target-branch> HEAD)
mkdir -p "$SDD_DIR/review"
mstar sdd review-package "$MERGE_BASE" HEAD --context "$SDD_DIR/context.json" "$SDD_DIR/review/branch-review-....diff"
```

Pass **branch** diff path and bundle report paths (`$SDD_DIR/review/qc1.md` …) to QC dispatch — not task-level diffs. Raw QC/QA files stay in the gitignored review bundle; PM records durable summary and open residuals in **local** plan / workflow snapshot + project register (`workflows/<id>/snapshot.json`, `projects/<id>/residuals.json` — session SSOT) and promotes cross-clone decisions into tracked knowledge/specs/`AGENTS.md` per `mstar-conventions` git policy.

## PM context hygiene

Do not paste:

- Full plan text
- Prior task summaries ("state after Tasks 1-3")
- Full diff content

Fresh subagent gets: brief + interfaces + constraints + file paths only.

**Sticky implementer** (task 2+): resume same session; read new brief path + `progress.md` — do not re-paste prior task summaries. PM updates `implementer-session.json`.
