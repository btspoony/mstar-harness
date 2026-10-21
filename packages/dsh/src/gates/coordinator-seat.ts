/**
 * The dsh-side coordinator-seat derivation — the host guard's own instance of
 * the rule `packages/commands/src/coordinator-seat.ts` owns.
 *
 * Why a copy instead of that module's exports: an installed dsh resolves
 * `@mstar-harness/commands` from the published peer (`^4.0.3`, external in the
 * build), and that package is private and never published. A named import that
 * the released peer does not carry fails at ESM instantiation, before `apply`
 * runs, so the boundary may only carry symbols the peer already had:
 * `getCommandDefinitions` and the `CommandDefinition` type. The seat set is
 * therefore derived HERE from the same definitions the CLI server derives it
 * from — one rule, two consumers, not two lists. `tests/leaf-seat.spec.ts`
 * pins this derivation to the commands one over the whole corpus.
 *
 * The rule (identical on both sides): a command is a coordinator-seat command
 * when it establishes or replaces a seat (`plan.bind`, `plan.complete`,
 * `session.recover`, `session.run`) or writes workflow-scope delivery,
 * lifecycle, adoption or coordinator-ledger state — every action of the
 * `workflow` family, plus `status.workflow-close`, `workflow-note.append` and
 * `iteration.register`. Naming the whole family is deliberate: a workflow
 * action added later is refused for a leaf the moment it publishes, instead of
 * waiting for someone to remember this file.
 *
 * The host guard sees only the published MCP tool name (`mstar_<family>`, the
 * fold `packages/cli/src/mcp/fold.ts` publishes with) plus the call's `action`,
 * so both are folded back to a command id here.
 */
import { getCommandDefinitions, type CommandDefinition } from '@mstar-harness/commands'

const SEAT_FAMILIES: readonly string[] = ['workflow']

/** Family → the coordinator-seat actions of an otherwise leaf-reachable family. */
const SEAT_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  plan: ['bind', 'complete'],
  session: ['recover', 'run'],
  status: ['workflow-close'],
  'workflow-note': ['append'],
  iteration: ['register'],
}

/** The family a definition publishes under — its authored CLI path segment. */
function familyOf(definition: CommandDefinition): string {
  return definition.cli.path[0] ?? definition.id.split('.')[0]!
}

/** The action a command id publishes inside its family (`workflow-note.append` → `append`). */
function actionOf(commandId: string): string {
  const dot = commandId.indexOf('.')
  return dot === -1 ? commandId : commandId.slice(dot + 1)
}

function isSeatDefinition(definition: CommandDefinition): boolean {
  const family = familyOf(definition)
  return SEAT_FAMILIES.includes(family) || (SEAT_ACTIONS[family] ?? []).includes(actionOf(definition.id))
}

type SeatIndex = ReadonlyMap<string, ReadonlyMap<string, string>>

let seatIndexCache: SeatIndex | undefined

function seatIndex(): SeatIndex {
  if (seatIndexCache !== undefined) return seatIndexCache
  const index = new Map<string, Map<string, string>>()
  for (const definition of getCommandDefinitions()) {
    if (!isSeatDefinition(definition)) continue
    const tool = `mstar_${familyOf(definition).replace(/[.-]/g, '_')}`
    const byAction = index.get(tool) ?? new Map<string, string>()
    byAction.set(actionOf(definition.id), definition.id)
    index.set(tool, byAction)
  }
  seatIndexCache = index
  return index
}

/**
 * The coordinator-seat command id one folded MCP call selects, or undefined
 * when the call is not one.
 */
export function coordinatorSeatCommandFor(toolName: string, action: unknown): string | undefined {
  if (typeof action !== 'string') return undefined
  return seatIndex().get(toolName)?.get(action)
}
