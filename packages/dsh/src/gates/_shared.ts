/**
 * Shared plugin contract pieces for the dsh gates (`src/gates/*`).
 *
 * Cross-module shared state for the gate modules and the entry: the plugin
 * configuration contract (`Config` interface + schemastery schema), the
 * per-workspace `{HARNESS_DIR}` resolver (+ session helpers), the shared
 * violation/record helpers, the seam hard-enforcement resolution, the
 * packaged skills-dir resolution, the skill-local registration payload,
 * the iteration-gate view mapping (shared by the catalog and the tools),
 * and the canonical status file name.
 *
 * Module boundary (plan `20260810-dsh-entry-split`): gates import from this
 * module by explicit relative path (no barrel); the entry re-exports the
 * public names verbatim — consumers import through `src/index.ts`.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from 'schemastery'
import { resolveCompassEnforcement, resolveHarnessDir } from '@mstar-harness/engine'
import type { GateResult, ValidationResult } from '@mstar-harness/engine'
import type { Config as SkillLocalConfig } from '@deepseek-ai/dsh-skill-local'
import type { IterationGateListView, IterationGateViolationView } from '../types.ts'
/** Canonical harness status file name (mstar-plan-artifacts status.json). */
export const STATUS_FILE = 'status.json'
/** Plugin configuration. */
export interface Config {
  /**
   * Explicit harness root. When set, wins over engine probing (plan-conventions
   * `{HARNESS_DIR}` resolution order); when absent the plugin probes from
   * the SESSION workspace root (`agent.session.header.cwd`) — never the
   * process cwd — walking `.mstar/` → `.agents/` → `.plans/`/`plans/`.
   * Required for repos whose harness root is not a probed name (e.g. a
   * `.harness/` maintenance root).
   */
  harnessDir?: string
  /**
   * Per-deployment enforcement override. `hard` forces
   * hard gates, `soft` forces warn-only even when an active iteration compass
   * declares `enforcement: hard` (local rollback); absent → the compass
   * frontmatter decides, warn-only when no compass hardens (never a global default).
   */
  enforcement?: 'hard' | 'soft'
  /**
   * Model-facing delegation tool name(s) the dispatch gate matches. The dsh
   * subagent tool registers as `subagent` by default, but its `toolName`
   * config may rename instances (tool-subagent README: each instance needs a
   * distinct name), so the match list is deployment-settable. Defaults to
   * `['subagent']`.
   */
  dispatchTools?: string[]
  /**
   * The dispatching agent's own harness role/type (e.g. `fullstack-dev`), used
   * as the anti-recursion binding: an Assignment whose `Execute as` equals this
   * role is a self-dispatch (critical violation — leaf executors must not
   * re-invoke their own role). dsh exposes no agent role on the tool-execution
   * context, so the deployment declares it. Absent → the anti-recursion
   * precheck is skipped (an empty binding is not self-recursion).
   */
  dispatchBinding?: string
  /**
   * Additional skill roots registered with the dsh skill-local provider
   * (skill-local `Config.customSkillDirs` semantics — scanned after project
   * roots and before user roots — single canonical mount).
   * Dev-time: the mirror `<repo-root>/skills` absolute path. Each root's
   * children are skill dirs (`<name>/SKILL.md`) or flat skill files
   * (`<name>.md`). Absent → no custom-root registration.
   */
  skillRoots?: string[]
  /**
   * Bundled skill root registered with the dsh skill-local provider
   * (skill-local `Config.bundledSkillDir` semantics — scanned last, trusted).
   * Production: a `skills/` dir shipped inside the plugin package (the
   * canonical published form — dsh defaults `$DSH_BUNDLED_SKILL_DIR` when
   * default roots are included; this plugin mounts an isolated provider, so
   * the bundled root is registered explicitly). Absent → no bundled-root
   * registration.
   */
  bundledSkillDir?: string
  /**
   * Catalog refresh interval in milliseconds — how often the per-workspace
   * pre-step catalog cache (engine-status watermark, iteration-gate row,
   * harness-state row) re-reads status.json / the compass / the knowledge
   * index. Default 60000: a mid-session plan/compass/residual change lands
   * within one TTL (the hot path stays a timestamp compare + cache hit
   * between refreshes; a bounded sync re-read per workspace at most once
   * per interval). Absent → 60000.
   */
  catalogTtlMs?: number
}

/** Schemastery configuration schema for the plugin consumer. Object keys are optional by default (`.optional()` is a vendored-fork addition not present in npm schemastery); omitted ARRAY keys would materialize as `[]` (schemastery empty-value default — the tool-subagent `toolFilter` pitfall), so both dispatch keys preserve omission via `.default(undefined)`. */
export const Config: z<Config> = z.object({
  harnessDir: z.string(),
  enforcement: z.union(['hard', 'soft']),
  dispatchTools: z.array(z.string()).default(undefined as unknown as string[]),
  dispatchBinding: z.string().default(undefined as unknown as string),
  skillRoots: z.array(z.string()).default(undefined as unknown as string[]),
  bundledSkillDir: z.string().default(undefined as unknown as string),
  catalogTtlMs: z.number().default(undefined as unknown as number),
})
/** One violation line for logs and the typed veto message. */
export function formatViolation(violation: ValidationResult): string {
  return `[${violation.severity}] ${violation.code}: ${violation.message}${violation.fix !== undefined ? ` (fix: ${violation.fix})` : ''}`
}

/** Narrow an unknown value to a record. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
/**
 * Resolve the hard-enforcement flag for the artifact gates: explicit
 * Config override wins, else the iteration compass frontmatter (when a
 * harness dir resolves), else warn-only. {@link resolveHard} parity with a
 * null-tolerant harness dir — the skill roots and the artifact
 * seams (design-md / audit / compound / roles) do not require
 * `{HARNESS_DIR}` (compound scoping is the only seam that does, and only
 * for its knowledge-path matcher).
 */
export function resolveSeamHard(harnessDir: string | null, config: Config): boolean {
  if (config.enforcement === 'hard') return true
  if (config.enforcement === 'soft') return false
  return harnessDir !== null && resolveCompassEnforcement(harnessDir).hard
}
/**
 * Resolve the plugin package's own `harness-skills/` mirror (synced from the
 * repo root by `bundle-assets` at build/postinstall; gitignored), anchored at
 * the file URL of one module in the package. Pure — the caller passes its own
 * module URL string, so the dual-depth resolution is directly unit-testable
 * at either layout depth without touching `import.meta`. Resolved
 * package-relative — NOT cwd-anchored — so the shipped bundled mount works
 * from any launch cwd (this resolves the cwd-anchoring limitation for the
 * default; an explicit `bundledSkillDir` still wins). Returns undefined when
 * the mirror is absent (e.g. a checkout where `bundle-assets` has not run —
 * the default mount is then inert).
 *
 * Dual-depth probe semantics: the module moved from `src/index.ts` (one level
 * below the package root) into `src/gates/_shared.ts` (two levels below in
 * the source layout, but still inlined one level below in the bundled
 * `dist/index.js`). Probe both depths — same dual-depth pattern as
 * `pluginVersion()` — so the mirror resolves identically from source and from
 * the bundle (behavior-preserving move; the dist path is the original one):
 * - `'../harness-skills'` — dist 布局候选（`dist/index.js` 深度）：shipped
 *   form（`package.json` `main: ./dist/index.js`），第一候选直接命中；
 * - `'../../harness-skills'` — 源码布局候选（`src/gates/` 深度）：dev-time
 *   form；该深度下第一候选解析到 `src/harness-skills`——非规范路径——落空后
 *   命中本候选（规范 `packages/dsh/harness-skills`）。
 * `src/harness-skills` 非规范（镜像仅由 `bundle-assets` 生成到规范位置）；
 * 若同名目录意外出现（陈旧镜像），shallow-first 既定——dist 布局命中优先于
 * 源码布局，与 `pluginVersion()` 探测顺序一致（源/dist 不分叉）。
 *
 * @param fileUrl - the module's `import.meta.url` string (or any file URL at
 * the depth whose layout should be probed).
 */
export function resolvePackagedSkillsDir(fileUrl: string): string | undefined {
  for (const rel of ['../harness-skills', '../../harness-skills'] as const) {
    try {
      const dir = fileURLToPath(new URL(rel, fileUrl))
      if (existsSync(dir)) return dir
    } catch {
      // no mirror at this depth — try the next
    }
  }
  return undefined
}

/**
 * Memoized thin wrapper over {@link resolvePackagedSkillsDir}. The mirror
 * path is immutable in-process (generated by `bundle-assets` at
 * build/postinstall), so the first resolution is cached and the agent-loop
 * hot path (`skillRootsOf` per fs/write-intent event, before SKILL.md target
 * filtering) does one lookup instead of repeated `existsSync` probes. Only a
 * RESOLVED value is memoized: an absent mirror is re-probed on later calls so
 * a mirror synced mid-process (e.g. a test that runs `bundle-assets` after
 * module load) is still picked up — production always resolves before the
 * first call, so not caching undefined costs nothing at runtime (and avoids
 * freezing the inert state for the rest of the process).
 */
let packagedSkillsDirMemo: string | undefined
export function packagedSkillsDir(): string | undefined {
  if (packagedSkillsDirMemo !== undefined) return packagedSkillsDirMemo
  const dir = resolvePackagedSkillsDir(import.meta.url)
  if (dir !== undefined) packagedSkillsDirMemo = dir
  return dir
}
/**
 * Per-workspace `{HARNESS_DIR}` resolution for the plugin.
 *
 * The probe NEVER starts from the process cwd — it starts from the WORKSPACE
 * root of the session whose agent drives the event (the session cwd,
 * `agent.session.header.cwd` — the dsh workspace the user opened) AND stops
 * there: `workspaceRoot = 探测起点` (roadmap §7c), so the walk-up never
 * leaves the session workspace (the `~/.mstar` global-collision defect is
 * the special case) and the dsh boundary deliberately diverges from the
 * CLI's git-top-level boundary. An
 * explicit `harnessDir` config still wins outright (resolved once at boot;
 * a relative value is launch-cwd anchored — config path anchoring, not
 * probing — matching the `bundledSkillDir` precedent and the engine's
 * `resolve(startDir, explicit)` semantics). Probing results are memoized
 * per workspace root, so the agent-loop hot path does one Map lookup after
 * the first event of each workspace.
 *
 * An event without a session workspace (no agent / no header cwd) resolves
 * to the explicit config or `null` — never a process-cwd probe: without a
 * workspace there is nothing to probe FROM.
 */
export class HarnessResolver {
  private readonly explicit: string | null
  private readonly cache = new Map<string, string | null>()

  constructor(explicit: string | undefined) {
    this.explicit = explicit !== undefined && explicit.trim() !== ''
      ? resolve(process.cwd(), explicit)
      : null
  }

  /**
   * Resolve for one workspace root (the session cwd).
   * @param cwd - the workspace root; `undefined` when the event carries no session.
   * @returns the resolved `{HARNESS_DIR}` (explicit override, else the probe
   * from the workspace root), or `null` when none resolves.
   *
   * Boundary (roadmap §7c): the probe stops AT the workspace root —
   * `workspaceRoot = 探测起点` (the session cwd itself), so it never walks up
   * beyond the session workspace (the `~/.mstar` global-collision special
   * case), and it does NOT inherit the engine's default git-top-level
   * boundary (the CLI surface). An empty/missing `cwd` keeps the current
   * contract: `null`, never a process-cwd probe.
   */
  forWorkspace(cwd: string | undefined): string | null {
    if (this.explicit !== null) return this.explicit
    if (cwd === undefined || cwd.trim() === '') return null
    // Normalize a possibly-relative session cwd to an absolute path BEFORE
    // probing: inside `resolveHarnessDir` the `workspaceRoot` option is
    // resolved against the probe start, so a relative cwd (e.g. `packages/app`
    // when the dsh process cwd sits above the workspace) would anchor the
    // boundary BELOW the probe start and null out even a workspace-local
    // harness. The absolute path is also the canonical memoize key — two
    // spellings of one workspace share a cache row.
    const abs = resolve(cwd)
    const hit = this.cache.get(abs)
    if (hit !== undefined) return hit
    // The probe start is the boundary: never walk up from the session cwd.
    const resolved = resolveHarnessDir(abs, { workspaceRoot: abs })
    this.cache.set(abs, resolved)
    return resolved
  }

  /**
   * Resolve for one agent: the workspace root is the agent's session cwd.
   * @param agent - the agent handle an event carries (structural read).
   */
  forAgent(agent: unknown): string | null {
    return this.forWorkspace(sessionCwdOf(agent))
  }
}

/** The workspace root of one agent — the session cwd (structural read; never trusts the runtime shape). */
export function sessionCwdOf(agent: unknown): string | undefined {
  const session = (agent as { session?: { header?: { cwd?: unknown } } } | null | undefined)?.session
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined
}

/** The tool-execution actor of one fs-intent event, when it carries an agent. */
export function actorAgentOf(actor: object | undefined): unknown {
  return (actor as { agent?: unknown } | undefined)?.agent
}
/**
 * Map one engine `ValidationResult` to its lossless JSON view (`fix` omitted
 * when absent so `additionalProperties: false` never sees an undefined key).
 * The view interfaces live in `types.ts` (shared with the pre-step
 * iteration-gate catalog row).
 */
export function iterationViolationView(v: ValidationResult): IterationGateViolationView {
  return { severity: v.severity, code: v.code, message: v.message, ...(v.fix !== undefined ? { fix: v.fix } : {}) }
}

/** Map one engine gate (`GateResult`) to its JSON view. */
export function iterationGateView(gate: GateResult): IterationGateListView {
  return { ok: gate.ok, violations: gate.violations.map(iterationViolationView) }
}
/**
 * Build the dsh skill-local registration payload from the plugin Config
 * (single canonical mount). Semantics mirror the skill-local
 * `Config` contract: `skillRoots` → `customSkillDirs` (custom roots),
 * `bundledSkillDir` → `bundledSkillDir` (bundled root). The provider is
 * named `mstar` and default roots are excluded (`includeDefaultRoots: false`
 * — the repository-plugin convention: an isolated provider must see only its
 * explicit roots, so the mstar mount never claims the host app's own skills;
 * without this the app's user/project skills would be re-discovered under
 * the mstar provider). Returns `undefined` when nothing is configured — no
 * registration happens.
 *
 * The bundled default is the package's OWN `harness-skills/` mirror (synced
 * from the repo root by `bundle-assets` at build/postinstall; gitignored),
 * resolved package-relative — NOT cwd-anchored — so a deployment launching
 * from any cwd gets the bundled mount (this resolves the
 * cwd-anchoring limitation for the shipped default; an explicit
 * `bundledSkillDir` still wins).
 * @param config - validated plugin configuration.
 */
export function skillLocalConfig(config: Config): SkillLocalConfig | undefined {
  const customSkillDirs = config.skillRoots?.map((root) => root.trim()).filter((root) => root !== '')
  const bundledSkillDir = config.bundledSkillDir?.trim() ?? packagedSkillsDir()
  if ((customSkillDirs === undefined || customSkillDirs.length === 0) && bundledSkillDir === undefined) {
    return undefined
  }
  return {
    providerName: 'mstar',
    includeDefaultRoots: false,
    ...(customSkillDirs !== undefined && customSkillDirs.length > 0 ? { customSkillDirs } : {}),
    ...(bundledSkillDir !== undefined ? { bundledSkillDir } : {}),
  }
}
