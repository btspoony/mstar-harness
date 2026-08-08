/**
 * Shared REAL-composition boot for `@mstar-harness/dsh` tests (plan Task 2
 * pattern, extended for the Task 3 status gate): boots a test-only
 * `cordis.yml` through the actual `@cordisjs/plugin-loader`, mounting
 * `@mstar-harness/dsh` with only the module-import seam replaced by a modules
 * map — entry parsing, config validation, fiber mounting, and settlement are
 * the shipping code.
 *
 * Seam limitation (documented in the Task 2 report): at dev time the dsh seam
 * packages are peer-stubs (no runtime implementations), so the fs intent
 * waterfalls are simulated with a minimal typed harness — the same
 * `ctx.waterfall` dispatch the real `@deepseek-ai/dsh-tool-fs` write/edit
 * tools perform (`ctx.waterfall('fs/write-intent', target, exec, () => undefined)`).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'
import * as plugin from '../src/index.ts'

/** Boot options for {@link bootApp}. */
export interface BootOptions {
  /** `Enforcement` override for the plugin Config (`hard` | `soft`). */
  enforcement?: 'hard' | 'soft'
  /** App root override (default: a fresh temp dir). */
  root?: string
}

/** A booted app: context, temp root, resolved harness dir, and disposal. */
export interface BootResult {
  ctx: Context
  root: string
  harnessDir: string
  /** Dispose the app fiber and remove the temp root. */
  dispose(): Promise<void>
}

/** Minimal valid status.json (engine test fixture `status.empty.json` shape). */
export const VALID_STATUS = {
  version: 1,
  updated_at: '2026-08-08',
  plans: [],
  residual_findings: {},
  metadata: {},
}

/** Well-formed JSON that fails the status schema (plans must be an array). */
export const INVALID_STATUS = {
  version: 1,
  updated_at: '2026-08-08',
  plans: 'not-an-array',
  residual_findings: {},
  metadata: {},
}

/**
 * Seed files under the harness dir (the gate reads the on-disk document at
 * intent time, so seeding may happen any time before the intent dispatch).
 * @param harnessDir - the app's resolved `{HARNESS_DIR}`.
 * @param files - relative path → content map (intermediate dirs are created).
 */
export async function seedHarness(harnessDir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(harnessDir, rel)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
}

/**
 * Boot a test-only cordis.yml through the Loader with the plugin mounted.
 * @param options - config override and root placement.
 * @returns the booted app handle.
 */
export async function bootApp(options: BootOptions = {}): Promise<BootResult> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-mstar-loader-'))
  const harnessDir = join(root, 'harness')
  await mkdir(harnessDir, { recursive: true })
  const configPath = join(root, 'cordis.yml')
  const lines = ["- name: '@mstar-harness/dsh'", '  config:', `    harnessDir: ${JSON.stringify(harnessDir)}`]
  if (options.enforcement !== undefined) lines.push(`    enforcement: ${options.enforcement}`)
  await writeFile(configPath, lines.join('\n') + '\n')

  const ctx = new Context()
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
  return {
    ctx,
    root,
    harnessDir,
    async dispose() {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}
