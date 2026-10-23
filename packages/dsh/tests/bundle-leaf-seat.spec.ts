/**
 * Packed-artifact leaf-seat refusal smoke — the SHIPPED bundle shape, not the
 * source tree.
 *
 * The dsh build inlines `@mstar-harness/commands` (its seat derivation) and
 * leaves only the six `@deepseek-ai/*` seam packages plus
 * `@mstar-harness/engine` external (`packages/dsh/package.json` build script).
 * This suite proves the consequence for an isolated consumer: after `npm pack`
 * into a scratch root whose `node_modules` deliberately cannot resolve the
 * workspace-private `@mstar-harness/commands`, the packed entry still applies
 * its `tools/pre-execute` listener and still refuses a folded MCP
 * coordinator-seat call from a known leaf seat.
 *
 * Loading the packed artifact is the point of this test, so the module-loading
 * boundary uses a runtime-chosen specifier (temp dir) rather than a static
 * import.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'

const ROOT = join(import.meta.dir, '..')
/** The packed entry the source build produced (`package.json` `main`). */
const PACKED_ENTRY = join('dist', 'index.js')

/**
 * The build's external bare imports. `@mstar-harness/commands` is NOT here: it
 * is inlined at build time, and the scratch consumer therefore must not
 * provide it — that absence is the premise this smoke discharges.
 */
const EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-tools',
  '@mstar-harness/engine',
] as const

/** The folded plan tool as the shipped bundle's `mstar` server publishes it. */
const PLAN_TOOL = 'mcp__mstar__mstar_plan'

const scratchDirs: string[] = []

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

/**
 * `npm pack` this package, unpack the tarball into a disposable consumer root
 * as `node_modules/@mstar-harness/dsh`, and link only the build externals from
 * the workspace store. Returns the extracted package root.
 */
function packedPackageRoot(): string {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-packed-leaf-seat-'))
  scratchDirs.push(scratch)
  const report = execFileSync('npm', ['pack', '--json', '--pack-destination', scratch], { cwd: ROOT, encoding: 'utf8' })
  const tarball = join(scratch, JSON.parse(report)[0].filename)
  const consumerRoot = join(scratch, 'consumer')
  const packageRoot = join(consumerRoot, 'node_modules', '@mstar-harness', 'dsh')
  mkdirSync(join(consumerRoot, 'node_modules', '@mstar-harness'), { recursive: true })
  execFileSync('tar', ['-xzf', tarball, '-C', consumerRoot])
  renameSync(join(consumerRoot, 'package'), packageRoot)
  for (const name of EXTERNALS) {
    const link = join(consumerRoot, 'node_modules', name)
    mkdirSync(join(link, '..'), { recursive: true })
    symlinkSync(join(ROOT, 'node_modules', name), link, 'dir')
  }
  return packageRoot
}

/** One pending folded MCP call in the registry pipeline shape (dsh-tools 9451be2). */
function foldedCall(action: string, header: Record<string, unknown>): ToolExecution {
  return {
    callId: `packed-${action}` as ToolExecution['callId'],
    name: PLAN_TOOL,
    arguments: { action },
    agent: { id: 'packed-leaf', session: { header } },
    signal: new AbortController().signal,
    token: Symbol('dsh.tool.execution') as unknown as ToolExecutionToken,
  } as unknown as ToolExecution
}

/** The registry's bare default decision (the waterfall's terminal `next()`). */
const defaultAllow = (): Promise<PreToolDecision> => Promise.resolve<PreToolDecision>({ kind: 'allow' })

describe('packed dsh artifact — leaf-seat refusal without the private commands package', () => {
  test('the isolated consumer cannot resolve @mstar-harness/commands, yet the packed gate still refuses a leaf seat', async () => {
    expect(existsSync(join(ROOT, PACKED_ENTRY)), `missing ${PACKED_ENTRY} — run \`bun run --cwd packages/dsh build\` first`).toBe(true)
    const packageRoot = packedPackageRoot()

    // (a) The premise: no private-commands module resolution from the packed root.
    expect(() => Bun.resolveSync('@mstar-harness/commands', packageRoot)).toThrow()
    expect(existsSync(join(packageRoot, 'node_modules', '@mstar-harness', 'commands'))).toBe(false)

    // (b) Load the SHIPPED entry from the scratch consumer root.
    // Runtime-chosen specifier: the packed path only exists after `npm pack`.
    const packed = await import(pathToFileURL(join(packageRoot, PACKED_ENTRY)).href)
    expect(typeof packed.apply).toBe('function')

    // (c) Compose the packed plugin on a bare cordis context. `ctx.plugin` would
    // defer apply behind the host `loader` service (`inject: ['loader']`), which
    // this isolated consumer does not mount; the gate under test is registered
    // synchronously by apply itself.
    const ctx = new Context()
    try {
      packed.apply(ctx, {})

      // (d) Both leaf-seat shapes are refused with the seat cause, and the
      // refusal names the command that belongs to the coordinating session.
      for (const header of [{ origin: 'subagent' }, { delegationDepth: 1 }]) {
        const decision = await ctx.waterfall('tools/pre-execute', foldedCall('complete', header), defaultAllow)
        if (decision.kind !== 'deny') throw new Error(`expected a leaf-seat denial, got ${decision.kind}`)
        expect(decision.reason).toContain('leaf-seat.coordinator-action')
        expect(decision.reason).toContain('plan.complete')
      }

      // (e) The same packed gate allows the coordinating session on the same
      // generic tool — the refusal is seat-scoped, not a blanket deny.
      const allowed = await ctx.waterfall('tools/pre-execute', foldedCall('complete', { origin: 'user' }), defaultAllow)
      expect(allowed).toEqual({ kind: 'allow' })
    } finally {
      await ctx.fiber.dispose()
    }
  }, 120_000)
})
