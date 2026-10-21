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
