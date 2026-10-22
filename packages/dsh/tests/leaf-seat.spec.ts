/**
 * The dsh leaf seat derives its coordinator-seat set from the command
 * definitions (`src/gates/coordinator-seat.ts`), NOT from a new export of
 * `@mstar-harness/commands`: an installed dsh resolves that package from the
 * PUBLISHED peer, whose surface predates the seat module, so a named import of
 * a symbol it lacks fails at ESM instantiation before `apply` runs.
 *
 * This suite is the pin between the two consumers of one rule: the commands
 * derivation (`packages/commands/src/coordinator-seat.ts`, the CLI server's
 * `--seat leaf` filter) and the dsh mirror. A seat change made on either side
 * fails here, and the module-graph arm keeps the peer surface honest.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  foldedFamilyToolName,
  getCommandDefinitions,
  isCoordinatorSeatCommand,
} from '@mstar-harness/commands'
import { coordinatorSeatCommandFor } from '../src/gates/coordinator-seat.ts'
import { leafSeatCoordinatorRefusal } from '../src/gates/leaf-seat.ts'

const SRC = join(import.meta.dir, '..', 'src')
const SEAT_SYMBOLS = ['coordinatorSeatCommandFor', 'isCoordinatorSeatCommand'] as const

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((entry) => join(dir, entry))
    .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
}

/** Every name one file imports from the dsh peer `@mstar-harness/commands`. */
function peerImports(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@mstar-harness\/commands'/g)].flatMap((match) =>
    match[1]!
      .split(',')
      .map((entry) => entry.trim().replace(/^type\s+/, ''))
      .filter(Boolean),
  )
}

describe('the dsh coordinator-seat derivation mirrors the commands rule', () => {
  test('agrees with the commands derivation on every published definition', () => {
    let seats = 0
    for (const definition of getCommandDefinitions()) {
      const tool = foldedFamilyToolName(definition.cli.path[0] ?? definition.id.split('.')[0]!)
      const action = definition.id.slice(definition.id.indexOf('.') + 1)
      const expected = isCoordinatorSeatCommand(definition.id) ? definition.id : undefined
      expect(coordinatorSeatCommandFor(tool, action)).toBe(expected)
      if (expected !== undefined) seats += 1
    }
    // The corpus actually carries seats: an empty derivation agreeing with an
    // empty one would prove nothing.
    expect(seats).toBeGreaterThan(0)
  })

  test('answers undefined for an unknown tool and for a non-string action', () => {
    expect(coordinatorSeatCommandFor('mstar_plan', 7)).toBeUndefined()
    expect(coordinatorSeatCommandFor('mstar_nope', 'append')).toBeUndefined()
  })

  test('the seat symbols never reach the dsh module graph through the peer', () => {
    const offenders = sourceFiles(SRC)
      .flatMap((file) => peerImports(file).filter((symbol) => (SEAT_SYMBOLS as readonly string[]).includes(symbol)).map((symbol) => `${file}: ${symbol}`))
    expect(offenders).toEqual([])
  })

  test('the local derivation reads the definitions and nothing else from the peer', () => {
    expect(peerImports(join(SRC, 'gates', 'coordinator-seat.ts')).sort()).toEqual(['CommandDefinition', 'getCommandDefinitions'])
  })
})

/**
 * The published-name parse. `@deepseek-ai/dsh-mcp-client` publishes
 * `mcp__<serverName>__<rawName>`, and the server name is deployment-owned, so
 * the name is matched against the known family tools instead of being split on a
 * separator. The collision form (replaced character or over 64 characters ->
 * `<51-char prefix>_<12 hex of sha256(identity)>`) must not fail OPEN: the shared
 * `mstar-mcp` row carries no `--seat`, so this host boundary is the only layer
 * that refuses a leaf there.
 */
const leafAgent = (): unknown => ({ session: { header: { origin: 'subagent' } } })

function refusalOf(name: string, action: string): string | undefined {
  return leafSeatCoordinatorRefusal({ name, arguments: { action }, agent: leafAgent() })
}

describe('the folded tool name resolves to its family whatever the server name is', () => {
  test('reads the family through a server name that contains the separator', () => {
    for (const [name, action, commandId] of [
      ['mcp__mstar__prod__mstar_plan', 'complete', 'plan.complete'],
      ['mcp__ops__mstar__mstar_workflow', 'evidence', 'workflow.evidence'],
      ['mcp__a__b__c__mstar_session', 'recover', 'session.recover'],
    ]) {
      const refusal = refusalOf(name, action)
      expect([name, refusal?.includes('leaf-seat.coordinator-action'), refusal?.includes(commandId!)]).toEqual([name, true, true])
    }
  })

  test('refuses a seat action whose published name carries the collision suffix', () => {
    // A replaced character keeps the raw name readable: only the suffix is added.
    const normalized = refusalOf('mcp__mstar.prod__mstar_plan_0123456789ab', 'bind')
    expect(normalized).toContain('leaf-seat.coordinator-action')
    expect(normalized).toContain('plan.bind')
    // A truncated name keeps only the HEAD of the family name, so more than one
    // family could be the one this call selected: fail closed instead of guessing.
    const truncated = `${'mcp__'}${'x'.repeat(40)}__msta_0123456789ab`
    const refusal = refusalOf(truncated, 'evidence')
    expect(refusal).toContain('leaf-seat.unattributed-tool')
    expect(refusal).toContain('serverName: mstar')
  })

  test('leaves a name that selects no mstar family, or no seat action, alone', () => {
    for (const [name, action] of [
      ['mcp__github__create_issue', 'run'],
      ['mcp__mstar__mstar_issue', 'add'],
      ['mcp__mstar__mstar_plan', 'show'],
      ['mcp__mstar__mstar_workflow_note', 'coverage'],
    ]) {
      expect([name, refusalOf(name, action)]).toEqual([name, undefined])
    }
  })
})
