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
import { executionContextFor } from '@mstar-harness/engine'
import { coordinatorSeatCommandFor } from '../src/gates/coordinator-seat.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { coordinatorIdentityFor, isLeafSeatHeader, leafSeatCoordinatorRefusal, leafSeatShellEnvOf, LEAF_SEAT_SHELL_ENV_DESCRIPTION, LEAF_SEAT_SHELL_ENV_KEY, registerLeafSeatShellEnv } from '../src/gates/leaf-seat.ts'

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
const leafAgent = (): NonNullable<Parameters<typeof leafSeatCoordinatorRefusal>[0]['agent']> =>
  ({ session: { header: { origin: 'subagent' } } }) as NonNullable<Parameters<typeof leafSeatCoordinatorRefusal>[0]['agent']>

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

/**
 * The engine-side mirror: the shared dsh predicate decides WHEN an adapter must
 * attest `leafSeat: true` on its §3.1 identity, and the engine then refuses the
 * identity itself (`coordination.leaf-seat`) — a leaf cannot reach a coordinator
 * registration even where the ambient identity would satisfy the call.
 */
describe('the engine refuses a leaf-attested identity behind the shared predicate', () => {
  // The SAME builder the production transport calls (`native-commands.ts`
  // adoption path): no hand-built identity in the test.
  const identityOf = (header: unknown) => coordinatorIdentityFor(header, 'session-leaf', 'wf-leaf')

  test('a leaf header attests and the engine conversion refuses coordination.leaf-seat', () => {
    const header = { origin: 'subagent' }
    expect(isLeafSeatHeader(header)).toBe(true)
    expect(() => executionContextFor({ harnessDir: '/tmp/unused-harness' }, identityOf(header))).toThrow(
      'a leaf seat cannot mint or mutate a workflow coordinator registration',
    )
  })

  test('a non-leaf header attests nothing and converts as before', () => {
    const header = { origin: 'team-lead' }
    expect(isLeafSeatHeader(header)).toBe(false)
    expect(() => executionContextFor({ harnessDir: '/tmp/unused-harness' }, identityOf(header))).not.toThrow()
  })
})

/**
 * The attestation itself, asserted on the exported production helper: a leaf
 * header yields `leafSeat: true`, a non-leaf header (and both predicate shapes —
 * a numeric delegationDepth as well as the subagent origin) omits the key, so
 * deleting the attestation from `coordinatorIdentityFor` fails here.
 */
describe('coordinatorIdentityFor attests the leaf fact from the shared predicate', () => {
  test('a leaf header yields leafSeat: true', () => {
    expect(coordinatorIdentityFor({ origin: 'subagent' }, 's1', 'wf-1')).toEqual({
      source: 'host', sessionId: 's1', workflowId: 'wf-1', role: 'coordinator', leafSeat: true,
    })
    expect(coordinatorIdentityFor({ delegationDepth: 2 }, 's1', 'wf-1').leafSeat).toBe(true)
  })

  test('a non-leaf header omits the key entirely', () => {
    const identity = coordinatorIdentityFor({ origin: 'team-lead' }, 's1', 'wf-1')
    expect(Object.hasOwn(identity, 'leafSeat')).toBe(false)
    expect(coordinatorIdentityFor(undefined, 's1', 'wf-1')).not.toHaveProperty('leafSeat')
  })
})

/**
 * The shell-signal contributor (#548): the ONE predicate decides whether the
 * bash tool's managed environment exports `DSH_MSTAR_LEAF_SEAT=1`, which the
 * CLI reads to attest `leafSeat` on the §3.1 identity it hands the engine.
 */
describe('the leaf-seat shell-env contributor', () => {
  const resolveFor = (header: unknown) => leafSeatShellEnvOf({ agent: { session: { header } } })

  test('a leaf header (either shape) exports the marker', () => {
    expect(resolveFor({ origin: 'subagent' })).toEqual({ [LEAF_SEAT_SHELL_ENV_KEY]: '1' })
    expect(resolveFor({ delegationDepth: 2 })).toEqual({ [LEAF_SEAT_SHELL_ENV_KEY]: '1' })
  })

  test('a non-leaf or absent header exports nothing', () => {
    expect(resolveFor({ origin: 'team-lead' })).toEqual({})
    expect(leafSeatShellEnvOf({})).toEqual({})
    expect(leafSeatShellEnvOf({ agent: undefined })).toEqual({})
  })
})

/**
 * The deferred registration is the wiring `index.ts` performs: deleting it (or
 * registering a contributor that stops delegating to the predicate) must fail
 * here. A fake ctx carries the `inject` + `shellEnv.register` spies, so the test
 * asserts the contract the host service sees, not the plugin's internals.
 */
describe('the deferred shell-env registration', () => {
  function registeredContributor() {
    const registrations: Array<{
      name: string
      variables: Record<string, { description: string }>
      resolve(execution: { agent?: unknown }): Record<string, string>
    }> = []
    const injected: string[][] = []
    const ctx = {
      inject(names: string[], callback: (child: unknown) => void) {
        injected.push(names)
        callback({ shellEnv: { register: (contributor: (typeof registrations)[number]) => registrations.push(contributor) } })
      },
    }
    registerLeafSeatShellEnv(ctx)
    return { injected, registrations }
  }

  test('injects shellEnv and registers exactly one contributor declaring the marker key', () => {
    const { injected, registrations } = registeredContributor()
    expect(injected).toEqual([['shellEnv']])
    expect(registrations).toHaveLength(1)
    const contributor = registrations[0]!
    expect(contributor.name).toBe('mstar-leaf-seat')
    expect(Object.keys(contributor.variables)).toEqual([LEAF_SEAT_SHELL_ENV_KEY])
    expect(contributor.variables[LEAF_SEAT_SHELL_ENV_KEY]!.description).toBe(LEAF_SEAT_SHELL_ENV_DESCRIPTION)
  })

  test('its resolve delegates to the shared predicate', () => {
    const contributor = registeredContributor().registrations[0]!
    expect(contributor.resolve({ agent: { session: { header: { origin: 'subagent' } } } })).toEqual({ [LEAF_SEAT_SHELL_ENV_KEY]: '1' })
    expect(contributor.resolve({ agent: { session: { header: { delegationDepth: 1 } } } })).toEqual({ [LEAF_SEAT_SHELL_ENV_KEY]: '1' })
    expect(contributor.resolve({ agent: { session: { header: { origin: 'team-lead' } } } })).toEqual({})
  })
})

/**
 * The wiring pin: `index.ts` must actually call the registration helper inside
 * the deferred `ctx.inject(['shellEnv'], ...)` shape — the same source-scan
 * style the `SEAT_SYMBOLS` checks above use, because the dsh test env cannot
 * load the plugin graph.
 */
describe('the index.ts wiring calls the deferred registration', () => {
  const indexSource = readFileSync(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf8')

  test('index.ts imports registerLeafSeatShellEnv and calls it', () => {
    expect(indexSource).toContain("from './gates/leaf-seat.ts'")
    expect(indexSource).toMatch(/import \{[^}]*registerLeafSeatShellEnv[^}]*\} from '\.\/gates\/leaf-seat\.ts'/)
    expect(indexSource).toContain('registerLeafSeatShellEnv(ctx)')
  })

  test('the call site is the shellEnv deferred injection, not a static import', () => {
    expect(indexSource).not.toMatch(/ctx\.inject\(\['shellEnv'\]/)
    // The helper owns the inject; index.ts only forwards ctx.
    const helperSource = readFileSync(join(import.meta.dir, '..', 'src', 'gates', 'leaf-seat.ts'), 'utf8')
    expect(helperSource).toContain("ctx.inject(['shellEnv']")
  })
})
