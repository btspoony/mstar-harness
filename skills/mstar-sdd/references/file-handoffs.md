# File handoffs (Morning Star SDD)

PM and subagents move artifacts as **files**, not pasted text. Pasted content stays in PM context for every later turn.

## Before implementer dispatch

Run the SDD helpers through the engine CLI **`mstar sdd …`** (engine-backed; the former bash scripts are removed — semantics unchanged).

1. `export SDD_DIR=$(mstar sdd workspace <plan-id>)`
   - Iteration L1 (implementer cwd = feature worktree):
     `export MSTAR_CONTROL_ROOT=<control_worktree_path>`
     or `mstar sdd workspace <plan-id> <control_worktree_path>`
     so `{SDD_DIR}` lands on the control harness (default-gitignored plans/status/sdd). Do not create a second SDD tree under the feature checkout.
2. Write the execution context file `$SDD_DIR/context.json` — the absolute destination contract every handoff cites:

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

   All paths absolute; `planFile`/`sddDir` must resolve inside the control harness; `featureCwd` must be the assigned feature worktree on `workingBranch`. The declared control root is authoritative — never re-inferred from the feature cwd.
3. `mstar sdd task-brief <plan-file> <N> --context "$SDD_DIR/context.json"` — bound producer: validates the artifact destination **before** mkdir/write and prints the absolute brief path (`{SDD_DIR}/task-N-brief.md`).
4. Record `BASE_SHA` (`git rev-parse HEAD` before dispatch).
5. Dispatch implementer with:
   - One line scene-setting (where task fits)
   - Absolute brief path: read first — verbatim requirements
   - Interfaces / decisions brief cannot know
   - Absolute report path: `$SDD_DIR/task-N-report.md`
   - Absolute control root, feature cwd, plan and context-file paths (destination contract — see prompt templates)
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

Replace every placeholder with actual evidence. Unknown or duplicate modes, missing/empty/placeholder fields, and bare `Tests: N/A` fail; do not copy the template as a report. `assertSddTddTriple` / `mstar lint <task-report>` validate structure only. PM/QC check the actual changed range, applicability and evidence honesty; the checker cannot establish that commands ran or intercept arbitrary shell execution. For policy changes, record the before/after expectation and triggering scenario alongside the concrete check; no broad model-eval matrix is implied.

## After implementer DONE

1. `HEAD_SHA=$(git rev-parse HEAD)`
2. `mstar sdd review-package "$BASE_SHA" "$HEAD_SHA" --context "$SDD_DIR/context.json"` — bound: probes git in `featureCwd`, writes the diff into the control sddDir, prints absolute paths.
3. Dispatch task reviewer with: brief path, report path, diff path, Global Constraints (verbatim from plan).

**Never use `HEAD~1` as BASE** — multi-commit tasks truncate.

## Bound child launch (CLI-launchable children)

When the implementer is a CLI command rather than a hosted subagent, launch it through the bound argv entry — never raw from a primary/control checkout:

```bash
mstar sdd exec --context "$SDD_DIR/context.json" -- <argv...>
```

- Resolves and re-validates the context (identity/branch/lease/nesting), then spawns the argv directly with cwd = `featureCwd`, `shell: false`, stdio and environment inherited unchanged. Exits: 1 = context/gate refusal (no child started), 2 = usage, 127 = spawn not found, child exit preserved, signal termination 128+n.
- This binds the child's **starting cwd only** — it is not a sandbox. A child that later `chdir`s, passes an overriding cwd flag, writes an absolute path elsewhere, or uses host-native edit tooling (`apply_patch`, native-session edits) is **not blocked**; no arbitrary-shell interception is claimed.

## Native hosted subagents — destination contract

Hosted subagents are not cwd-bound by the launcher, so their dispatch prompt must carry the absolute destination contract (templates: `implementer-prompt.md`, `implementer-continuation-prompt.md`, `task-reviewer-prompt.md`) and their first step is to observe, then write:

1. Observe `pwd` and the checked-out branch in the tool's workdir; both must equal `featureCwd`/`workingBranch`. On mismatch, stop and report — a declared-correct assignment does not make a wrong-checkout write safe.
2. Source edits go through the tool workdir at `featureCwd` (or absolute feature paths); briefs/reports/diffs go only to the absolute control paths from the handoff.

## Fix loop

Fix subagent appends the affected evidence to the same `task-N-report.md`: the executable test triple or applicable `scoped-check` block above, with actual output (warnings remain findings). Reuse unaffected evidence, citing its original range and why it remains applicable. Re-dispatch the owning reviewer for the assigned finding/fix delta when the required evidence is present.

The per-task fix loop applies the same fix-round mechanics as plan-level QC fix waves (SKILL.md · "After all tasks" — unverified rounds count, affected finding/fix-delta re-entry, capped cross-round excerpt, honest non-convergence): from round ≥2 the excerpt of prior rounds' findings/dispositions goes into the fix dispatch brief, and the round tally/verification history lands in `$SDD_DIR/progress.md`.

## Progress ledger

On clean task review, append to `$SDD_DIR/progress.md`:

```text
Task N: complete (<base>..<head>, review clean)
```

Minor findings: append under `## Minor (for plan QC)` in same file.

## Plan-level QC package

After all tasks:

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
