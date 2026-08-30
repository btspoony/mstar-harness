/**
 * Shared plugin contract pieces for the dsh gates (`src/gates/*`).
 *
 * Cross-module shared state for the gate modules and the entry: the plugin
 * configuration contract (`Config` interface + schemastery schema), the
 * per-workspace `{HARNESS_DIR}` resolver (+ session helpers), the shared
 * violation/record helpers, the seam hard-enforcement resolution, the
 * packaged skills-dir resolution, the skill-filesystem registration payload,
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
import { resolveHarnessDir, resolveRepoEnforcement } from '@mstar-harness/engine'
import type { GateResult, ValidationResult } from '@mstar-harness/engine'
import type { Config as SkillLocalConfig } from '@deepseek-ai/dsh-skill-filesystem'
import type { IterationGateListView, IterationGateViolationView } from '../types.ts'
/** Canonical harness status file name (mstar-artifacts status.json). */
export const STATUS_FILE = 'status.json'
/** Plugin configuration. */
export interface Config {
  /**
   * Explicit harness root. When set, wins over engine probing (plan-conventions
   * `{HARNESS_DIR}` resolution order); when absent the plugin probes from
   * the SESSION workspace root (`agent.session.header.cwd`) — never the
   * process cwd — walking `.mstar/` → `.agents/` → `.plans/`/`plans/`.
   * Required for repos whose harness root is not a probed name.
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
   * subagent tool registers as `subagent` by default (its fork sibling
   * `subagent_fork` carries the same Assignment-shaped args and is gated
   * too), but the `toolName` config may rename instances (tool-subagent
   * README: each instance needs a distinct name), so the match list is
   * deployment-settable. Defaults to `['subagent', 'subagent_fork']`.
   */
  dispatchTools?: string[]
  /**
   * The dispatching agent's own harness role/type (e.g. `fullstack-dev`), used
   * as the anti-recursion binding: an Assignment whose `Execute as` equals this
   * role is a self-dispatch (critical violation — leaf executors must not
   * re-invoke their own role). dsh exposes no agent role on the tool-execution
   * context, so the deployment declares it. Absent → the empty binding FAILS
   * CLOSED: every Assignment-shaped dispatch emits
   * `dispatch.anti-recursion.empty-binding` (critical) until the binding is
   * set.
   */
  dispatchBinding?: string
  /**
   * Additional skill roots registered with the dsh skill-filesystem provider
   * (skill-filesystem `Config.customSkillDirs` semantics — scanned after project
   * roots and before user roots — single canonical mount).
   * Dev-time: the mirror `<repo-root>/skills` absolute path. Each root's
   * children are skill dirs (`<name>/SKILL.md`) or flat skill files
   * (`<name>.md`). Absent → no custom-root registration.
   */
  skillRoots?: string[]
  /**
   * Bundled skill root registered with the dsh skill-filesystem provider
   * (skill-filesystem `Config.bundledSkillDir` semantics — scanned last, trusted).
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
  /**
   * Taxonomy bridge: mstar role id → fallbacks role id (the
   * `dsh-llm-fallbacks` role taxonomy). Logging + future rule-driven
   * interop only — NOT required for persona injection (`rolePersonas` is
   * the decoration's only payload source). Absent → no bridge mapping.
   */
  roleMap?: Record<string, string>
  /**
   * mstar role id → persona text — the subagent decoration's only payload
   * source (plan `20260814-dsh-fallbacks-integration` Task 2). A
   * role-matched `subagent/start` registers the persona as the child's
   * `mstar:role-persona` system-prompt section (agent-scoped on
   * `Agent.ctx`, unwinds on disposal). Lookup is DIRECT — never gated on
   * `roleMap` or on the fallbacks mounted state (unmounted → same
   * injection from Config + one debug log). Absent → no decoration.
   *
   * INTERPOLATION CONSTRAINT: dsh system-prompt renders section text with
   * STRICT `{{variable}}` interpolation and throws on any `{{` paired with a
   * later `}}` (unknown/malformed/undefined reference), so persona values
   * MUST NOT contain that pattern — a violating persona would break child
   * prompt assembly at the child's first render, for EVERY role-matched
   * dispatch. The Config schema rejects such values at plugin mount with a
   * clear error (see {@link PERSONA_INTERPOLATION_HAZARD}); a lone `{{` with
   * no later `}}` is literal prose (safe), and the escape rule is single
   * braces or rewording. Keep persona text concise; bound its length at
   * deployment.
   */
  rolePersonas?: Record<string, string>
  /**
   * Workflow/ralph gate mode (plan `20260815-dsh-workflow-gate` W-B3, AC-7):
   * `off` disables the gate entirely (workflow/ralph calls pass through
   * untouched, NO verdict row); `warn` (default) logs an advisory for
   * policy-unknown fan-out without ever blocking; `ask` routes first-seen
   * workflow names through the dsh approval channel (`{kind:'ask'}` —
   * fail-closed upstream, this gate invents no answerer); `hard` vetoes a
   * policy-violating fan-out call before any child starts. Absent → 'warn'.
   */
  workflowGate?: 'off' | 'warn' | 'ask' | 'hard'
  /**
   * Workflow name allowlist (P-a): `meta.name` values treated as KNOWN by
   * the gate. Empty or absent ⇒ every name is unknown (documented — the
   * gate is NOT "allow all" by omission). Ralph calls carry no `meta.name`,
   * so P-a never applies to them.
   */
  workflowNames?: string[]
  /**
   * Goal-bridge round cap (plan `20260816-dsh-nb2-goal-bridge` Task 2): the
   * flat `maxGoalRounds` the goal bridge passes to the goals service when it
   * mirrors the active iteration objective (bounds autonomous Phase 2
   * loops — the service itself throws on resume past the cap). Absent →
   * 256 (aligned with the GoalService default and ralph `maxRounds` —
   * architect decision; see the plan).
   */
  maxGoalRounds?: number
}

/**
 * dsh system-prompt strict `{{variable}}` interpolation hazard: the renderer
 * (`renderPrompt` → `interpolate` in `@deepseek-ai/dsh-system-prompt`) scans
 * section text for `{{` and THROWS on any `{{` paired with a later `}}` in
 * the same text (unknown variable, malformed group, or undefined value).
 * Persona text lands in the `mstar:role-persona` section verbatim, so a
 * persona containing this pattern breaks child prompt assembly at the
 * child's first render — every role-matched dispatch. The Config schema
 * rejects such values at validation (plugin mount) with a clear error. The
 * mirror-default extraction (agent-personas.ts) reuses this constant: a
 * violating default is WARNED + skipped at extraction, never a boot throw. A
 * lone `{{` with no later `}}` is literal prose (safe); the escape rule is
 * single braces or rewording.
 */
export const PERSONA_INTERPOLATION_HAZARD = /\{\{[\s\S]*\}\}/

/**
 * Screen ONE dynamic string before it is embedded into dsh system-prompt
 * section/context text (plan QC fix wave W-1): break every COMPLETE
 * `{{...}}` group (the renderer's STRICT `interpolate` throws on any `{{`
 * paired with a later `}}` — unknown variable, malformed group, undefined
 * value), while leaving a LONE `{{` without a later `}}` verbatim (upstream
 * renders it as literal prose — already safe, do not mangle it).
 *
 * A complete group is rewritten to `{ {…} }` (a space inside each pair), so
 * no adjacent `{{`/`}}` survives the renderer scan; the rewrite is re-scanned
 * because a nested/adjacent brace at either boundary can expose a fresh pair.
 * The output is plain text the renderer treats as literal — operator-chosen
 * values (paths, plan/iteration ids, lease fields, compass direction prose)
 * can never break prompt assembly.
 */
export function stripInterpolationHazard(text: string): string {
  let out = text
  for (;;) {
    const open = out.indexOf('{{')
    if (open < 0) return out
    const close = out.indexOf('}}', open + 2)
    if (close < 0) return out // lone `{{` — literal upstream; keep verbatim
    out = `${out.slice(0, open)}{ {${out.slice(open + 2, close)}} }${out.slice(close + 2)}`
  }
}

/** Schemastery configuration schema for the plugin consumer. Object keys are optional by default (`.optional()` is a vendored-fork addition not present in npm schemastery); omitted ARRAY keys would materialize as `[]` (schemastery empty-value default — the tool-subagent `toolFilter` pitfall) and omitted DICT keys would materialize as `{}`, so the dispatch keys and the decoration keys all preserve omission via `.default(undefined)`. */
export const Config: z<Config> = z.object({
  harnessDir: z.string(),
  enforcement: z.union(['hard', 'soft']),
  dispatchTools: z.array(z.string()).default(undefined as unknown as string[]),
  dispatchBinding: z.string().default(undefined as unknown as string),
  skillRoots: z.array(z.string()).default(undefined as unknown as string[]),
  bundledSkillDir: z.string().default(undefined as unknown as string),
  catalogTtlMs: z.number().default(undefined as unknown as number),
  roleMap: z.dict(z.string()).default(undefined as unknown as Record<string, string>),
  // Hardening (plan QC W-001): persona text is rendered by dsh system-prompt
  // strict interpolation — a `{{` paired with a later `}}` throws at child
  // prompt assembly. Reject such values HERE so a violating persona fails
  // plugin mount with a clear error instead of breaking every role-matched
  // dispatch later. The vendored schemastery fork has no `.refine`, and its
  // transform callback receives no `options` (fork quirk), so the role key is
  // interpolated into the message directly.
  rolePersonas: z.transform(
    z.dict(z.string()),
    (value) => {
      for (const [role, persona] of Object.entries(value)) {
        if (PERSONA_INTERPOLATION_HAZARD.test(persona)) {
          throw new z.ValidationError(
            `rolePersonas["${role}"] must not contain a "{{" paired with a later "}}" (dsh system-prompt strict interpolation renders persona text and throws on unknown or malformed references — use single braces or reword)`,
            {},
          )
        }
      }
      return value
    },
  ).default(undefined as unknown as Record<string, string>),
  // Workflow/ralph gate (plan `20260815-dsh-workflow-gate`): `workflowGate`
  // defaults to 'warn' (no surprise hard-block — the gate is advisory-only
  // unless the deployment opts into ask/hard); `workflowNames` preserves
  // omission via `.default(undefined)` (schemastery empty-value default
  // would materialize an omitted array as `[]` — which IS the documented
  // "every name unknown" semantics, but keep the same explicit pattern as
  // the dispatch/decoration array keys so absence stays observable).
  workflowGate: z.union(['off', 'warn', 'ask', 'hard']).default('warn'),
  workflowNames: z.array(z.string()).default(undefined as unknown as string[]),
  // Goal-bridge round cap (plan `20260816-dsh-nb2-goal-bridge` Task 2):
  // flat numeric key preserving omission via `.default(undefined)` (the
  // `catalogTtlMs` precedent) — the module resolves the 256 fallback, so
  // absence stays observable at the Config boundary.
  maxGoalRounds: z.number().default(undefined as unknown as number),
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
 * Cap on the plan / lease rows joined into the `<mstar_engine_status>`
 * catalog state lines (plan `20260830-dsh-catalog-cap` D1): ONE catalog-owned
 * constant shared by the `plans:` and `leases:` joins so an oversized
 * workflow snapshot cannot balloon the single-line catalog state section.
 * Numeric precedent: `DIGEST_PLAN_CAP` in `system-prompt.ts` (digest-side,
 * non-Done-only — intentionally NOT reused here; the catalog renders the
 * full, unfiltered snapshot rows).
 */
export const CATALOG_STATE_JOIN_LIMIT = 8

/**
 * Join the screened projection of `items` in catalog-array order, capped at
 * `cap`: when `items.length > cap` the FIRST `cap` items render followed by
 * a final `+N more` overflow marker (`N = items.length - cap`) as the last
 * join element; at or under the cap the full join renders with no marker.
 * The `render` callback owns any per-item `stripInterpolationHazard`
 * screening (before the join, same as the uncapped code); the marker is an
 * engine-derived literal and stays unscreened. Callers guard the empty case
 * (`length === 0` → `none` / `none registered` / `none active`) — this
 * helper is never reached for empty arrays.
 *
 * Hoisted from `system-prompt.ts` (plan `20260830-dsh-catalog-cap` D3) so
 * the GLOBAL digest and the catalog state lines share ONE join-capping
 * implementation; `_shared.ts` imports no gates-local module, so no import
 * cycle is introduced.
 */
export function joinCapped<T>(items: readonly T[], cap: number, separator: string, render: (item: T) => string): string {
  const visible = items.slice(0, cap).map(render)
  if (items.length > cap) visible.push(`+${items.length - cap} more`)
  return visible.join(separator)
}

/**
 * Resolve the hard-enforcement flag for the artifact gates: explicit
 * Config override wins, else the repo `.mstarc` `[config] enforcement`,
 * else the iteration compass frontmatter (when a harness dir resolves),
 * else warn-only. {@link resolveHard} parity with a
 * null-tolerant harness dir — the skill roots and the artifact
 * seams (design-md / audit / compound / roles) do not require
 * `{HARNESS_DIR}` (compound scoping is the only seam that does, and only
 * for its knowledge-path matcher).
 */
export function resolveSeamHard(harnessDir: string | null, config: Config): boolean {
  if (config.enforcement === 'hard') return true
  if (config.enforcement === 'soft') return false
  return harnessDir !== null && resolveRepoEnforcement(harnessDir).hard
}
/**
 * Resolve the plugin package's own `harness-skills/` mirror (synced from the
 * repo root by `bundle-assets` at build time; gitignored), anchored at
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
 * build time), so the first resolution is cached and the agent-loop
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
 * Resolve the plugin package's own `harness-agents/` mirror (synced from the
 * repo root by `bundle-assets` at build time; gitignored) — the
 * zero-config role-persona default source (plan
 * `20260815-dsh-fallbacks-personas` Task 3). Same dual-depth probe semantics
 * as {@link resolvePackagedSkillsDir}: `'../harness-agents'` (dist layout
 * candidate) then `'../../harness-agents'` (source-layout candidate);
 * `src/harness-agents` is non-canonical and skipped shallow-first.
 * @param fileUrl - the module's `import.meta.url` string (or any file URL at
 * the depth whose layout should be probed).
 */
export function resolvePackagedAgentsDir(fileUrl: string): string | undefined {
  for (const rel of ['../harness-agents', '../../harness-agents'] as const) {
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
 * Memoized thin wrapper over {@link resolvePackagedAgentsDir} — same cache
 * semantics as {@link packagedSkillsDir} (only a RESOLVED value is memoized;
 * an absent mirror is re-probed later so a mid-process `bundle-assets` run
 * is still picked up).
 */
let packagedAgentsDirMemo: string | undefined
export function packagedAgentsDir(): string | undefined {
  if (packagedAgentsDirMemo !== undefined) return packagedAgentsDirMemo
  const dir = resolvePackagedAgentsDir(import.meta.url)
  if (dir !== undefined) packagedAgentsDirMemo = dir
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
 * Build the dsh skill-filesystem registration payload from the plugin Config
 * (single canonical mount). Semantics mirror the skill-filesystem
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
 * from the repo root by `bundle-assets` at build time; gitignored),
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
