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
 * Module boundary : gates import from this
 * module by explicit relative path (no barrel); the entry re-exports the
 * public names verbatim — consumers import through `src/index.ts`.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// The hosted schemastery fork (a peer dependency), NOT the npm `schemastery`
// the lockfile also carries: only the fork implements the `volatile` config
// reference protocol, and the Loader validates a plugin config through THIS
// schema's own `~standard`. With npm 3.18.0 the marker would be accepted but
// `createVolatile` never runs, so the Loader would drop a live settings save
// without a remount AND without applying it.
import z from '@deepseek-ai/schemastery'
import { resolveHarnessDir, resolveRepoEnforcement } from '@mstar-harness/engine'
import type { GateResult, ValidationResult } from '@mstar-harness/engine'
import type { Config as SkillLocalConfig } from '@deepseek-ai/dsh-skill-filesystem'
import type { IterationGateListView, IterationGateViolationView } from '../types.ts'
// Type-only (erased at runtime — no cycle): the resolver's structural hint
// shape, constructed here from the session/agent accessors below.
// `workflow-selection.ts` imports THIS module for values, so the value edge
// stays one-way; only the hint's TYPE crosses back.
import type { SessionHint } from './workflow-selection.ts'
/** Canonical harness status file name (mstar-artifacts status.json). */
export const STATUS_FILE = 'status.json'
/**
 * The issue/catalog authority's file name under the resolved `{HARNESS_DIR}`
 * (issue-store contract §2 — `<resolved harness root>/store.db`). `store.db`
 * is the ONE authority the host readers consult; the retired
 * `projects/<id>/residuals.json` registers and the Markdown index tables are
 * migration history.
 */
export const STORE_DB_FILE = 'store.db'
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
   * context, so the deployment declares it. `volatile`: read through the
   * Loader's live reference per dispatch, so the plugin settings form can edit
   * it without a remount.
   *
   * Absent is NOT a default: the caller is derived from the CALLING session —
   * a root session (`session.header.parentSession === undefined`) reads as the
   * coordinator (`ROOT_SESSION_DISPATCH_BINDING`), while a child session — or a
   * session the gate cannot read — stays EMPTY and fails closed with
   * `dispatch.anti-recursion.empty-binding`. An explicitly blank value
   * (`''`) also fails closed. A deployment whose coordinator is not the root
   * session MUST set this explicitly.
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
   * pre-step catalog cache (iteration-gate section, workspace-state digest)
   * re-reads the execution authority / the compass / the knowledge
   * index. Default 60000: a mid-session plan/compass/residual change lands
   * within one TTL (the hot path stays a timestamp compare + cache hit
   * between refreshes; a bounded sync re-read per workspace at most once
   * per interval). Absent → 60000.
   */
  catalogTtlMs?: number
  /**
   * Taxonomy bridge: mstar role id → fallbacks role id (the
   * `dsh-llm-fallbacks` role taxonomy). Logging + future rule-driven
   * interop only — NOT required for persona delivery (`rolePresets` is
   * the channel's only payload source). Absent → no bridge mapping.
   */
  roleMap?: Record<string, string>
  /**
   * mstar role id → agent preset id — the channel's only payload source. A
   * role-matched subagent start selects that preset on the activation
   * request (`SubagentStartRequest.agentPreset`), which is how dsh 0.2.1
   * delivers a per-child identity: the preset owns the child's composition
   * (persona via `@deepseek-ai/dsh-persona`, tools, skills), and the
   * continuation manager mounts it in place of the parent's composition.
   * The deployment declares one complete preset per role; mstar owns only
   * the role → preset SELECTION. Lookup is DIRECT — never gated on
   * `roleMap` or on the fallbacks mounted state.
   *
   * MERGE ORDER (doc-only statement of the decision chain in
   * `role-persona.ts` — no behavior change): a request that already carries
   * `agentPreset` (the delegation tool's configured default, or the model's
   * own `agent_preset` choice) wins AS-IS — the channel fills the slot only
   * when it is free, so caller intent is never overridden. Otherwise the
   * role is read from the Assignment header (`Execute as: <role>`, the same
   * engine grammar the dispatch gate uses) and a role with no configured
   * preset stays silent. The selection is skipped — with one contained
   * debug log and the start proceeds unchanged — when the provider does not
   * support independent selection (`capabilities.agentPreset` false, or a
   * provider that inherits its parent's conversation) or when the
   * `agentPresets` registry is not mounted in the composition.
   *
   * Configured ids are validated once per apply, as soon as the registry
   * resolves: an id the roster does not declare is reported with ONE
   * warning (otherwise it would surface only as a failed start).
   */
  rolePresets?: Record<string, string>
  /**
   * Dispatch-role normalization gate at the subagent start seam (the same
   * `internal/get` wrapper that delivers `rolePresets`). Both role consumers
   * read the Assignment header (`Execute as: <role>`); a delegation that
   * names its role only in prose ("Role: `fullstack-dev`") binds nothing and
   * silently starts a role-less child. The gate NORMALIZES an explicit
   * declaration — an `Execute as:` / `Act as:` / `Role:` field line, or a
   * backticked/bold already-declared role id — into the canonical header
   * (the rewritten prompt is what the runtime receives), and REFUSES only
   * when there is no reliable declaration: `hard` throws before delegating,
   * `warn` logs ONE advisory per apply and starts unchanged, `off` disables
   * the gate. Non-harness projects (the start `cwd` resolves no
   * `{HARNESS_DIR}`), requests that already carry a declaration or an
   * `agentPreset`, and unknown providers pass through silently. Default
   * `hard` (normalize-first, refuse-last).
   */
  roleGate?: 'off' | 'warn' | 'hard'
  /**
   * Workflow/ralph gate mode :
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
}

/**
 * dsh system-prompt strict `{{variable}}` interpolation hazard: the renderer
 * (`renderPrompt` → `interpolate` in `@deepseek-ai/dsh-system-prompt`) scans
 * section text for `{{` and THROWS on any `{{` paired with a later `}}` in
 * the same text (unknown variable, malformed group, or undefined value).
 * Persona text lands in the native request `persona` slot verbatim (the
 * same STRICT `{{...}}` template semantics as the deployment persona), so a
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
 * section/context text (): break every COMPLETE
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

/** The live-editable marker the Loader / `SettingsForms` read (declared here so a schemastery release that predates it still typechecks the `.extra()` write). */
declare module '@deepseek-ai/schemastery' {
  namespace Schemastery {
    interface Meta {
      volatile?: boolean
    }
  }
}

/**
 * The Loader's live config reference for a `volatile` schema node: an
 * identity-stable `{ get }` view whose snapshot the Loader re-commits on every
 * settings save (the cosmokit `Volatile` protocol). Detected STRUCTURALLY — the
 * protocol is duck-shaped and every other config shape must keep working.
 */
export interface LiveConfigRef {
  get(): unknown
}

/**
 * Whether one config value is the Loader's live volatile reference.
 * @param value - a raw config field value.
 * @returns `true` when the value answers `get()` as the live reference does.
 */
export function isLiveConfigRef(value: unknown): value is LiveConfigRef {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
}

/**
 * Read one `volatile` config field's CURRENT value. The Loader hands a
 * `volatile` node to `apply` as a live reference re-committed on every
 * settings save, so reading it per use (never caching it at apply) is what
 * makes a saved edit take effect without a remount. A plain value — a host
 * that resolves the schema without the volatile protocol — is read as-is.
 * @param value - the configured field (a live reference or a plain value).
 * @returns the current value, or `undefined` when absent.
 */
export function liveConfigValue<T>(value: T | LiveConfigRef | undefined): T | undefined {
  return (isLiveConfigRef(value) ? value.get() : value) as T | undefined
}

/**
 * The anti-recursion caller of a ROOT session (`Config.dispatchBinding`
 * fallback). A root session in this harness IS the coordinating agent, so an
 * unset `dispatchBinding` on a root session reads as `project-manager` — an
 * identity read, never a guess. It is NEVER the caller for a child session or
 * for a session the gate cannot read: those fail closed with
 * `dispatch.anti-recursion.empty-binding`, because a leaf must not dispatch.
 * Derivation: `dispatchCallerOf` in `dispatch.ts`.
 */
export const ROOT_SESSION_DISPATCH_BINDING = 'project-manager'

/** Schemastery configuration schema for the plugin consumer. Object keys are optional by default (`.optional()` is a vendored-fork addition not present in npm schemastery); omitted ARRAY keys would materialize as `[]` (schemastery empty-value default — the tool-subagent `toolFilter` pitfall) and omitted DICT keys would materialize as `{}`, so the dispatch keys and the persona keys all preserve omission via `.default(undefined)`. */
// simplify: the fork's 3.18.4 `.default()` typing defers the property Mode
// generic, so the inferred meta.default output admits a `Volatile<...>` arm
// that `Partial<Config>` rejects (3.18.2 accepted this assignment). The cast
// only relaxes this one initializer check — the runtime value and the declared
// `z<Config>` contract are unchanged. Drop it when the fork's `.default`
// return instantiates concretely again.
export const Config: z<Config> = z.object({
  harnessDir: z.string(),
  enforcement: z.union(['hard', 'soft']),
  dispatchTools: z.array(z.string()).default(undefined as unknown as string[]),
  // VOLATILE: the anti-recursion caller is read through the Loader's live
  // reference per dispatch (a settings save applies on the next dispatch).
  // NO constant default: an absent value means "derive the caller from the
  // calling session" (a root session reads as the coordinator; a child session
  // fails closed — `dispatchCallerOf`), and a schema default would fabricate
  // the caller for every leaf. An explicitly blank value also fails closed.
  dispatchBinding: z.string().extra('volatile', true),
  skillRoots: z.array(z.string()).default(undefined as unknown as string[]),
  bundledSkillDir: z.string().default(undefined as unknown as string),
  catalogTtlMs: z.number().default(undefined as unknown as number),
  roleMap: z.dict(z.string()).default(undefined as unknown as Record<string, string>),
  // Load-time validation (upstream `SubagentPresetSelection` validates its
  // configured ids the same way): an empty id would neither select a preset
  // nor stay silent, so it fails plugin mount with a clear message instead of
  // being discovered as a mis-selected child later. Whether an id is actually
  // declared is answered by the registry at apply (one warning per unknown
  // id), where the answer is available.
  rolePresets: z.transform(
    z.dict(z.string()),
    // Explicit parameter type: the fork's `transform` does not infer the dict
    // value type (npm schemastery did), and the runtime value is the same.
    (value: Record<string, string>) => {
      for (const [role, presetId] of Object.entries(value)) {
        if (presetId.trim().length === 0) {
          throw new z.ValidationError(
            `rolePresets["${role}"] must name a deployed agent preset id — an empty value selects nothing (remove the mapping to leave the role unmapped)`,
            {},
          )
        }
      }
      return value
    },
  ).default(undefined as unknown as Record<string, string>),
  // Dispatch-role normalization gate : `roleGate` defaults to 'hard'
  // (normalize-first, refuse-last: an explicit declaration is repaired
  // before a start is ever refused, and only a prompt with NO reliable role
  // declaration is blocked); `warn`/`off` are the per-deployment rollbacks.
  // VOLATILE (with `dispatchBinding`, the plugin's TWO live fields):
  // `roleGate` is read through the Loader's live reference on every start, so
  // the dsh plugin settings form can edit it without a remount — and the form
  // therefore carries exactly these fields (every other Config key is
  // apply-time and needs a reload).
  roleGate: z.union(['off', 'warn', 'hard']).default('hard').extra('volatile', true),
  // Workflow/ralph gate : `workflowGate`
  // defaults to 'warn' (no surprise hard-block — the gate is advisory-only
  // unless the deployment opts into ask/hard); `workflowNames` preserves
  // omission via `.default(undefined)` (schemastery empty-value default
  // would materialize an omitted array as `[]` — which IS the documented
  // "every name unknown" semantics, but keep the same explicit pattern as
  // the dispatch/persona array keys so absence stays observable).
  workflowGate: z.union(['off', 'warn', 'ask', 'hard']).default('warn'),
  workflowNames: z.array(z.string()).default(undefined as unknown as string[]),
}) as z<Config>
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
 * Cap on the plan rows joined into the `<mstar_engine_status>` catalog state
 * line : ONE catalog-owned
 * constant bounding the compact lifecycle delta, so an oversized workflow
 * snapshot cannot balloon the single-line catalog state section.
 * Numeric precedent: `DIGEST_PLAN_CAP` in `system-prompt.ts` (digest-side,
 * non-Done-only). Plan row SCOPES are payload-only (the panel renders them), so
 * this cap no longer joins a `row scope:` line.
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
 * Hoisted from `system-prompt.ts`  so
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
 * zero-config role-persona default source. Same dual-depth probe semantics
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

/**
 * The stable session id of one agent — `session.header.id` (structural read).
 *
 * The SAME identity a later reader asserts when it asks the host endpoint for
 * a session's engine-status snapshot: without a real id there is nothing to key
 * a stored snapshot by, so an agent stub answers undefined and the write site
 * skips the persist instead of inventing a key.
 */
export function sessionHeaderIdOf(agent: unknown): string | undefined {
  const session = (agent as { session?: { header?: { id?: unknown } } } | null | undefined)?.session
  const id = session?.header?.id
  return typeof id === 'string' && id.trim() !== '' ? id : undefined
}

/**
 * The opaque id of one agent (`Agent.id`, structural read). Deliberately
 * distinct from {@link sessionHeaderIdOf}: the durable binding key is
 * `session.header.id`, while this is the dispatching agent's own id — used as
 * a catalog cache-key component, never substituted for the session id.
 */
export function agentIdOf(agent: unknown): string | undefined {
  const id = (agent as { id?: unknown } | null | undefined)?.id
  return typeof id === 'string' && id.trim() !== '' ? id : undefined
}


/**
 * The structural session hint one event's agent supplies to the workflow
 * resolvers (no dsh-session import — cold/raw Session consumers read the same
 * `header.cwd` / `header.id` directly). `selectedWorkflowId` is deliberately
 * ABSENT: it is the session's durable binding record, loaded by the
 * composition edge that owns the store (adapter / catalog / workflow-ledger /
 * plan-mode bridge) — the pure structural read never fabricates it.
 * @param agent - the agent an event carries (structural read).
 * @returns the hint, or `undefined` when the agent carries no session
 *   identity and no id at all (an exec-less hook) — an OMITTED hint, never a
 *   fabricated empty one.
 */
export function sessionHintOf(agent: unknown): SessionHint | undefined {
  const cwd = sessionCwdOf(agent)
  const sessionId = sessionHeaderIdOf(agent)
  if (cwd === undefined && sessionId === undefined) return undefined
  return {
    ...(cwd === undefined ? {} : { cwd }),
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

/**
 * One carrying session's selection-hint read: the hint the resolvers consume,
 * plus whether the session's DURABLE binding could be trusted.
 *
 * `ok` without a `hint` = the event carries no session (an exec-less hook) —
 * the automatic rungs miss and the registry's unique-active case still
 * resolves. `unavailable` = the binding store could not be read
 * (corrupt/unreadable/cwd-mismatch), so the caller must NOT attribute a
 * durable write to this session — an unverifiable record is NOT "no pick",
 * and must never be replaced by an empty hint that would silently attribute
 * the write to whichever lifecycle happens to resolve.
 */
export type SessionHintRead =
  | { readonly kind: 'ok'; readonly hint?: SessionHint }
  | { readonly kind: 'unavailable'; readonly reason: string; readonly hint?: SessionHint }

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
