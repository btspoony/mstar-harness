# Devin host adapter

Load when **mstar-host** detects Devin. Entry is **/morning-star-harness:pm**; load **mstar-harness-core** → **mstar-host** → **mstar-roles** and the active role reference.

## Native installation and detection

- Web: **Customize > Plugins**, add **btspoony/mstar-harness**. CLI: `devin plugins install btspoony/mstar-harness`. There is no `init --target devin`.
- Manifest: `.devin-plugin/plugin.json` at the repository root; skills mount from `./skills/`. MCP is delivered by its inline `mcpServers` map launching `npx @mstar-harness/cli mcp`.
- Detect `run_subagent` / `read_subagent`, `message_user`, or `devin_*` tools before generic namespace signals. Plugin markers on disk are not detection evidence.
- Root AGENTS.md applies only when maintaining this harness repository, not the consumer project.

## SubAgent mapping

### CLI / Desktop

Shared `agents/*.md` shells load as **morning-star-harness:<role>** custom subagents. Dispatch with **run_subagent** selecting that profile and a full Assignment naming **role_id**; load **mstar-harness-core** → **mstar-roles** → the role reference.

Parallel **N** seats = **N background subagents**; collect each with **read_subagent**. QC tri-review uses three independent role profiles (`qc-specialist`, `qc-specialist-2`, `qc-specialist-3`). Follow **parallel-dispatch.md** for Assignment and scheduling rules.

### Cloud

Plugin subagents do **not** load in cloud sessions. The PM seat is the session the user talks to, preferably a **Devin Bot** for persistent identity, a tasks board and Inbox owner approvals. Inbox approval requests map to **owner-gated** merge authorization: only the owner's explicit approval authorizes the merge, not ticket status or a child report. Per-role Bots are optional for long-lived seats.

Each role dispatch is a **board ticket dispatched to a child Devin session** through the available `devin_ticket_manage` / `devin_session_create` capabilities. Inspect the available tool schema rather than inventing arguments. Its brief names **role_id**, carries the full Assignment, and directs loading **mstar-harness-core** → **mstar-roles** → the role reference. QC tri-review = **three parallel child sessions**, not three passes in one session.

**Isolation constraint:** each child runs on its own VM. Gitignored **{HARNESS_DIR}** (`.mstar/`, `store.db`) is **not shared**. Only the PM writes store/workflow state. Pass the required plan context and inputs in the brief; never instruct a child to open the PM's local store. Write-capable children use their own feature branch and return a pushed branch/PR. Read-only seats (QC) review a **pushed ref** without modifying that feature branch.

**Seat-authored artifact transfer:** every cloud child (QC, task reviewer, implementer) writes each Assignment-named output file itself, retaining the destination basename (including `task-N-review.md`). The Assignment specifies a fixed tracked transport path, e.g. `handoff/<basename>`, on a pushed **handoff-only ref** such as `mstar-handoff/<plan-id>/<seat>`. This ref never merges; write-capable seats put report commits on a separate handoff branch, not their feature branch. Read-only seats may write/push these report artifacts only, not product changes. The final report identifies the handoff ref, file path and exact commit SHA for every output.

The PM fetches that ref, verifies its reported SHA, and copies each seat-authored file **byte-for-byte** into its Assignment path under the PM control root, e.g. `git fetch origin <handoff-ref>` then `git show <sha>:handoff/<basename> > "<Assignment path>"`. This is file import, **not coordinator transcription**: PM must not edit the report. After successful import, PM deletes the remote handoff ref (`git push origin --delete <handoff-ref>`); any correction requires a fresh seat-authored handoff. Ordinary public operations then ingest the evidence into PM-owned workflow state.

If a seat cannot push its named output files, dispatch is **not complete**: re-dispatch with push access or fall back to CLI/Desktop subagents. A conversation-only report is never accepted for a plan row.

A child completion notification is the subagent settle event: run the **result-settled** rescheduling checkpoint, re-evaluate all ready independent work, then dispatch before waiting. Do not turn one completion into a one-dispatch limit.

If delegation is unavailable, report the missing capability and ask the operator to enable child-session/board access or continue in CLI/Desktop with custom subagents; an Assignment pasted into chat is not dispatch.

## Tools, plan mode and approvals

- **exec**: shell, git and scoped checks; **edit**: mutations; **read**, **grep**, **glob**: inspection.
- Cloud **message_user**: clarify material choices and request owner decisions. Respect the host's approval and Bot Inbox interfaces.
- No harness-specific native Plan-mode bridge is declared. Session plans/todos remain UX projections; authored plans and PM-owned store state remain authoritative. Planning is not implementation or merge permission.
- Do not assume another host's tool names or permissions.

## Skill root and entry

Prefer skill name loading via the plugin; invoke skills as **/morning-star-harness:<skill>**. Resolve fallback `./skills/<name>/` relative to the **installed plugin root**, never the consumer working directory. There is no documented plugin-root environment variable. Slash commands in `commands/` are not a documented Devin plugin surface; use the PM skill and request workflow actions in the session.

## Host hooks

All four anchors (`direction-lock`, `phase-1-lock`, `phase-2-entry`, `rescheduling-checkpoint`) are **no-op** for host-specific actions. Shared gates and checkpoints still run. No Devin hooks ship: this repository's `hooks/hooks.json` is not root `hooks.json`, and there is no documented plugin-root variable for safe hook paths; do not copy or enable another host's fail-open hooks.
