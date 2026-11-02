# External review-seat channel

Two carriers serve this channel and are interchangeable for it: `herdr-core` (CLI `hc`, persistent terminals) and `herdr` (CLI `herdr`, panes). The skill of whichever carrier this session loaded is the sole authority for its command surface and lifecycle. This file records only the shape the channel needs; discover every command through that carrier's own entry points and follow it on any difference, reporting the drift instead of following this file. Never copy a carrier's manual here, and never mix the two: `hc` commands do not exist under `herdr`, and the pane model does not exist under `hc`.

| Carrier | Discovery entry points | Caller check |
| --- | --- | --- |
| `herdr-core` | its skill, `hc --skill`, `hc <command> --help`, `hc templates`, `hc machine ls`; window layout: `herdr-app --skill` | `$HC_TERMINAL_ID` is set |
| `herdr` | `herdr --skill`, `herdr --help`, then a command group without a subcommand (`herdr agent`, `herdr pane`, `herdr workspace`, …) | `HERDR_ENV=1` |

## When the channel exists

- Require all three legs: this session can load a terminal-agent carrier skill; that skill's own environment check reports an addressable caller (table above); and this host maps to an agent target the loaded carrier can start.
- Load the skill before running its checks or commands. When the environment check fails, follow that skill's own instruction for the case (`herdr` says to stop outside Herdr; `herdr-core` asks once whether to use it); if it stays unavailable, state the failed leg and use the ordinary in-session review path unchanged. A missing skill is not an error; never discover or run a carrier's commands outside its own guidance.

## Agent target mapping

Prefer a ready-made target the loaded carrier exposes (`hc templates` for `herdr-core`; the `--kind` values for `herdr`). The table below is the cross-carrier fallback, not an inventory of what a carrier supports.

| Detected host | Agent target |
| --- | --- |
| `omp` | `omp` |
| `opencode` | `opencode` |
| `codex` | `codex` (`herdr-core`: pass `--no-daemon`) |
| `cursor` | `cursor` / `cursor-agent` (use the value the loaded carrier lists) |
| `kimi` | `kimi` |
| `dsh`, `zcode`, unmapped | None — report "this host has no external review-seat channel" and use the ordinary path. |

Confirm the chosen target is available through the loaded carrier before starting it; if it is not, state the failed target leg and use the ordinary path. Never guess a target name.

## Carrier adapters

These are shapes, not contracts: exact arguments come from the loaded carrier's own help, which wins on any difference.

| Capability | `herdr-core` | `herdr` |
| --- | --- | --- |
| Open a background agent | `hc run --bg --name <job> --cwd "$PWD" <target>` | `herdr pane split --current --direction right --cwd "$PWD" --no-focus`, read the returned pane id, wait for its shell prompt, then `herdr agent start <job> --kind <target> --pane <pane-id>` |
| Wait for readiness | `hc wait <job>` / `hc get <job>` | `agent start` returns ready; `herdr agent get <job>` |
| Send a prompt | `hc send --wait <job> "<prompt>" --timeout <check-in-seconds>` | `herdr agent prompt <job> "<prompt>" --wait --timeout <milliseconds>` |
| Read output | `hc read <job> --lines <n>` | `herdr agent read <job> --lines <n>` |
| Status | `hc get <job>` | `herdr agent get <job>` |
| Lost program | `hc keep` replaces it with a shell; it never reruns the task | recover per the loaded skill; open a fresh pane to retry |
| Cleanup | `hc kill`, then `hc rm` | `herdr pane close <pane-id>` |

## Open the channel

- Follow the loaded skill's delegation rules: one background agent with a unique, useful job name and the caller's cwd. Use the adapter table's open row; read the returned address or pane id, never predict it.
- Put the first round's prompt in the launch when the carrier supports it (`herdr-core`: the task argument to `hc run`; `herdr`: `agent prompt` after `agent start` reports ready). This avoids a send arriving before the agent is ready — `hc` explicitly warns that a send to a booting agent can be dropped, and `herdr` requires an interactive prompt before start. Check the launch result (`first_message.sent` for `hc`); if the first task was not sent, read the terminal before deciding to send it once.
- Keep one channel agent per PR and reuse it across rounds. Do not create spaces, tabs or a different cwd unless the user requested that topology; window layout belongs to the window surface and this channel changes it only when asked. The review session's own review-worktree creation remains part of the ordinary review contract.

## Dispatch a review round

- Immediately before prompting the channel for each round, record the newest archived report path as that round's baseline; if none exists, record its absence.
- Send exactly one command entry as one prompt: `/amazing-pr-review pr:<n> [tier]`; append the tier only when the user named one. Round 1 goes through the launch task where § Open the channel allows it; later rounds use the carrier's send surface.
- Interpret the wait timeout by carrier, never by habit. `herdr-core` `send --wait --timeout` is a check-in interval: a `reason: timeout` return is not failure — wait again (`hc wait <job>`) and never resend the prompt. `herdr` `agent prompt --wait --timeout` is the wait's total bound, so size it from the tier budget; an expired wait does not prove non-delivery — inspect the agent before deciding.
- Derive the elapsed upper bound from the resolved tier's wall-clock budget printed by `mstar pr-review budget` (`PR_REVIEW_TIER_BUDGETS`) plus margin, and declare overrun from elapsed time. Do not hand-write a minute count. With no user tier, use the review's own inference ladder to size the expectation, not a loop-specific default; do not add that inferred tier to the prompt.
- The seat session is an ordinary independent host session: it resolves mstar skills, creates the review worktree, runs seats, synthesizes, posts and archives exactly per `commands/amazing-pr-review.md`. This channel adds no review rule.

## Read the result

- Wait for the channel agent to settle first; `blocked` on an approval/question UI is the recovery case below, not a review verdict. Use `mstar pr-review report-path` to resolve the review directory, then locate this round's **archived report file** there, asking the settled agent for its actual path if needed; the resolver's next available filename is not an existing result. Apply the same round-binding predicate under § Recovery / refusals (**Agent exits or is lost mid-round**), including its pre-dispatch baseline, before accepting verdict, tally, `comments:` state or review URL. If binding fails, follow that recovery rule to re-dispatch the round; never accept an older report as this round's result.
- Read agent output only as progress evidence, through the loaded carrier's read surface. Expect alternate-screen truncation: if output is cut, ask the settled agent to restate the archived report path and read that file directly. Never re-run a review to recover text.

## Round loop obligations

- Per round: read the archived report → for `needs fixes` / `blocked`, apply the loop's existing dispatchability and decision boundaries → dispatch bounded fix Assignments, never implement fixes in the coordinator → implementers commit locally at the existing fix sites → wait for the push gate → push one batch → prompt the same channel agent again after the new head's waves, per the ordinary loop.
- A later round needs no extra prompt wording: the seat session's own § Re-review finds the prior report for the same target. Preserve prior reports and never rewrite history.

## Supervision boundary

- Do not nudge the channel session's seats; they belong to that session, which supervises them itself. Coordinator supervision is only waiting on the channel session and, on overrun, re-reading the report path and declaring elapsed time.
- A timeout does not prove non-delivery. Inspect the channel state and report path through the loaded carrier's read surfaces, then continue waiting as appropriate; never re-send the round prompt merely because a wait timed out.

## Recovery / refusals

- **Skill absent:** name the missing skill leg; continue through the ordinary in-session path. Do not require installation to proceed.
- **Environment check fails:** follow the loaded skill's own instruction for the case (`herdr`: stop outside Herdr; `herdr-core`: ask the user once whether to use it); if it stays unavailable, name the failed environment leg and continue through the ordinary path without issuing channel commands.
- **No mapped target:** report "this host has no external review-seat channel"; continue through the ordinary path, never substitute a target.
- **Start fails or reports not-ready:** read the agent through the loaded carrier's read surface, repair its state using that skill's guidance (a name collision, a trust dialog, a pane that is not at its shell prompt), then retry start once. If a not-ready agent already occupies the terminal/pane, inspect it and wait for readiness rather than starting over it; an approval/question UI takes the next decision boundary below. If startup still fails, report the actual cause and required repair before retrying this entry. If the state cannot be repaired, state why and use the ordinary in-session path.
- **Agent exits or is lost mid-round:** use the round baseline recorded under § Dispatch a review round. On loss, read the newest archived report and resume from it only when it is this round's output — its `head:` equals the round's resolved head, its verdict is not `incomplete` (a settled run per § Verdict synthesis), and it is the baseline's successor: a higher `report-rN.md` sequence in the same run directory, or a report whose `supersedes:` names the baseline. A baseline that never existed means any report carrying the resolved head and a non-`incomplete` verdict qualifies. Otherwise this round still owes its work: open a fresh channel agent under the same layout/cwd rules and re-dispatch the same round. A carrier's keep/recovery surface replaces a lost program without rerunning the task, and a rewritten history never resumes from a partial report.
- **Archived report with `comments: failed`:** keep the local report and its error as the recorded outcome under § Local report archive; that is not a review success. Do not advance the verdict transition from it — repair the posting cause and re-dispatch the round.
- **Approval or question dialog:** read the UI through the loaded carrier's read surface and stop for the user's decision; state the actual permission/product question and ask the user to decide it before resuming the channel. A blocked agent refuses a prompt/send unless forced — never force it to bypass a permission decision, and never answer it as a review verdict or treat channel `blocked` as report `blocked`.

## Cleanup

- When the loop ends (`ship it`, user budget or `Blocked`), leave the agent and its transcript in place as evidence. Never close a pane or remove a terminal you did not create, and never stop or restart a shared carrier service. Remove your own channel agent only when the user asks for cleanup.
- Delete the review worktree only through the existing review cleanup contract; channel cleanup adds no worktree deletion path.
