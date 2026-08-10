/**
 * Shared plugin contract pieces for the dsh gates (`src/gates/*`).
 *
 * Cross-module shared state for the gate modules and the entry: the plugin
 * configuration contract (`Config` interface + schemastery schema), the
 * per-workspace `{HARNESS_DIR}` resolver (+ session helpers), the shared
 * violation/record helpers, the seam hard-enforcement resolution, the
 * packaged skills-dir resolution and the canonical status file name.
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
import type { ValidationResult } from '@mstar-harness/engine'
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
 * The plugin package's own `harness-skills/` mirror (synced from the repo
 * root by `bundle-assets` at build/postinstall; gitignored). Resolved
 * package-relative via `import.meta.url` — NOT cwd-anchored — so the shipped
 * bundled mount works from any launch cwd (this resolves the
 * cwd-anchoring limitation for the default; an explicit `bundledSkillDir`
 * still wins). Returns undefined when the mirror is absent (e.g. a checkout
 * where `bundle-assets` has not run — the default mount is then inert).
 */
export function packagedSkillsDir(): string | undefined {
  try {
    const dir = fileURLToPath(new URL('../harness-skills', import.meta.url))
    return existsSync(dir) ? dir : undefined
  } catch {
    return undefined
  }
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
