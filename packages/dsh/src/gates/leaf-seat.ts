/**
 * The shared leaf-seat predicate of the dsh identity chain — the ONE shape
 * every dsh-side enforcement reads (ADR
 * `docs/adr/dsh-native-identity-channels.md`): a known leaf seat
 * (`header.origin === 'subagent'`, or a numeric `delegationDepth > 0`) can
 * never own an execution binding or hold a coordinator session.
 *
 * Consumers:
 * - `scoped-mcp-mount.ts` — a known leaf never gets an identity-bearing child
 *   process (there is no binding it could ever attribute);
 * - `native-commands.ts` — the coordinator-seat-capable native tools
 *   (`mstar_plan_bind`, `mstar_execution_clear`) refuse a leaf seat
 *   fail-closed, before any admission or engine round-trip;
 * - the `tools/pre-execute` boundary below — the folded MCP surface's
 *   coordinator-seat commands refuse a leaf seat before the MCP client child
 *   ever executes, on EVERY connection. The refused set is derived in
 *   `@mstar-harness/commands` (`coordinator-seat.ts`) and consumed by the CLI
 *   server's `--seat leaf` filter too, so the two layers cannot refuse
 *   different actions. The scoped mount's `--seat leaf` launch is defence in
 *   depth for the per-agent connection; the profile-wide `mstar-mcp` row is
 *   generic (no identity, no seat), so the server-side restriction alone never
 *   covered a leaf naming a bound coordinator session there.
 */
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { coordinatorSeatCommandFor } from '@mstar-harness/commands'

export function isLeafSeatHeader(header: unknown): boolean {
  if (typeof header !== 'object' || header === null) return false
  const view = header as { origin?: unknown; delegationDepth?: unknown }
  return view.origin === 'subagent' || (typeof view.delegationDepth === 'number' && view.delegationDepth > 0)
}

/** The named cause every refusal carries (the seam's refusal vocabulary). */
export const LEAF_SEAT_COORDINATOR_CAUSE = 'leaf-seat.coordinator-action'

/**
 * The raw name of the folded mstar tool one model-facing MCP tool name selects,
 * or undefined for any other tool. `@deepseek-ai/dsh-mcp-client` publishes
 * `mcp__<serverName>__<rawName>` (publicToolName, its lib/index.js), and the
 * server name is deployment-owned, so the raw name is what follows the LAST `__`
 * (both the family tool names and its actions are short ASCII identifiers, so
 * the last separator is the raw-name boundary even for a `__`-bearing server
 * name).
 */
function foldedRawName(toolName: string): string | undefined {
  const separator = '__'
  if (!toolName.startsWith('mcp__')) return undefined
  const close = toolName.lastIndexOf(separator)
  if (close < 'mcp__'.length) return undefined
  return toolName.slice(close + separator.length)
}

/** The session header the leaf-seat contract reads (`agent.session.header`). */
function sessionHeaderOf(agent: unknown): unknown {
  return (agent as { session?: { header?: unknown } } | null | undefined)?.session?.header
}

/**
 * The named refusal for a known leaf calling a coordinator-seat command on the
 * folded MCP surface, else undefined. The tool `action` is visible here because
 * the MCP client registers every bridge tool as a normal `ToolDefinition`
 * (`ctx.tools.register`) and `tools/pre-execute` carries the parsed call in
 * `ToolExecution.arguments` — the same field the dispatch gate reads, so the
 * guard runs before the MCP child ever sees the call. The set of refused
 * commands is NOT listed here: `coordinatorSeatCommandFor` derives it from the
 * command layer, which is the same authority the CLI server's leaf seat uses.
 * The recovery names the supported route (run it from the coordinating session)
 * and the actions this seat may run.
 */
export function leafSeatCoordinatorRefusal(exec: Pick<ToolExecution, 'name' | 'arguments' | 'agent'>): string | undefined {
  const rawName = foldedRawName(exec.name)
  if (rawName === undefined) return undefined
  const args = exec.arguments
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const action = (args as { action?: unknown }).action
  const commandId = coordinatorSeatCommandFor(rawName, action)
  if (commandId === undefined) return undefined
  if (!isLeafSeatHeader(sessionHeaderOf(exec.agent))) return undefined
  return (
    `${LEAF_SEAT_COORDINATOR_CAUSE}: ${exec.name} action "${String(action)}" (${commandId}) establishes or exercises a workflow coordinator seat, ` +
    'and this seat is a leaf (session header origin "subagent" or a delegationDepth > 0). ' +
    'Coordinator seats belong to the non-leaf coordinating session: run the operation from that session, ' +
    'or use the actions this seat may run (plan.prepare / plan.progress / plan.show / plan.issue-add / plan.issue-close / issue.* / sdd.* / schema).'
  )
}

/**
 * The `tools/pre-execute` listener: deny WITHOUT calling `next()` (the
 * waterfall short-circuit every refusal on this seam uses), delegate otherwise.
 */
export function leafSeatToolListener(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
  const refusal = leafSeatCoordinatorRefusal(exec)
  return refusal === undefined ? next() : Promise.resolve({ kind: 'deny', reason: refusal })
}
