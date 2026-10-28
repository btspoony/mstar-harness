/**
 * The shared leaf-seat predicate of the dsh identity chain — the ONE shape
 * every dsh-side enforcement reads (ADR
 * `docs/adr/dsh-native-identity-channels.md`): a known leaf seat
 * (`header.origin === 'subagent'`, or a numeric `delegationDepth > 0`) can
 * never own an execution binding or hold a coordinator session.
 *
 * Consumers:
 * - `native-commands.ts` — the coordinator-seat-capable native tools
 *   (`mstar_plan_bind`, `mstar_execution_clear`) refuse a leaf seat
 *   fail-closed, before any admission or engine round-trip;
 * - the `tools/pre-execute` boundary below — the folded MCP surface's
 *   coordinator-seat commands refuse a leaf seat before the shared MCP client
 *   child ever executes. The refused set comes from this package's own
 *   `coordinator-seat.ts`, which follows the rule — not a new export — that
 *   `packages/commands/src/coordinator-seat.ts` owns for the CLI server's
 *   `--seat leaf` filter, so the two layers refuse the same actions (pinned by
 *   `tests/leaf-seat.spec.ts`). The shared `mstar-mcp` row is one generic
 *   connection for the whole host, so this host-side boundary is what covers a
 *   leaf naming a bound coordinator session there.
 */
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ExecutionIdentity } from '@mstar-harness/engine'
import { coordinatorSeatCommandFor, coordinatorSeatToolNames } from './coordinator-seat.ts'

export function isLeafSeatHeader(header: unknown): boolean {
  if (typeof header !== 'object' || header === null) return false
  const view = header as { origin?: unknown; delegationDepth?: unknown }
  return view.origin === 'subagent' || (typeof view.delegationDepth === 'number' && view.delegationDepth > 0)
}

/**
 * The §3.1 identity tuple the dsh transport hands the engine for one carrying
 * session: the leaf fact is ATTESTED here from the SAME shared predicate, so
 * the engine's `coordination.leaf-seat` receiver stays wired to a real
 * transport. Defense-in-depth only: the surfaces using it refuse a leaf
 * pre-admission first, so the engine refusal fires when another route skips
 * that check — never instead of it.
 */
export function coordinatorIdentityFor(
  header: unknown,
  sessionId: string,
  workflowId: string,
): ExecutionIdentity {
  return {
    source: 'host',
    sessionId,
    workflowId,
    role: 'coordinator',
    ...(isLeafSeatHeader(header) ? { leafSeat: true as const } : {}),
  }
}

/** The named cause every refusal carries (the seam's refusal vocabulary). */
export const LEAF_SEAT_COORDINATOR_CAUSE = 'leaf-seat.coordinator-action'

/**
 * The cause for a seat-shaped call whose published tool name the MCP client
 * normalized or truncated into its collision form: the family cannot be
 * attributed, so the guard refuses instead of letting an unattributable name
 * through.
 */
export const LEAF_SEAT_UNATTRIBUTED_CAUSE = 'leaf-seat.unattributed-tool'

/**
 * The collision suffix `@deepseek-ai/dsh-mcp-client` appends to a folded name it
 * could not publish verbatim (`publicToolName`, its lib/index.js): a character
 * outside `[A-Za-z0-9_-]` or a name over 64 characters makes the client rewrite
 * the joined name and return `<51-char prefix>_<12 hex of sha256(identity)>`.
 */
const COLLISION_SUFFIX = /_[0-9a-f]{12}$/

/**
 * The known family tools one model-facing MCP tool name can select, or an empty
 * list when the name selects none.
 *
 * The published name is `mcp__<serverName>__<rawName>` and the server name is
 * deployment-owned: it may itself contain `__`, and the client's replacement or
 * truncation turns the name into the collision form above. Counting separators
 * therefore cannot recover the raw name — and a name this guard cannot
 * attribute must not pass silently, because the shared `mstar-mcp` row carries
 * no `--seat` to refuse it on the server side. So the name is matched against
 * the KNOWN folded family names instead: exactly when the raw name survived
 * (including a `__`-bearing server name and a normalized-but-untruncated
 * collision form), and by prefix when the client truncated the family name
 * (`mstar_pl` keeps only the head of `mstar_plan`).
 */
function foldedSeatTools(toolName: string): readonly string[] {
  if (!toolName.startsWith('mcp__')) return []
  const plain = toolName.replace(COLLISION_SUFFIX, '')
  const tools = coordinatorSeatToolNames()
  const exact = tools.filter((tool) => plain.endsWith(`__${tool}`))
  if (exact.length > 0) return exact
  // No collision suffix: an unmatched name is another server's tool, not an
  // mstar family.
  if (plain === toolName) return []
  const boundary = plain.lastIndexOf('__')
  if (boundary < 'mcp__'.length) return []
  const head = plain.slice(boundary + 2)
  return head === '' ? [] : tools.filter((tool) => tool.startsWith(head))
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
 * command definitions, following the same rule the CLI server's leaf seat
 * applies.
 * The recovery names the supported route (run it from the coordinating session)
 * and the actions this seat may run.
 */
export function leafSeatCoordinatorRefusal(exec: Pick<ToolExecution, 'name' | 'arguments' | 'agent'>): string | undefined {
  const tools = foldedSeatTools(exec.name)
  if (tools.length === 0) return undefined
  const args = exec.arguments
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const action = (args as { action?: unknown }).action
  const commandId = tools.map((tool) => coordinatorSeatCommandFor(tool, action)).find((id) => id !== undefined)
  if (commandId === undefined) return undefined
  if (!isLeafSeatHeader(sessionHeaderOf(exec.agent))) return undefined
  const leafCause =
    'this seat is a leaf (session header origin "subagent" or a delegationDepth > 0), and coordinator seats belong to the ' +
    'non-leaf coordinating session: run the operation from that session, or use the actions this seat may run ' +
    '(plan.prepare / plan.progress / plan.show / plan.issue-add / plan.issue-close / issue.* / sdd.* / schema).'
  if (tools.length === 1) {
    return (
      `${LEAF_SEAT_COORDINATOR_CAUSE}: ${exec.name} action "${String(action)}" (${commandId}) establishes or exercises a workflow coordinator seat, ` +
      `and ${leafCause}`
    )
  }
  // A truncated name keeps only the head of the family name, so more than one
  // family could be the one this call selected: refuse rather than guess.
  return (
    `${LEAF_SEAT_UNATTRIBUTED_CAUSE}: ${exec.name} action "${String(action)}" is a workflow coordinator action of ${tools.join(' / ')}, ` +
    'and the published tool name was rewritten or truncated by the MCP client (a server name with a replaced character or over 64 ' +
    `characters), so the family it selects cannot be attributed; ${leafCause} ` +
    'A connection whose server name needs neither replacement nor truncation (e.g. `serverName: mstar`) keeps every folded name attributable.'
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
