/**
 * Shared REAL-composition boot for `@mstar-harness/dsh` tests (plan Task 2
 * pattern, extended for the Task 3 status gate): boots the REAL-composition
 * app by mounting the seam rows directly with `ctx.plugin` in the exact
 * order the dsh app composes them (skill → system-prompt → tools → commands
 * → mstar), applying the plugin Config through the shipping schemastery
 * validation — entry/config semantics and fiber mounting are cordis's own
 * `ctx.plugin` path, with no `@cordisjs/plugin-loader` involved (the plugin
 * bundle carries no bare `cordis` dependency; only `@deepseek-ai/cordis`).
 *
 * Seam boundary: dev-time the dsh seam packages resolve from the npm registry
 * (into repo-root `node_modules/@deepseek-ai/`), but this suite deliberately drives the fs
 * intent waterfalls with a minimal typed harness — the same `ctx.waterfall`
 * dispatch the real `@deepseek-ai/dsh-tool-fs` write/edit tools perform
 * (`ctx.waterfall('fs/write-intent', target, exec, () => undefined)`).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { load as parseYaml } from 'js-yaml'
import type { JobDoneListener, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { Agent } from '@deepseek-ai/dsh-agent'
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

/**
 * Minimal in-memory `jobs` service for the settle-pairing tests (plan
 * `20260811-panel-f4-timeliness` Task 1 — Step 1 seam probe): implements the
 * ONE contract the plugin consumes — `onJobDone(listener)` with the upstream
 * `JobDoneListener` signature `(snapshot, owner)` — and lets the test drive
 * terminal snapshots through {@link fireDone}. Mounted as the
 * `@deepseek-ai/dsh-jobs-fake` module row (`bootApp({ jobsService: 'fake' })`)
 * so the plugin's REAL `ctx.inject(['jobs'])` wiring registers against it —
 * the full Loader → apply → inject → onJobDone composition under test,
 * without the heavy real registry (dsh-jobs-local + dsh-agent + a live
 * registered agent). The upstream snapshot contract (terminal statuses,
 * startedAt/finishedAt) is verified in the spec fixtures against the
 * `@deepseek-ai/dsh-jobs` types.
 */
export class FakeJobRegistry extends Service {
  private listener: JobDoneListener | undefined

  constructor(ctx: Context) {
    super(ctx, 'jobs')
  }

  onJobDone(listener: JobDoneListener): () => void {
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = undefined
    }
  }

  /** Test driver: fire a terminal snapshot through the registered listener. */
  fireDone(snapshot: JobSnapshot, owner?: Agent): void {
    const listener = this.listener
    if (listener !== undefined) void listener(snapshot, owner)
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
  /** Additional skill roots registered with skill-filesystem (Config `skillRoots`). */
  skillRoots?: string[]
  /** Bundled skill root registered with skill-filesystem (Config `bundledSkillDir`). */
  bundledSkillDir?: string
  /** Catalog cache refresh interval in ms (Config `catalogTtlMs`). */
  catalogTtlMs?: number
  /**
   * Mount the {@link FakeJobRegistry} as the `jobs` service (the
   * `@deepseek-ai/dsh-jobs-fake` row + module map) so the plugin's
   * `ctx.inject(['jobs'])` onJobDone wiring registers against it (plan
   * `20260811-panel-f4-timeliness` Task 1 seam probe).
   */
  jobsService?: 'fake'
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
 * Boot a REAL-composition app: mount the seam rows directly with
 * `ctx.plugin` in the dsh app's row order, applying the mstar plugin Config
 * through the shipping schemastery validation. No `@cordisjs/plugin-loader`:
 * the bundle depends only on `@deepseek-ai/cordis`.
 * @param options - config override and root placement.
 * @returns the booted app handle.
 */
export async function bootApp(options: BootOptions = {}): Promise<BootResult> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-mstar-boot-'))
  const harnessDir = join(root, 'harness')
  await mkdir(harnessDir, { recursive: true })

  // The dsh skill registry row mounts first (real dsh app layout): the
  // `@mstar-harness/dsh` plugin mounts skill-filesystem as a child, which injects
  // the `skills` service. The tool/command registry rows mount before the
  // plugin so `ctx.tools` / `ctx.commands` exist when the v2 seams register
  // (the real dsh app always composes them).
  const inlineRows: ReadonlyArray<{ name: string; config?: Record<string, unknown> }> = [
    { name: '@deepseek-ai/dsh-skill' },
    // The real dsh-tools ToolRegistry service injects `systemPrompt`
    // (unlike the removed peer-stub), so the system-prompt row mounts
    // before the tool registry row.
    { name: '@deepseek-ai/dsh-system-prompt' },
    // The tool registry row mounts before the plugin so `ctx.tools` exists
    // when the v2 seams register their model-facing tools (Task 1 of plan
    // 20260808-dsh-seams-bundle; the real dsh app always composes dsh-tools).
    { name: '@deepseek-ai/dsh-tools' },
    // The command registry row mounts before the plugin so `ctx.commands`
    // exists when the bundled mstar commands register (the real dsh app
    // always composes dsh-commands).
    { name: '@deepseek-ai/dsh-commands' },
    // The fake jobs service row (only when requested — plan
    // `20260811-panel-f4-timeliness` Task 1): provides `ctx.jobs` so the
    // plugin's deferred `ctx.inject(['jobs'])` onJobDone wiring fires.
    ...(options.jobsService !== undefined ? [{ name: '@deepseek-ai/dsh-jobs-fake' }] : []),
    // Last row: the mstar plugin (carries the boot-time Config below).
    { name: '@mstar-harness/dsh' },
  ]
  let rows: ReadonlyArray<{ name: string; config?: Record<string, unknown> }> = inlineRows
  if (options.cordisYml !== undefined) {
    // Full-app fixture composition (e2e-session.spec): the committed rows
    // replace the inline list; the boot-time config block is applied to the
    // trailing mstar row exactly as for the inline list.
    const parsed = parseYaml(await readFile(options.cordisYml, 'utf8'))
    if (!Array.isArray(parsed)) throw new Error(`fixture cordis.yml must be a row list: ${options.cordisYml}`)
    rows = parsed.map((row, index) => {
      if (typeof row !== 'object' || row === null || typeof (row as { name?: unknown }).name !== 'string') {
        throw new Error(`fixture row ${index} must declare a string name: ${options.cordisYml}`)
      }
      return { name: (row as { name: string }).name, config: (row as { config?: Record<string, unknown> }).config }
    })
  }

  const config: Record<string, unknown> = {}
  if (options.harnessDir !== null) config.harnessDir = options.harnessDir ?? harnessDir
  if (options.enforcement !== undefined) config.enforcement = options.enforcement
  if (options.dispatchTools !== undefined) config.dispatchTools = options.dispatchTools
  if (options.dispatchBinding !== undefined) config.dispatchBinding = options.dispatchBinding
  if (options.skillRoots !== undefined) config.skillRoots = options.skillRoots
  if (options.bundledSkillDir !== undefined) config.bundledSkillDir = options.bundledSkillDir
  if (options.catalogTtlMs !== undefined) config.catalogTtlMs = options.catalogTtlMs

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  // Module seams, keyed by row name. The seam packages export their plugin
  // function as `default` (CJS-style); the mstar plugin is named-only.
  const modules = new Map<string, unknown>([
    ['@mstar-harness/dsh', plugin],
    // The `ctx.skills` registry seam — the REAL package, installed from the
    // npm registry; the host app provides it at runtime via peerDependencies.
    ['@deepseek-ai/dsh-skill', await import('@deepseek-ai/dsh-skill')],
    // The `ctx.systemPrompt` service seam the real dsh-tools ToolRegistry
    // injects — the REAL package (npm registry).
    ['@deepseek-ai/dsh-system-prompt', await import('@deepseek-ai/dsh-system-prompt')],
    // The `ctx.tools` registry seam — the REAL package (npm registry) whose
    // default export provides the ToolRegistry service (the host app provides
    // it at runtime via peerDependencies).
    ['@deepseek-ai/dsh-tools', await import('@deepseek-ai/dsh-tools')],
    // The `ctx.commands` registry seam — the REAL package (npm registry) whose
    // named exports provide the CommandRuntime (the host app provides it at
    // runtime via peerDependencies).
    ['@deepseek-ai/dsh-commands', await import('@deepseek-ai/dsh-commands')],
    // The fake `jobs` service (plan `20260811-panel-f4-timeliness` Task 1):
    // a `{ default }` module so the seam unwrap resolves the class.
    ...(options.jobsService !== undefined
      ? [['@deepseek-ai/dsh-jobs-fake', { default: FakeJobRegistry }] as const]
      : []),
  ])
  for (const row of rows) {
    const mod = modules.get(row.name)
    if (mod === undefined) throw new Error(`unexpected boot row: ${row.name}`)
    const mountable = (mod as { default?: unknown }).default ?? mod
    // `ctx.plugin` validates a plain config object against the plugin's
    // schemastery `Config` (the same validation the loader applied to rows).
    await ctx.plugin(mountable as Parameters<Context['plugin']>[0], row.name === '@mstar-harness/dsh' && Object.keys(config).length > 0 ? config : undefined)
  }
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
