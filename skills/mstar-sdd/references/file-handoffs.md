# File handoffs (Morning Star SDD)

PM and subagents move artifacts as **files**, not pasted text. Pasted content stays in PM context for every later turn.

## Before implementer dispatch

1. `export SDD_DIR=$(skills/mstar-sdd/scripts/sdd-workspace <plan-id>)`
2. `skills/mstar-sdd/scripts/task-brief <plan-file> <N> "$SDD_DIR/task-N-brief.md"`
3. Record `BASE_SHA` (`git rev-parse HEAD` before dispatch).
4. Dispatch implementer with:
   - One line scene-setting (where task fits)
   - Brief path: read first — verbatim requirements
   - Interfaces / decisions brief cannot know
   - Report path: `$SDD_DIR/task-N-report.md`
   - `Model tier` → host-specific model (required)
   - **`SDD implementer session`**: `fresh` (new subagent) or `sticky` (resume — see **`sticky-implementer-session.md`**)

## Implementer report file

Implementer writes full report to `task-N-report.md`. Return to PM only:

- Status: `DONE` | `DONE_WITH_CONCERNS` | `NEEDS_CONTEXT` | `BLOCKED`
- Commits (SHAs)
- One-line test summary
- Concerns (if any)

## After implementer DONE

1. `HEAD_SHA=$(git rev-parse HEAD)`
2. `skills/mstar-sdd/scripts/review-package "$BASE_SHA" "$HEAD_SHA" "$SDD_DIR/review-....diff"`
3. Dispatch task reviewer with: brief path, report path, diff path, Global Constraints (verbatim from plan).

**Never use `HEAD~1` as BASE** — multi-commit tasks truncate.

## Fix loop

Fix subagent appends to same `task-N-report.md` with test evidence:

- Covering test file(s)
- Command run
- Output (pristine — warnings are findings)

Re-dispatch reviewer only when all three are present.

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
skills/mstar-sdd/scripts/review-package "$MERGE_BASE" HEAD "$SDD_DIR/branch-review-....diff"
```

Pass **branch** diff path to QC dispatch — not task-level diffs.

## PM context hygiene

Do not paste:

- Full plan text
- Prior task summaries ("state after Tasks 1-3")
- Full diff content

Fresh subagent gets: brief + interfaces + constraints + file paths only.

**Sticky implementer** (task 2+): resume same session; read new brief path + `progress.md` — do not re-paste prior task summaries. PM updates `implementer-session.json`.
