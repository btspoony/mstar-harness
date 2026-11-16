/**
 * The dispatch gate's FIXED vocabulary — the logger label, the tool names the
 * gate matches (with the Agent Teams carrier map), and the advisory payload the
 * gate emits. Declarations only: this module holds no gate logic, which makes it
 * a LEAF every other dispatch module (and the entry, the adapter, the agent-flow
 * ledger and `team-identity`) may import without a cycle.
 *
 * Sibling modules — `dispatch-assignment.ts` (header grammar, shape guard, hard
 * resolution), `dispatch-core.ts` (caller + shared gate core),
 * `dispatch-lease.ts` (lease re-verify), `dispatch-worktree.ts` (L1/L2
 * isolation), `dispatch-workflow.ts` (workflow-gate input),
 * `dispatch-workflow-branch.ts` (the workflow/ralph branch) and
 * `dispatch-listener.ts` (the `tools/pre-execute` listener and the
 * Assignment/Team branches).
 *
 * The carrier map stays declared HERE (not beside the Agent Teams branch that
 * reads it) because `scripts/dsh-contract-lint.ts` resolves its authority at
 * this exact path and fails closed on a missing declaration — moving the map
 * would leave the contract lint with no authority to compare against.
 *
 * Module boundary: no barrel — every importer names the owning module by
 * explicit relative path, and this file re-exports nothing from a sibling.
 */

import type { GateResult } from '@mstar-harness/engine'

/** Logger label for the dispatch gate (dsh logger naming: `<scope>/<subject>`). */
export const DISPATCH_LOGGER = 'mstar/dispatch-gate'

/**
 * Default delegation tool names the dispatch gate matches (tool-subagent
 * default id + its fork sibling — roadmap §9 W-B1: fork dispatches carry the
 * same Assignment-shaped `{ description, prompt }` args and must be gated
 * like `subagent`). Exported SHARED with the agent-flow settle pairing
 * (`registerSettleListener` matches the same tool set) so the default cannot drift between
 * the gate and the settle seam.
 */
export const DEFAULT_DISPATCH_TOOLS = ['subagent', 'subagent_fork'] as const

/**
 * The fixed workflow/ralph tool names the workflow gate matches (plan
 *   — architect-verified): the workflow tool
 * registers under Config-default name `'workflow'` and is RENAMEABLE per
 * instance (`toolName`, `tool-workflow/src/index.ts:41`); `ralph` is a
 * fixed name (`tool-ralph/src/index.ts:413`). A renamed instance is out
 * of reach until its name is configured — the same documented caveat as
 * `DEFAULT_DISPATCH_TOOLS`. The workflow tools are gated by THEIR OWN
 * branch, never by addition to `DEFAULT_DISPATCH_TOOLS` (plan Global
 * Constraint — that list stays `['subagent', 'subagent_fork']`).
 */
export const DEFAULT_WORKFLOW_TOOLS = ['workflow', 'ralph'] as const

/**
 * The fixed dsh Agent Teams tool names the dispatch gate matches, mapped to
 * the argument field that carries the Assignment-shaped text (the
 * `@deepseek-ai/dsh-tool-agent-team` surface: `team_task_create.description`,
 * `team_task_update.description`, `send_message.message`). rc.3 creates a
 * teammate with the ordinary `subagent` / `subagent_fork` tools, so the
 * creation call is gated by the subagent branch (`DEFAULT_DISPATCH_TOOLS`,
 * carrier `prompt`) and is absent from this map; the three keys here are the
 * Team-owned carriers, and none of them is a delegation completion (a board
 * write or an inbox acceptance starts no child of its own).
 *
 * The team tools are gated by THEIR OWN branch, never by addition to
 * `DEFAULT_DISPATCH_TOOLS` (that list stays `['subagent', 'subagent_fork']`).
 * `team_task_update.description` is OPTIONAL upstream — a status-only
 * `claim`/`release`/`complete` update carries no carrier at all — so a
 * missing (or non-string) carrier is no gate decision, exactly like a
 * missing `prompt` on `subagent`. The tools are fixed names, so no Config
 * key is added for them; a RENAMED instance is out of reach until its name
 * is added here — the same documented caveat `DEFAULT_DISPATCH_TOOLS`
 * carries for renamed subagent instances.
 */
export const TEAM_DISPATCH_TOOLS = {
  team_task_create: 'description',
  team_task_update: 'description',
  send_message: 'message',
} as const

/** Tool names the Agent Teams branch owns (keys of {@link TEAM_DISPATCH_TOOLS}). */
export type TeamDispatchTool = keyof typeof TEAM_DISPATCH_TOOLS

/**
 * True when `name` is one of the fixed Agent Teams carriers. `Object.hasOwn`
 * keeps prototype keys (`constructor`, `__proto__`) out of the map read.
 */
export function isTeamDispatchTool(name: string): name is TeamDispatchTool {
  return Object.hasOwn(TEAM_DISPATCH_TOOLS, name)
}

/**
 * Advisory emitted on warn-mode dispatch-gate passes (the * `mstar/status-gate` decision reused for the dispatch gate — dsh's
 * `agent/status` lifecycle event stays untouched). Consumers (later tasks,
 * catalogs) observe this event for model-visible/session-log surfacing.
 */
export interface DispatchGateAdvisory {
  /** The matched delegation tool name. */
  tool: string
  /** The Assignment's declared `Execute as` ('' when missing). */
  role: string
  /** The gate verdict (warn-mode: `hardBlocked` is false). */
  result: GateResult
  /** Whether hard enforcement is on (advisory events are warn-mode by construction). */
  hard: boolean
  /** True when the gate errored internally and degraded to allow (structured degraded advisory). */
  degraded?: boolean
}
