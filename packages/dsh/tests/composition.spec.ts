/**
 * REAL-composition tier (plan Task 2, mirrors dsh-private packages/AGENTS.md):
 * boots a test-only `cordis.yml` through the actual `@cordisjs/plugin-loader`
 * (the exact versions dsh-private vendors), mounting `@mstar-harness/dsh`
 * with only the module-import seam replaced by a modules map — entry parsing,
 * config validation, fiber mounting, and settlement are the shipping code.
 *
 * Seam limitation: at dev time the dsh seam packages are peer-stubs (no
 * runtime implementations), so this boot composes the plugin + engine only;
 * Tasks 3–5 extend the same boot with real seam packages when available.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'
import { readHarnessVersion } from '@mstar-harness/engine'
import * as plugin from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Minimal valid status.json (engine test fixture `status.empty.json` shape). */
const VALID_STATUS = {
  version: 1,
  updated_at: '2026-08-08',
  plans: [],
  residual_findings: {},
  metadata: {},
}

/** Well-formed JSON that fails the status schema (plans must be an array). */
const INVALID_STATUS = {
  version: 1,
  updated_at: '2026-08-08',
  plans: 'not-an-array',
  residual_findings: {},
  metadata: {},
}

/**
 * Boot a test-only cordis.yml through the Loader with the plugin mounted.
 * @returns the booted context and the harness dir the plugin resolved.
 */
async function boot(): Promise<{ ctx: Context; harnessDir: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-mstar-loader-'))
  const harnessDir = join(root, 'harness')
  await mkdir(harnessDir, { recursive: true })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@mstar-harness/dsh'",
    '  config:',
    `    harnessDir: ${JSON.stringify(harnessDir)}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@mstar-harness/dsh', plugin],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, harnessDir }
}

describe('@mstar-harness/dsh through a real Loader composition (cordis.yml)', () => {
  it('resolves the configured harness dir and validates a fixture status.json inside the app', async () => {
    const { ctx, harnessDir } = await boot()
    const statusPath = join(harnessDir, 'status.json')
    const badStatusPath = join(harnessDir, 'bad-status.json')
    await writeFile(statusPath, JSON.stringify(VALID_STATUS))
    await writeFile(badStatusPath, JSON.stringify(INVALID_STATUS))

    // resolveHarnessDir returns the configured dir (engine fn through the service).
    expect(ctx.dshMstar.resolveHarnessDir(process.cwd(), { harnessDir })).toBe(harnessDir)

    // Fixture status.json passes validation; the malformed doc is rejected.
    expect(ctx.dshMstar.validateStatus(statusPath).ok).toBe(true)
    const rejected = ctx.dshMstar.validateStatus(badStatusPath)
    expect(rejected.ok).toBe(false)
    expect(rejected.violations.map((v) => v.code)).toContain('status.invalid-plans')
  })

  it('exposes the engine version 2.0.0 through the service and the direct import surface', async () => {
    const { ctx, harnessDir } = await boot()
    const badStatusPath = join(harnessDir, 'bad-status.json')
    await writeFile(badStatusPath, JSON.stringify(INVALID_STATUS))
    expect(ctx.dshMstar.readHarnessVersion()).toBe('2.0.0')
    expect(readHarnessVersion()).toBe('2.0.0')

    // Enforcement overlay: hard + violations → hardBlocked; warn-only otherwise.
    const verdict = ctx.dshMstar.validateStatus(badStatusPath)
    const hard = ctx.dshMstar.applyEnforcement(verdict, { hard: true })
    expect(hard.hardBlocked).toBe(true)
    expect(ctx.dshMstar.applyEnforcement(verdict, { hard: false }).hardBlocked).toBe(false)
  })
})
