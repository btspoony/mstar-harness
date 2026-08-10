/**
 * Shared REAL-composition boot for `@mstar-harness/dsh` tests (plan Task 2
 * pattern, extended for the Task 3 status gate): boots a test-only
 * `cordis.yml` through the actual `@cordisjs/plugin-loader`, mounting
 * `@mstar-harness/dsh` with only the module-import seam replaced by a modules
 * map — entry parsing, config validation, fiber mounting, and settlement are
 * the shipping code.
 *
 * Seam boundary: dev-time the dsh seam packages resolve from a real dsh
 * source tree via the link farm (`scripts/setup-dsh-links.ts` → repo-root
 * `node_modules/@deepseek-ai/`), but this suite deliberately drives the fs
 * intent waterfalls with a minimal typed harness — the same `ctx.waterfall`
 * dispatch the real `@deepseek-ai/dsh-tool-fs` write/edit tools perform
 * (`ctx.waterfall('fs/write-intent', target, exec, () => undefined)`).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'
import * as plugin from '../src/index.ts'

/**
 * Bun (JavaScriptCore) compatibility shim for the REAL dsh seam packages.
 *
 * The real packages' lossless-JSON guards (dsh-session `snapshotJsonValue`,
 * dsh-tools schema validation) detect intrinsic prototypes by comparing
 * `Function.prototype.toString` against V8's exact `function Object() { [native code] }`
 * format. JavaScriptCore (Bun) prints native functions with newlines
 * (`function Object() {\n    [native code]\n}`), so under Bun every plain
 * object is rejected as non-intrinsic and tool results/schemas fail
 * materialization. This normalizes the native-code format to the V8 spelling
 * the real packages compare against — test-runtime only (dsh hosts run Node).
 */
{
  const intrinsicToString = Function.prototype.toString
  Function.prototype.toString = function toStringCompat(this: Function): string {
    const rendered = intrinsicToString.call(this)
    return rendered.includes('[native code]')
      ? `function ${this.name || 'anonymous'}() { [native code] }`
      : rendered
  }
}

/** Boot options for {@link bootApp}. */
export interface BootOptions {
  /** `Enforcement` override for the plugin Config (`hard` | `soft`). */
  enforcement?: 'hard' | 'soft'
  /** Delegation tool names the dispatch gate matches (Config `dispatchTools`). */
  dispatchTools?: string[]
  /** The dispatching agent's own harness role (Config `dispatchBinding`). */
  dispatchBinding?: string
  /** Additional skill roots registered with skill-local (Config `skillRoots`). */
  skillRoots?: string[]
  /** Bundled skill root registered with skill-local (Config `bundledSkillDir`). */
  bundledSkillDir?: string
  /** Catalog cache refresh interval in ms (Config `catalogTtlMs`). */
  catalogTtlMs?: number
  /** App root override (default: a fresh temp dir). */
  root?: string
  /**
   * Path to a committed fixture `cordis.yml` to boot INSTEAD of the inline
   * row list (e2e-session.spec full-app composition). The fixture's last row
   * must be the mstar plugin row without a `config:` block — the same
   * boot-time config lines are appended after it (temp harness dir and the
   * options above are session state, not commit-time constants).
   */
  cordisYml?: string
  /**
   * Explicit harness-dir override: a string sets that value, `null` OMITS
   * the config key entirely (the plugin then resolves per session
   * workspace at event time — never from the process cwd — so boot-time
   * gates/catalog are explicit-only), `undefined` (default) uses the
   * temp `root/harness` dir.
   */
  harnessDir?: string | null
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
  // The dsh skill registry row mounts first (real dsh app layout): the
  // `@mstar-harness/dsh` plugin mounts skill-local as a child, which injects
  // the `skills` service.
  const lines = options.cordisYml !== undefined
    // Full-app fixture composition (e2e-session.spec): the committed rows
    // replace the inline list; the boot-time config block below is appended
    // to the fixture's trailing mstar row exactly as for the inline list.
    ? (await readFile(options.cordisYml, 'utf8')).replace(/\s+$/, '').split('\n')
    : [
        "- name: '@deepseek-ai/dsh-skill'",
        // The real dsh-tools ToolRegistry service injects `systemPrompt`
        // (unlike the removed peer-stub), so the system-prompt row mounts
        // before the tool registry row.
        "- name: '@deepseek-ai/dsh-system-prompt'",
        // The tool registry row mounts before the plugin so `ctx.tools` exists
        // when the v2 seams register their model-facing tools (Task 1 of plan
        // 20260808-dsh-seams-bundle; the real dsh app always composes dsh-tools).
        "- name: '@deepseek-ai/dsh-tools'",
        // The command registry row mounts before the plugin so `ctx.commands`
        // exists when the bundled mstar commands register (the real dsh app
        // always composes dsh-commands).
        "- name: '@deepseek-ai/dsh-commands'",
        "- name: '@mstar-harness/dsh'",
      ]
  const configLines: string[] = []
  if (options.harnessDir !== null) {
    configLines.push(`    harnessDir: ${JSON.stringify(options.harnessDir ?? harnessDir)}`)
  }
  if (options.enforcement !== undefined) configLines.push(`    enforcement: ${options.enforcement}`)
  if (options.dispatchTools !== undefined) configLines.push(`    dispatchTools: ${JSON.stringify(options.dispatchTools)}`)
  if (options.dispatchBinding !== undefined) configLines.push(`    dispatchBinding: ${JSON.stringify(options.dispatchBinding)}`)
  if (options.skillRoots !== undefined) configLines.push(`    skillRoots: ${JSON.stringify(options.skillRoots)}`)
  if (options.bundledSkillDir !== undefined) configLines.push(`    bundledSkillDir: ${JSON.stringify(options.bundledSkillDir)}`)
  if (options.catalogTtlMs !== undefined) configLines.push(`    catalogTtlMs: ${options.catalogTtlMs}`)
  if (configLines.length > 0) {
    lines.push('  config:')
    lines.push(...configLines)
  }
  await writeFile(configPath, lines.join('\n') + '\n')

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@mstar-harness/dsh', plugin],
    // The `ctx.skills` registry seam — the REAL package, linked from a local
    // dsh source tree by the link farm (`scripts/setup-dsh-links.ts`); the
    // host app provides it at runtime via peerDependencies.
    ['@deepseek-ai/dsh-skill', await import('@deepseek-ai/dsh-skill')],
    // The `ctx.systemPrompt` service seam the real dsh-tools ToolRegistry
    // injects — the REAL package (link farm).
    ['@deepseek-ai/dsh-system-prompt', await import('@deepseek-ai/dsh-system-prompt')],
    // The `ctx.tools` registry seam — the REAL package (link farm) whose
    // default export provides the ToolRegistry service (the host app provides
    // it at runtime via peerDependencies).
    ['@deepseek-ai/dsh-tools', await import('@deepseek-ai/dsh-tools')],
    // The `ctx.commands` registry seam — the REAL package (link farm) whose
    // named exports provide the CommandService (the host app provides it at
    // runtime via peerDependencies).
    ['@deepseek-ai/dsh-commands', await import('@deepseek-ai/dsh-commands')],
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

/**
 * Canonical value of one `mstar_*_validate` / `mstar_sdd_*` / seam tool
 * result. The dsh-tools seam types the successful `value` as lossless
 * `JsonValue` (includes `null` + primitives), so specs must narrow it to the
 * object contract the tools actually return before property access.
 */
export interface ToolResultValue {
  ok: boolean
  violations: Array<{ code: string; severity?: string; message?: string }>
  secrets?: Array<{ type: string }>
  level?: string
  level_missing?: string[]
  entry?: ToolResultValue
  exit?: ToolResultValue
  sdd_dir?: string
  brief_file?: string
  [key: string]: unknown
}

/** Narrow one successful tool result to its canonical value (throws on failure). */
export function valueOf(result: import('@deepseek-ai/dsh-tools').ToolExecutionResult): ToolResultValue {
  if (result.isError) throw new Error(`tool call failed: ${result.error?.message ?? 'unknown error'}`)
  return result.value as ToolResultValue
}
