# External review-seat channel

The loaded `herdr` skill owns the command surface and lifecycle. The invocations below state the shape this channel uses; when the loaded skill's CLI differs, follow the loaded skill and report the drift rather than following this file.

## When the channel exists

- Require all three legs: this session can load the `herdr` skill; that skill's own `HERDR_ENV=1` probe passes; the detected mstar host maps to a supported agent kind below. Load the skill before running its probe or commands; use only its own guidance for command discovery and lifecycle operations.
- If any leg fails, state which leg failed and use the ordinary in-session review path unchanged. A missing skill is not an error; never discover or run Herdr commands outside the loaded skill's guidance.

## Kind mapping

This table maps the host detected by `mstar-host` to an agent kind; it is not an inventory of available kinds. Confirm kind availability through the loaded skill's agent surface; if unavailable, state the failed kind leg and use the ordinary path. Never guess a kind.

| Detected host | Mapped kind (subject to the loaded skill's agent surface) |
| --- | --- |
| `omp` | `omp` |
| `opencode` | `opencode` |
| `codex` | `codex` |
| `cursor` | `cursor` |
| `kimi` | `kimi` |
| `dsh`, `zcode`, unmapped | None — report "this host has no external review-seat channel" and use the ordinary path. |

## Open the channel

- Follow the loaded skill's layout rules: inspect the caller pane, honor a requested direction, otherwise split right for a wide caller or down for a narrow or tall caller. Default: `herdr pane split --current --direction right --cwd "$PWD" --no-focus`.
- Read the new pane id from the JSON response's `.result.pane.pane_id`; never predict it. Read that pane to confirm the shell is at its interactive prompt, or wait until it is, before starting one agent with a useful unique job name, e.g. `herdr agent start pr-reviewer --kind <mapped-kind> --pane <returned-pane-id>`. An `agent_pane_busy` refusal while the shell is becoming ready is not a channel failure: read the pane, wait for its interactive prompt and retry start once. Wait for agent readiness before prompting.
- Keep one channel session per PR and reuse it across rounds. Never create a workspace, tab, worktree or different cwd unless the user requested that topology. The review session's own review-worktree creation remains part of the ordinary review contract.

## Dispatch a review round

- Send exactly one command entry as one prompt: `/amazing-pr-review pr:<n> [tier]`; append the tier only when the user named one. For example, `herdr agent prompt <agent-name> "/amazing-pr-review pr:<n>" --wait --timeout <timeout-ms>`; an explicit user tier is the command's trailing argument.
- Derive the wait timeout from the resolved tier's wall-clock budget printed by `mstar pr-review budget` (`PR_REVIEW_TIER_BUDGETS`), plus margin, converted to the channel's timeout unit. With no user tier, use the review's own inference ladder to size the wait, not a loop-specific default; do not add that inferred tier to the prompt. Never hand-write a minute count.
- The seat session is an ordinary independent host session: it resolves mstar skills, creates the review worktree, runs seats, synthesizes, posts and archives exactly per `commands/amazing-pr-review.md`. This channel adds no review rule.

## Read the result

- Wait for the channel agent to settle first; `blocked` on an approval/question UI is the recovery case below, not a review verdict. Use `mstar pr-review report-path` to resolve the review directory, then locate this round's **archived report file** there, asking the settled agent for its actual path if needed; the resolver's next available filename is not an existing result. Apply the same round-binding predicate under § Recovery / refusals (**Agent exits or pane is lost mid-round**), including its pre-dispatch baseline, before accepting verdict, tally, `comments:` state or review URL. If binding fails, follow that recovery rule to re-dispatch the round; never accept an older report as this round's result.
- Read pane output only as progress evidence, using the loaded skill's agent read surface. Expect alternate-screen truncation: if output is cut, ask the settled agent to restate the archived report path and read that file directly. Never re-run a review to recover text.

## Round loop obligations

- Per round: read the archived report → for `needs fixes` / `blocked`, apply the loop's existing dispatchability and decision boundaries → dispatch bounded fix Assignments, never implement fixes in the coordinator → implementers commit locally at the existing fix sites → wait for the push gate → push one batch → prompt the same channel agent again after the new head's waves, per the ordinary loop.
- A later round needs no extra prompt wording: the seat session's own § Re-review finds the prior report for the same target. Preserve prior reports and never rewrite history.

## Supervision boundary

- Do not nudge the pane session's seats; they belong to that session, which supervises them itself. Coordinator supervision is only waiting on the channel session and, on overrun, re-reading the report path and declaring elapsed time.
- A timeout does not prove non-delivery. Inspect the channel state and report path through the loaded skill's read surfaces, then continue waiting as appropriate; never re-send the round prompt merely because a wait timed out.

## Recovery / refusals

- **Skill absent:** name the missing skill leg; continue through the ordinary in-session path. Do not require installation to proceed.
- **Probe fails:** name the failed environment-probe leg; continue through the ordinary path without issuing channel commands.
- **No mapped kind:** report "this host has no external review-seat channel"; continue through the ordinary path, never substitute a kind.
- **Agent start fails or reports not-ready:** read the pane, repair its state using the loaded skill's guidance, then retry start once in an available shell. If a not-ready agent already occupies the pane, inspect it and wait for idle rather than starting over it; an approval/question UI takes the next decision boundary below. If startup still fails, report the actual cause and required pane-state repair before retrying this entry. If the pane state cannot be repaired, state why and use the ordinary in-session path.
- **Agent exits or pane is lost mid-round:** record the newest archived report path as the round baseline immediately before prompting the channel. On loss, read the newest archived report and resume from it only when it is this round's output — its `head:` equals the round's resolved head, its verdict is not `incomplete` (a settled run per § Verdict synthesis), and it is the baseline's successor: a higher `report-rN.md` sequence in the same run directory, or a report whose `supersedes:` names the baseline. A baseline that never existed means any report carrying the resolved head and a non-`incomplete` verdict qualifies. Otherwise this round still owes its work: open a fresh channel session under the same layout/cwd rules and re-dispatch the same round. A rewritten history never resumes from a prior report. Loss, unlike a wait timeout, requires a replacement session.
- **Archived report with `comments: failed`:** keep the local report and its error as the recorded outcome under § Local report archive; that is not a review success. Do not advance the verdict transition from it — repair the posting cause and re-dispatch the round.
- **Approval or question dialog:** read the UI and stop for the user's decision; state the actual permission/product question and ask the user to decide it before resuming the channel. Never answer it as a review verdict or treat channel `blocked` as report `blocked`.

## Cleanup

- When the loop ends (`ship it`, user budget or `Blocked`), leave the pane and transcript in place as evidence. Never close a pane you did not create or move the user's focus.
- Delete the review worktree only through the existing review cleanup contract; channel cleanup adds no worktree deletion path.
