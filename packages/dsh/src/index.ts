/**
 * Morning Star harness gates for the DeepSeek Harness SDK (dsh).
 *
 * Cordis function plugin: named exports only — the dsh Loader discards the plugin's namespace
 * (dropping `inject` metadata) when a default export is present, so this module never
 * default-exports. Registrations happen through `ctx` effects/events in `apply`.
 *
 * @module @mstar-harness/dsh
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { Service, type Context } from 'cordis'
import z from 'schemastery'
import {
  apply as applySkillLocal,
  Config as SkillLocalSchema,
  inject as skillLocalInject,
  name as skillLocalName,
} from '@deepseek-ai/dsh-skill-local'
import type { Config as SkillLocalConfig } from '@deepseek-ai/dsh-skill-local'
import {
  antiRecursionPrecheck,
  applyEnforcement,
  assertDefaultBranchProtected,
  assignmentHeaderRegion,
  executionModeToN,
  findingsCleanupGate,
  isReadOnlyAssignmentRole,
  lintFiveQuestion,
  lintFrontmatter,
  parseAssignmentBranchForms,
  parseAssignmentFields,
  parseBranchPolicyDirectOnBranch,
  parseEnforcementFlag,
  readJson,
  resolveAssetPath,
  resolveCompassEnforcement,
  resolveHarnessDir,
  resolveSkillRoot,
  validateAssignmentFields,
  validateExecutionLease,
  validateIntegrationMergeLease,
  validateStatus,
  verifyPlanExecutionLease,
} from '@mstar-harness/engine'
import type {
  AssignmentFields,
  GateResult,
  HostAdapter,
  IntegrationMergeLease,
  StatusDoc,
  ValidationResult,
} from '@mstar-harness/engine'
import type { FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { DshMstar } from './service.ts'

// Re-export the service type from the package entry (qc3 F-2a): the cordis
// `Context` augmentation (`ctx.dshMstar`) lives in service.d.ts, so the entry
// must reference it for consumers importing `@mstar-harness/dsh` to see a
// typed `ctx.dshMstar`.
export { DshMstar } from './service.ts'
export type { DshMstarOptions } from './service.ts'

/** Cordis function-plugin name registered by the Loader. */
export const name = 'dsh'

/**
 * Services required before this plugin's `apply` fiber starts.
 * Empty for the scaffold: the plan's gates register on events (`fs/write-intent`,
 * `tools/pre-execute`), not on injected services; `inject` grows if a service seam is needed.
 */
export const inject: string[] = []

/** Logger label for the status gate (dsh logger naming: `<scope>/<subject>`). */
const LOGGER_NAME = 'mstar/status-gate'

/** Canonical harness status file name (mstar-plan-artifacts status.json). */
const STATUS_FILE = 'status.json'

/** Logger label for the dispatch gate (dsh logger naming: `<scope>/<subject>`). */
const DISPATCH_LOGGER = 'mstar/dispatch-gate'

/** Logger label for the host adapter (dsh logger naming: `<scope>/<subject>`). */
const HOST_LOGGER = 'mstar/host-adapter'

/** Logger label for the skill lint gate (dsh logger naming: `<scope>/<subject>`). */
const SKILL_LINT_LOGGER = 'mstar/skill-lint'

/** Default delegation tool names the dispatch gate matches (tool-subagent default id). */
const DEFAULT_DISPATCH_TOOLS = ['subagent'] as const

/** `## Assignment` heading marker (opencode parity — shape guard only). */
const ASSIGNMENT_HEADING_RE = /^#{1,6}\s+Assignment\s*$/m

/** Shape-guard match of an Assignment header field (opencode parity). */
const ASSIGNMENT_FIELD_RE =
  /^[ \t]*(?:[-*][ \t]+)?\*{0,2}(Execute as|Delegation|Task category)\*{0,2}[ \t]*:[ \t]*(\S.*)$/gm

/** Plugin configuration. */
export interface Config {
  /**
   * Explicit harness root. When set, wins over engine probing (plan-conventions
   * `{HARNESS_DIR}` resolution order); when absent the plugin probes from the
   * process cwd (`.mstar/` → `.agents/` → `.plans/`/`plans/`).
   */
  harnessDir?: string
  /**
   * Per-deployment enforcement override (roadmap §8.5 C4/D2). `hard` forces
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
   * roots and before user roots; roadmap D6 single canonical mount).
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
}

/** Schemastery configuration schema for the plugin consumer. Object keys are optional by default (`.optional()` is a vendored-fork addition not present in npm schemastery); omitted ARRAY keys would materialize as `[]` (schemastery empty-value default — the tool-subagent `toolFilter` pitfall), so both dispatch keys preserve omission via `.default(undefined)`. */
export const Config: z<Config> = z.object({
  harnessDir: z.string(),
  enforcement: z.union(['hard', 'soft']),
  dispatchTools: z.array(z.string()).default(undefined as unknown as string[]),
  dispatchBinding: z.string().default(undefined as unknown as string),
  skillRoots: z.array(z.string()).default(undefined as unknown as string[]),
  bundledSkillDir: z.string().default(undefined as unknown as string),
})

/**
 * Advisory emitted on status-gate decisions (the plan's "emit `agent/status`
 * (advisory)" step). Named `mstar/status-gate` instead: the dsh `agent/status`
 * event is a lifecycle-only channel (`{ agent, status }`, idle ⇄ running, with
 * an invariant rejecting no-op transitions) — emitting gate warnings on it
 * would violate the seam contract. Consumers (later tasks, catalogs) observe
 * this event for model-visible/session-log surfacing.
 *
 * The status gate NEVER throws (qc3 F-1 / qc2 W-001): the fs intent waterfall
 * carries no incoming content, so the only hard-mode decision this seam can
 * make about an ALREADY-invalid document is to allow the write as a repair
 * escape. Every decision surfaces through this advisory; unexpected internal
 * errors degrade to an allow with `degraded: true`.
 */
export interface StatusGateAdvisory {
  /** Which intent slot passed the gate. */
  operation: 'write' | 'edit'
  /** `displayPath` of the guarded file. */
  target: string
  /** The gate verdict (warn-mode: `hardBlocked` false; hard repair escape: `hardBlocked` true). */
  result: GateResult
  /** Resolved enforcement flag: false for warn-mode advisories, true for hard-mode repair escapes. */
  hard: boolean
  /** True when hard mode allowed a write/edit to an ALREADY-invalid document (repair escape). */
  repair?: boolean
  /** True when the gate errored internally and degraded to allow (error-containment envelope). */
  degraded?: boolean
}

/**
 * Advisory emitted on warn-mode dispatch-gate passes (Task 4; the Task 3
 * `mstar/status-gate` decision reused for the dispatch gate — dsh's
 * `agent/status` lifecycle event stays untouched). Consumers (later tasks,
 * catalogs) observe this event for model-visible/session-log surfacing.
 */
export interface DispatchGateAdvisory {
  /** The matched delegation tool name. */
  tool: string
  /** The Assignment's declared `Execute as` ('' when missing). */
  role: string
  /** The gate verdict (warn-mode: `hardBlocked` is false). */
  result: GateResult
  /** Whether hard enforcement is on (advisory events are warn-mode by construction). */
  hard: boolean
  /** True when the gate errored internally and degraded to allow (structured degraded advisory, qc2 W-003). */
  degraded?: boolean
}

/**
 * Advisory emitted on skill-lint gate decisions (the `mstar/status-gate`
 * advisory pattern reused for the skill-authoring gate — Task 4). Emitted
 * when a `SKILL.md` write-intent under a configured skill root finds lint
 * violations in the pre-write on-disk document (warn mode), when hard mode
 * allows an ALREADY-invalid document as a repair escape, and when the gate
 * degrades to allow after an unexpected internal error. Clean passes stay
 * silent.
 *
 * The gate NEVER throws on the listener path (status-gate repair-escape
 * semantics): the intent waterfall carries no incoming content, so the only
 * lint signal is the pre-write on-disk state; the typed hard veto lives on
 * the incoming-document branch (`lintSkillWrite`, `SkillLintVetoError`).
 */
export interface SkillLintAdvisory {
  /** Which intent slot passed the gate (write-intent only — skills have no linted edit slot). */
  operation: 'write'
  /** `displayPath` of the guarded SKILL.md. */
  target: string
  /** Canonical skill-root form of the target (Task 1 frozen `resolveSkillRoot('dsh', …)` form). */
  canonical: string
  /** The lint verdict (warn-mode: `hardBlocked` false; hard repair escape: `hardBlocked` true). */
  result: GateResult
  /** Resolved enforcement flag: false for warn-mode advisories, true for hard-mode repair escapes. */
  hard: boolean
  /** True when hard mode allowed a write to an ALREADY-invalid document (repair escape). */
  repair?: boolean
  /** True when the gate errored internally and degraded to allow (error-containment envelope). */
  degraded?: boolean
}

declare module 'cordis' {
  interface Context {
    /**
     * The plugin's engine `HostAdapter` implementation (`host: 'dsh'`) —
     * provided as a dsh service (constructed in `apply`, same convention as
     * `ctx.dshMstar`) so host hooks and future inject consumers share the
     * one instance.
     */
    dshHostAdapter: DshHostAdapter
  }

  interface Events {
    /**
     * Advisory: a subagent dispatch passed the dispatch gate in warn mode
     * (violations logged, dispatch allowed). Emitted only when the Assignment
     * has violations; clean passes stay silent.
     * @param payload - the gate verdict and dispatch identity.
     * @mode emit
     */
    'mstar/dispatch-gate'(payload: DispatchGateAdvisory): void
    /**
     * Advisory: a `{HARNESS_DIR}/status.json` write/edit intent passed the
     * status gate in warn mode (violations logged, write allowed). Emitted
     * only when the current document has violations; clean passes stay silent.
     * @param payload - the gate verdict and target.
     * @mode emit
     */
    'mstar/status-gate'(payload: StatusGateAdvisory): void
    /**
     * Advisory: a `SKILL.md` write-intent under a configured skill root
     * found skill-authoring lint violations in the pre-write on-disk
     * document (warn mode), was allowed as a hard-mode repair escape, or
     * degraded to allow. Emitted only when the current document has
     * violations; clean passes stay silent.
     * @param payload - the lint verdict and target.
     * @mode emit
     */
    'mstar/skill-lint'(payload: SkillLintAdvisory): void
  }
}

/** One violation line for logs and the typed veto message. */
function formatViolation(violation: ValidationResult): string {
  return `[${violation.severity}] ${violation.code}: ${violation.message}${violation.fix !== undefined ? ` (fix: ${violation.fix})` : ''}`
}

/** Narrow an unknown value to a record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Whether a target is the canonical `{HARNESS_DIR}/status.json`. Matching is by
 * resolved path equality on `displayPath` (the local backend reports absolute
 * paths; remote/URI backends never match and the gate is inert for them).
 */
function isStatusTarget(harnessDir: string, target: FsTarget): boolean {
  return basename(target.displayPath) === STATUS_FILE
    && resolve(dirname(target.displayPath)) === resolve(harnessDir)
}

/**
 * Resolve the hard-enforcement flag: explicit Config override wins, else the
 * iteration compass frontmatter (`resolveCompassEnforcement`), else warn-only.
 */
function resolveHard(harnessDir: string, config: Config): boolean {
  if (config.enforcement === 'hard') return true
  if (config.enforcement === 'soft') return false
  return resolveCompassEnforcement(harnessDir).hard
}

/**
 * Validate a PARSED status document through the status-gate pipeline
 * (engine `validateStatus` + `findingsCleanupGate` per plan row that
 * CONFIGURES a mode). Shared by {@link validateStatusDoc} (the on-disk
 * single-read path) and the host adapter's `beforeStatusWrite` (the
 * incoming document) — the fs-intent gate, the adapter hook and the repair
 * escape all surface the SAME violation codes.
 */
function validateStatusValue(doc: unknown): GateResult {
  const base = validateStatus(doc as StatusDoc)
  if (!base.ok) return base
  const record = asRecord(doc)
  if (record === undefined) return base
  const violations: ValidationResult[] = []
  for (const row of Array.isArray(record.plans) ? record.plans : []) {
    const metadata = asRecord(row.metadata)
    const mode = metadata?.['findings_cleanup']
    if (mode !== 'zero-residual' && mode !== 'allow-residual') continue
    const planId = typeof row.id === 'string' ? row.id : typeof row.plan_id === 'string' ? row.plan_id : undefined
    if (planId === undefined) continue
    violations.push(...findingsCleanupGate(record as StatusDoc, planId, { mode }).violations)
  }
  if (violations.length === 0) return base
  return { ok: false, violations }
}

/**
 * Run the status gate over the CURRENT on-disk document. The fs intent
 * waterfall carries only `(target, actor)` — never the incoming content — so
 * the vetoable check is the pre-write state (the opencode hook's fallback for
 * the same reason). `findingsCleanupGate` runs per plan row that CONFIGURES a
 * mode (`plans[].metadata.findings_cleanup`); schema violations short-circuit
 * it (the doc must parse for the cleanup gate to be meaningful).
 *
 * Single-read contract (qc3 F-1): the file is parsed exactly once and the
 * parsed doc is passed to {@link validateStatusValue} — the previous
 * path-first read then `readJson` re-read was a TOCTOU window (a concurrent
 * writer between the two reads threw a raw error from inside the gate).
 * Malformed JSON is contained here with the engine's `status.invalid-json`
 * shape; never throws. Missing files are guarded by the callers
 * (`gateStatusIntent`, {@link DshHostAdapter.statusGate}) — first create has
 * no document to validate and passes before this function runs.
 */
function validateStatusDoc(statusPath: string): GateResult {
  let doc: unknown
  try {
    doc = readJson(statusPath)
  } catch (error) {
    return {
      ok: false,
      violations: [{
        ok: false,
        severity: 'high',
        code: 'status.invalid-json',
        message: (error as Error).message,
      }],
    }
  }
  return validateStatusValue(doc)
}

/**
 * Gate one fs intent on `{HARNESS_DIR}/status.json`. The gate never throws
 * (qc3 F-1 / qc2 W-001): warn mode logs + advisory emit + delegates; hard
 * mode with an ALREADY-invalid document logs an error-level REPAIR advisory
 * and delegates — the intent waterfall carries no incoming content, so a
 * hard veto here would deadlock the very write that repairs the document.
 * The coherent content-blind policy: invalid on-disk → allow-as-repair;
 * valid on-disk → normal validation path (pass). Non-status targets and
 * absent documents are pure pass-through.
 *
 * Error-containment envelope: any unexpected error (TOCTOU race, backend
 * contract violation on `displayPath`, throwing advisory consumer) degrades
 * to allow in BOTH modes with a loud log + `degraded: true` advisory — an
 * untyped throw from the gate would spuriously block legitimate writes (the
 * fs waterfall has no error containment of its own).
 */
function gateStatusIntent(
  ctx: Context,
  harnessDir: string | null,
  config: Config,
  adapter: DshHostAdapter,
  operation: 'write' | 'edit',
  target: FsTarget,
): void {
  try {
    if (harnessDir === null) return
    if (!isStatusTarget(harnessDir, target)) return
    const statusPath = join(harnessDir, STATUS_FILE)
    // The adapter owns the shared status-gate core (missing file = first
    // create = pass); this listener adds enforcement + observability.
    const result = adapter.statusGate(statusPath)
    const hard = resolveHard(harnessDir, config)
    const verdict = applyEnforcement(result, { hard })
    if (!verdict.ok) {
      if (verdict.hardBlocked) {
        // Repair escape: the current document is already invalid; this write
        // may BE the repair, so allow it — but make the degraded control
        // loud (error-level log + repair advisory, `hard: true`).
        ctx.logger(LOGGER_NAME).error(
          `status.json ${operation} ALLOWED as repair (Enforcement: hard; the current on-disk document is already invalid — the intent carries no incoming content, so the vetoable signal is only the pre-write state):\n${verdict.violations.map(formatViolation).join('\n')}`,
        )
        ctx.emit('mstar/status-gate', { operation, target: target.displayPath, result: verdict, hard, repair: true })
      } else {
        ctx.logger(LOGGER_NAME).warn(`status.json ${operation} (advisory):\n${verdict.violations.map(formatViolation).join('\n')}`)
        ctx.emit('mstar/status-gate', { operation, target: target.displayPath, result: verdict, hard })
      }
    }
  } catch (error) {
    ctx.logger(LOGGER_NAME).error(`status gate degraded to allow: ${(error as Error).message}`)
    try {
      ctx.emit('mstar/status-gate', { operation, target: target.displayPath, result: { ok: true, violations: [] }, hard: false, degraded: true })
    } catch (emitError) {
      // Best-effort observability: a throwing advisory consumer must not take
      // the gate down with it (the error log above is the durable signal).
      ctx.logger(LOGGER_NAME).error(`status gate degraded advisory emit failed: ${(emitError as Error).message}`)
    }
  }
}

/**
 * `fs/write-intent` listener. Registered with `prepend` so this decider runs
 * BEFORE dsh-fs-policy regardless of mount order: the slot is first-wins by
 * registration order (dsh-fs-policy README), so without prepend a policy
 * plugin mounted earlier would make this gate unreachable. Every gate
 * decision (warn advisory, repair escape, degraded allow) calls `next()` —
 * delegating the observed-state intent decision to the remaining chain
 * (fs-policy when mounted; the bare `undefined` default otherwise) rather
 * than terminating the slot with `undefined` (which would silently disable
 * fs-policy's CAS for status.json in composed deployments).
 */
async function writeIntentListener(
  ctx: Context,
  harnessDir: string | null,
  config: Config,
  adapter: DshHostAdapter,
  target: FsTarget,
  _actor: object | undefined,
  next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>,
): Promise<FsWriteIntent | undefined> {
  gateStatusIntent(ctx, harnessDir, config, adapter, 'write', target)
  return await next()
}

/** `fs/edit-intent` listener — same gate and delegation contract as {@link writeIntentListener}. */
async function editIntentListener(
  ctx: Context,
  harnessDir: string | null,
  config: Config,
  adapter: DshHostAdapter,
  target: FsTarget,
  _actor: object | undefined,
  next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>,
): Promise<{ version: FsVersion } | undefined> {
  gateStatusIntent(ctx, harnessDir, config, adapter, 'edit', target)
  return await next()
}

/**
 * Typed hard-mode veto for the skill lint gate (the dsh fs-policy veto
 * channel: "veto = throw"; the write tool turns the throw into an isError
 * tool result carrying `{ name, code }`). Thrown ONLY by
 * {@link lintSkillWrite} — the entry that lints a KNOWN incoming document
 * (the brief's "against the incoming doc when available" branch). The
 * content-blind `fs/write-intent` listener never throws: it cannot
 * distinguish a repair from a re-violation, so hard mode degrades to the
 * status-gate repair escape there (see {@link gateSkillIntent}).
 */
export class SkillLintVetoError extends Error {
  /** Stable code for tool-result serialization (the `{ name, code }` convention). */
  readonly code = 'skill-lint.veto' as const
  /** The lint violations that caused the veto. */
  readonly violations: readonly ValidationResult[]

  constructor(target: string, violations: readonly ValidationResult[]) {
    super(
      `SKILL.md write to ${target} vetoed by Enforcement: hard — the incoming document fails the skill-authoring lints:\n${violations.map(formatViolation).join('\n')}`,
    )
    this.name = 'SkillLintVetoError'
    this.violations = violations
  }
}

/**
 * Strip a leading `---`-fenced YAML frontmatter block, returning the body
 * (five-question lint takes the body; the frontmatter lint takes the full
 * doc — CLI `mstar skill lint` parity, same semantics).
 */
function stripFrontmatter(text: string): string {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== '---') return text
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return lines.slice(i + 1).join('\n')
  }
  return text
}

/**
 * Lint one SKILL.md document with the engine skill-authoring lints
 * (`lintFrontmatter` + `lintFiveQuestion` — the CLI `mstar skill lint`
 * combination; violation codes `lint.frontmatter.*` /
 * `skill-authoring.five-question.*`). Pure: no enforcement, no I/O.
 * @param doc - the full SKILL.md text.
 */
export function lintSkillDoc(doc: string): GateResult {
  const violations: ValidationResult[] = []
  const frontmatter = lintFrontmatter(doc)
  if (!frontmatter.ok) violations.push(...frontmatter.violations)
  const body = lintFiveQuestion(stripFrontmatter(doc))
  if (!body.ok) violations.push(...body.violations)
  return violations.length === 0 ? { ok: true, violations } : { ok: false, violations }
}

/**
 * Enforce the skill-authoring lints over a KNOWN document (the brief's
 * "incoming doc when available" branch): `Enforcement: hard` + violations →
 * throw the typed {@link SkillLintVetoError} (fs-policy veto channel); warn
 * mode → return the gate for advisory logging. A repairing write carries a
 * VALID incoming document and passes by construction — no repair escape is
 * needed on this branch. The content-blind listener path (where the
 * incoming doc is never visible) routes through {@link gateSkillIntent}
 * instead, which applies the status-gate repair-escape decision.
 * @param doc - the document about to be written (the write's content).
 * @param options - target display path (veto message) + resolved hard flag.
 */
export function lintSkillWrite(doc: string, options: { target: string; hard: boolean }): GateResult {
  const result = lintSkillDoc(doc)
  if (options.hard && !result.ok) {
    throw new SkillLintVetoError(options.target, result.violations)
  }
  return result
}

/**
 * The configured skill roots the lint gate scopes to (Config `skillRoots`
 * custom roots + `bundledSkillDir`, same trim/filter semantics as
 * {@link skillLocalConfig}). Empty when nothing is configured — the gate
 * is inert.
 */
function skillRootsOf(config: Config): string[] {
  const roots = [...(config.skillRoots ?? []), ...(config.bundledSkillDir !== undefined ? [config.bundledSkillDir] : [])]
  return roots.map((root) => root.trim()).filter((root) => root !== '')
}

/**
 * Whether a target is a `SKILL.md` UNDER one of the configured skill roots
 * (resolved-path containment — skill-local shapes `<root>/<name>/SKILL.md`).
 * Matching is by resolved path on `displayPath` (the local backend reports
 * absolute paths; remote/URI backends never resolve under a local root and
 * the gate is inert for them — status-gate discipline).
 */
function isSkillTarget(roots: readonly string[], target: FsTarget): boolean {
  if (basename(target.displayPath) !== 'SKILL.md') return false
  const resolvedPath = resolve(target.displayPath)
  return roots.some((root) => resolvedPath.startsWith(resolve(root) + sep))
}

/** The skill directory name of a SKILL.md target (the canonical skill id). */
function skillNameOf(target: FsTarget): string {
  return basename(dirname(target.displayPath))
}

/** The canonical skill-root form of a SKILL.md target (Task 1 frozen
 * `resolveSkillRoot('dsh', …)` form — `$DSH_BUNDLED_SKILL_DIR/<name>/SKILL.md`). */
function skillCanonicalForm(target: FsTarget): string {
  return resolveSkillRoot('dsh', { skill: skillNameOf(target), rel: 'SKILL.md' })
}

/**
 * Resolve the hard-enforcement flag for the skill lint gate: explicit
 * Config override wins, else the iteration compass frontmatter (when a
 * harness dir resolves), else warn-only. {@link resolveHard} parity with a
 * null-tolerant harness dir — skill roots do not require `{HARNESS_DIR}`.
 */
function resolveSkillHard(harnessDir: string | null, config: Config): boolean {
  if (config.enforcement === 'hard') return true
  if (config.enforcement === 'soft') return false
  return harnessDir !== null && resolveCompassEnforcement(harnessDir).hard
}

/**
 * Gate one fs write-intent on a `SKILL.md` under a configured skill root.
 * The slot is content-blind (the intent waterfall carries only
 * `(target, actor)` — never the incoming content, dsh-private tool-fs
 * write.ts), so the lint signal is the pre-write on-disk document
 * (single-read). Enforcement policy (decided here, documented in
 * task-4-report.md; status-gate repair-escape mirror, qc2 W-001):
 *
 * - missing file → pass (first create has no document to lint);
 * - clean on-disk doc → silent pass (blocking valid-skill writes would
 *   deadlock normal authoring — the slot cannot see the incoming content);
 * - violations + warn mode (default) → warn log + advisory + delegate;
 * - violations + hard mode → REPAIR ESCAPE: the on-disk doc is ALREADY
 *   invalid, so this write may BE the repair — allow with an error-level
 *   log + repair advisory (`hard: true, repair: true`). A hard veto there
 *   would deadlock the repairing write; the typed hard veto lives on the
 *   incoming-doc branch ({@link lintSkillWrite}) where the document is
 *   known.
 *
 * The gate never throws (except the intentional {@link lintSkillWrite}
 * veto on the other branch); unexpected internal errors degrade to allow
 * in BOTH modes with a loud log + `degraded: true` advisory
 * (error-containment envelope — an untyped throw from the gate would
 * spuriously block legitimate writes).
 */
function gateSkillIntent(ctx: Context, harnessDir: string | null, config: Config, target: FsTarget): void {
  try {
    const roots = skillRootsOf(config)
    if (roots.length === 0) return
    if (!isSkillTarget(roots, target)) return
    const skillPath = resolve(target.displayPath)
    if (!existsSync(skillPath)) return // first create — nothing to lint yet
    let doc: string
    try {
      doc = readFileSync(skillPath, 'utf8')
    } catch (error) {
      // Single-read contract: an unreadable on-disk doc is an unexpected
      // error — degrade to allow with a degraded advisory (never a throw).
      ctx.logger(SKILL_LINT_LOGGER).error(`skill lint degraded to allow (cannot read ${skillPath}): ${(error as Error).message}`)
      ctx.emit('mstar/skill-lint', {
        operation: 'write',
        target: target.displayPath,
        canonical: skillCanonicalForm(target),
        result: { ok: true, violations: [] },
        hard: false,
        degraded: true,
      })
      return
    }
    const result = lintSkillDoc(doc)
    if (result.ok) return
    const hard = resolveSkillHard(harnessDir, config)
    // The advisory carries the ENFORCED verdict (status-gate shape:
    // `hardBlocked` true on the hard repair escape — the write would have
    // been blocked, and is allowed as a repair).
    const verdict = applyEnforcement(result, { hard })
    // resolveAssetPath renders the canonical skill-relative asset form
    // (mstar-skill-authoring § Skill-relative script and asset paths) — the
    // fix instruction for the violating file in the log line below.
    const fixHint = resolveAssetPath(skillNameOf(target), 'SKILL.md', 'dsh')
    if (hard) {
      // Repair escape: the current document is already invalid; this write
      // may BE the repair — allow, but make the degraded control loud
      // (error-level log + repair advisory, `hard: true`).
      ctx.logger(SKILL_LINT_LOGGER).error(
        `SKILL.md write to ${target.displayPath} ALLOWED as repair (Enforcement: hard; the current on-disk document is already invalid — the intent carries no incoming content, so the vetoable signal is only the pre-write state):\n${verdict.violations.map(formatViolation).join('\n')}\n${fixHint}`,
      )
      ctx.emit('mstar/skill-lint', { operation: 'write', target: target.displayPath, canonical: skillCanonicalForm(target), result: verdict, hard, repair: true })
    } else {
      ctx.logger(SKILL_LINT_LOGGER).warn(
        `SKILL.md write to ${target.displayPath} (advisory):\n${verdict.violations.map(formatViolation).join('\n')}\n${fixHint}`,
      )
      ctx.emit('mstar/skill-lint', { operation: 'write', target: target.displayPath, canonical: skillCanonicalForm(target), result: verdict, hard })
    }
  } catch (error) {
    ctx.logger(SKILL_LINT_LOGGER).error(`skill lint gate degraded to allow: ${(error as Error).message}`)
    try {
      ctx.emit('mstar/skill-lint', { operation: 'write', target: target.displayPath, canonical: skillCanonicalForm(target), result: { ok: true, violations: [] }, hard: false, degraded: true })
    } catch (emitError) {
      // Best-effort observability: a throwing advisory consumer must not
      // take the gate down with it (the error log above is the durable
      // signal).
      ctx.logger(SKILL_LINT_LOGGER).error(`skill lint degraded advisory emit failed: ${(emitError as Error).message}`)
    }
  }
}

/**
 * `fs/write-intent` listener for the skill lint gate. Registered with
 * `prepend` for the same reachability reason as the status gate: the slot
 * is first-wins by registration order (dsh-fs-policy README), so without
 * prepend a policy plugin mounted earlier would make this gate unreachable.
 * Every gate decision (warn advisory, repair escape, degraded allow) calls
 * `next()` — the skill lint gate never owns the intent decision and must
 * not terminate the chain (fs-policy's observed-state CAS on skill files
 * stays live in composed deployments).
 */
async function skillWriteIntentListener(
  ctx: Context,
  harnessDir: string | null,
  config: Config,
  target: FsTarget,
  _actor: object | undefined,
  next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>,
): Promise<FsWriteIntent | undefined> {
  gateSkillIntent(ctx, harnessDir, config, target)
  return await next()
}

/**
 * True when the text looks like an Assignment (opencode parity: `## Assignment`
 * heading or at least one core field line). Non-Assignment delegation prompts
 * stay silent — no false-positive warnings.
 */
function isAssignmentShaped(assignmentText: string): boolean {
  return ASSIGNMENT_HEADING_RE.test(assignmentText) || assignmentText.match(ASSIGNMENT_FIELD_RE) !== null
}

/**
 * Resolve the hard-enforcement flag for one dispatch: explicit Config override
 * wins, else the Assignment's OWN `Enforcement: hard` header flag (opencode
 * parity — header region only, a body-quoted example never hardens), else the
 * iteration compass frontmatter, else warn-only.
 */
function resolveDispatchHard(harnessDir: string | null, config: Config, assignmentText: string): boolean {
  if (config.enforcement === 'hard') return true
  if (config.enforcement === 'soft') return false
  if (parseEnforcementFlag(assignmentHeaderRegion(assignmentText)).hard) return true
  return harnessDir !== null && resolveCompassEnforcement(harnessDir).hard
}

/** The hard-mode veto reason: one line per violation + the refusal channel. */
function denyReason(tool: string, verdict: GateResult): string {
  return [
    `subagent dispatch (${tool}) blocked by Enforcement: hard — the Assignment fails the dispatch gate`,
    ...verdict.violations.map(formatViolation),
    'refusal channel: tools/pre-execute PreToolDecision { kind: \'deny\' }; skill: mstar-dispatch-gates',
  ].join('\n')
}

/**
 * One lease-gate violation line (dsh-side codes live in the `lease.dispatch.*`
 * namespace; the engine emits `lease.verify.*` / `lease.execution-lease.*`).
 */
function leaseViolation(code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity: 'high', code, message, fix }
}

/**
 * Parse one Assignment HEADER-REGION field value with the engine
 * `parseAssignmentFields` semantics: a `**Field**: value` (bold) or
 * `Field: value` (plain) line, optionally list-bulleted, at line start.
 * Returns the trimmed value or undefined when the field is absent/empty.
 *
 * Callers MUST pass the engine `assignmentHeaderRegion(assignmentText)` slice
 * (qc1 F-001 / qc2 F-003): the engine owns the header/body boundary, so
 * body-quoted field examples after a `# Task` / `# Target` / `---` marker
 * never leak into header fields — the same discipline `resolveDispatchHard`
 * already honors for the Enforcement flag. This module keeps no second
 * grammar for the boundary (qc1 S-002).
 *
 * @param headerRegion - `assignmentHeaderRegion(assignmentText)`, never the raw text.
 * @param label - the header field label to read (e.g. `Plan Path`).
 */
function assignmentHeaderValue(headerRegion: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const bold = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?\\*\\*\\s*${escaped}\\s*\\*\\*[ \\t]*:[ \\t]*(.*)$`, 'm')
  const plain = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${escaped}[ \\t]*:[ \\t]*(.*)$`, 'm')
  const line = headerRegion.match(bold)?.[1] ?? headerRegion.match(plain)?.[1]
  if (line === undefined) return undefined
  const value = line.trim()
  return value === '' ? undefined : value
}

/** First whitespace-delimited token of a header value (paths in this convention never contain spaces). */
function firstToken(value: string): string | undefined {
  const token = value.split(/\s+/)[0]
  return token === '' ? undefined : token
}

/** A header value that means "no value" (placeholder conventions). Type guard so callers narrow to `string`. */
function isNaValue(value: string | undefined): value is undefined {
  return value === undefined || /^(?:n\/?a|none)$/i.test(value)
}

/**
 * Resolve the target plan id from the Assignment HEADER region: `Plan Path`
 * basename (`.md` stripped), else `SDD dir` basename, else a `plan_id` field.
 * @param headerRegion - `assignmentHeaderRegion(assignmentText)` (qc1 F-001:
 * only the header is read — a plan path quoted in the task body never
 * resolves a plan id).
 */
function planIdOf(headerRegion: string): string | undefined {
  const planPath = assignmentHeaderValue(headerRegion, 'Plan Path')
  if (!isNaValue(planPath)) {
    const id = basename(firstToken(planPath) ?? '')
    return id.endsWith('.md') ? id.slice(0, -3) : id
  }
  const sddDir = assignmentHeaderValue(headerRegion, 'SDD dir')
  if (!isNaValue(sddDir)) {
    const id = basename(firstToken(sddDir) ?? '')
    return id === '' ? undefined : id
  }
  const planId = assignmentHeaderValue(headerRegion, 'plan_id')
  return isNaValue(planId) ? undefined : planId
}

/** The dispatching session's stable id, when the seam exposes it (dsh Agent.id). */
function sessionIdOf(exec: ToolExecution): string | undefined {
  const agent = asRecord(exec.agent)
  const id = agent?.id
  return typeof id === 'string' && id.trim() !== '' ? id : undefined
}

/**
 * Lease gate (Task 5) — ADDITIVE beyond the opencode parity field set:
 * opencode's `validateDispatchAssignment` does NOT run lease checks at
 * dispatch, so every violation emitted here is dsh-only and clearly scoped:
 * the check fires ONLY for WRITABLE dispatches whose Assignment declares
 * `Execution mode: sdd` (engine `executionModeToN` semantics — sdd maps to
 * N=3; the function's violation path is intentionally unused so
 * `dispatch.execution-mode.*` codes stay out of the parity field set) OR
 * whose plan row is `InProgress`.
 *
 * Contract (status-and-residuals.md § Pre-dispatch re-verify): before any
 * writable implement dispatch, reread `{HARNESS_DIR}/status.json` and confirm
 * the session still passes verify-held-lease — `holder`, `worktree_path` and
 * `working_branch` must match the Assignment; mismatch or absent lease →
 * STOP. Engine `verifyPlanExecutionLease` + `validateExecutionLease` carry
 * the presence/shape checks (missing / orphan / dual-write / non-ssot /
 * invalid fields); the dispatch-context comparisons (holder vs the
 * dispatching session, worktree and branch vs the Assignment) are dsh-side.
 *
 * Degrade-allow cases (no false positives): no harness dir, unresolvable plan
 * id, and non-SDD assignments whose plan row is absent or not InProgress.
 * Unverifiable lease states (malformed status.json, MISSING status.json, plan
 * row not registered) are violations ONLY for sdd dispatches (the lease state
 * cannot be confirmed — the status gate already guards the next write);
 * unreadable docs never harden a soft workflow. Missing status.json is NOT a
 * silent fail-open for sdd (qc2 W-002): the claim-before-InProgress red line
 * needs the plan's execution_lease, and a missing status file cannot confirm
 * it — `lease.dispatch.unverifiable` fires (advisory in warn, deny under hard).
 */
function leaseGateViolations(
  harnessDir: string | null,
  exec: ToolExecution,
  writable: boolean | undefined,
  prompt: string,
): ValidationResult[] {
  if (harnessDir === null || writable === false) return []
  const header = assignmentHeaderRegion(prompt)
  const mode = assignmentHeaderValue(header, 'Execution mode')
  const sdd = executionModeToN(mode ?? '').n === 3
  const planId = planIdOf(header)
  if (planId === undefined || planId === '') return []
  const statusPath = join(harnessDir, STATUS_FILE)
  if (!existsSync(statusPath)) {
    if (!sdd) return []
    return [leaseViolation(
      'lease.dispatch.unverifiable',
      `${statusPath} is missing — the plan's execution_lease state is unverifiable; STOP before writable dispatch`,
      'create a valid status.json registering the plan row (first implement dispatch requires a plan row)',
    )]
  }

  let doc: StatusDoc
  try {
    doc = readJson(statusPath) as StatusDoc
  } catch (error) {
    if (!sdd) return []
    return [leaseViolation(
      'lease.dispatch.unreadable',
      `cannot read ${statusPath}: ${(error as Error).message} — the plan's execution_lease state is unverifiable; STOP before writable dispatch`,
      'restore a valid status.json (the status gate refuses invalid writes)',
    )]
  }

  const row = Array.isArray(doc.plans)
    ? doc.plans.map(asRecord).find((r) => r?.id === planId || r?.plan_id === planId)
    : undefined
  if (row === undefined) {
    if (!sdd) return []
    return [leaseViolation(
      'lease.dispatch.plan-not-found',
      `plan ${planId} is not registered in ${STATUS_FILE} — cannot verify its execution_lease before writable dispatch`,
      'register the plan row in status.json (first implement dispatch requires a plan row)',
    )]
  }
  if (!sdd && row.status !== 'InProgress') return []

  const verify = verifyPlanExecutionLease(row, planId)
  const violations = [...verify.violations]
  const lease = asRecord(verify.lease)
  // Dispatch-context comparisons need a structurally valid lease — the shape
  // violations (when present) already surfaced above; skip comparisons so raw
  // fields of a broken lease never produce misleading mismatch noise.
  if (lease !== undefined && validateExecutionLease(lease).ok) {
    const sessionId = sessionIdOf(exec)
    // Holder contract (qc3 F-4): `lease.holder` must be recorded as the dsh
    // Agent.id this dispatch runs under. The mstar control-side holder
    // convention is `<host>:<stable-session-id>` — a lease claimed under that
    // vocabulary against a bare dsh agent id is a deliberate fail-closed
    // mismatch (no-steal): deployments must record leases with the dsh agent
    // id, not the control-side session id.
    if (sessionId !== undefined && lease.holder !== sessionId) {
      violations.push(leaseViolation(
        'lease.dispatch.holder-mismatch',
        `execution_lease.holder "${String(lease.holder)}" differs from this session "${sessionId}" — the active lease belongs to another agent; no-steal: STOP, do not dispatch`,
        'dispatch only from the lease-holding session (or release/override the lease with user authorization + audit note)',
      ))
    }
    const worktree = assignmentHeaderValue(header, 'Worktree path')
    const wt = worktree === undefined ? undefined : firstToken(worktree)
    if (isNaValue(wt)) {
      violations.push(leaseViolation(
        'lease.dispatch.worktree-mismatch',
        'Assignment declares no Worktree path — cannot confirm this dispatch matches execution_lease.worktree_path',
        'add the absolute Worktree path to the Assignment (must equal the lease worktree_path)',
      ))
    } else if (resolve(wt) !== resolve(String(lease.worktree_path ?? ''))) {
      violations.push(leaseViolation(
        'lease.dispatch.worktree-mismatch',
        `Assignment Worktree path "${wt}" differs from execution_lease.worktree_path "${String(lease.worktree_path)}"`,
        'align the Assignment with the lease worktree path (or update the lease)',
      ))
    }
    const forms = parseAssignmentBranchForms(header)
    const branch = forms.createForm?.name ?? forms.workingBranch ?? forms.directOn?.branch
    if (branch !== undefined && branch !== lease.working_branch) {
      violations.push(leaseViolation(
        'lease.dispatch.branch-mismatch',
        `Assignment Working branch "${branch}" differs from execution_lease.working_branch "${String(lease.working_branch)}"`,
        'align the Assignment with the lease working branch (or update the lease)',
      ))
    }
  }
  return violations
}

/**
 * The dispatch-gate validation core (opencode `validateDispatchAssignment`
 * parity — the SAME engine fns, so violation codes are identical): the field
 * gate (`validateAssignmentFields`; read-only roles skip the branch gate),
 * the anti-recursion precheck (Config binding) and the default-branch gate.
 * Extracted from `gateDispatch` so the `tools/pre-execute` listener and the
 * host adapter's `beforeDispatch` share ONE code path. The lease gate is NOT
 * here — it binds the ToolExecution context (session id) and joins via
 * {@link DshHostAdapter.dispatchGate} when the listener passes `exec`.
 *
 * @returns the violations plus the writable flag (false for read-only
 * roles — the listener feeds it to the lease gate).
 */
function dispatchGateCore(
  harnessDir: string | null,
  config: Config,
  prompt: string,
): { violations: ValidationResult[]; writable: boolean | undefined } {
  const violations: ValidationResult[] = []
  const fields = parseAssignmentFields(prompt)
  // Read-only roles (scout/explore) skip the branch-form gate entirely.
  const writable = isReadOnlyAssignmentRole(fields.executeAs ?? '') ? false : undefined
  violations.push(...validateAssignmentFields(prompt, { writable }).violations)
  // Anti-recursion NEVER red line — binding = the dispatching agent's own
  // type (Config-declared; dsh exposes no agent role on the execution context).
  const binding = config.dispatchBinding ?? ''
  if (binding.trim() !== '') {
    violations.push(...antiRecursionPrecheck(binding, fields.executeAs ?? '').violations)
  }
  // Default-branch gate — the checked branch comes from the Assignment's own
  // branch forms, else $MSTAR_WORKING_BRANCH (opencode parity); the direct-on
  // exception is honored only when its branch is the one being checked.
  if (writable !== false) {
    const forms = parseAssignmentBranchForms(prompt)
    const branch = forms.createForm?.name ?? forms.workingBranch ?? forms.directOn?.branch ?? process.env.MSTAR_WORKING_BRANCH
    if (branch !== undefined && branch.trim() !== '') {
      const directOnException = parseBranchPolicyDirectOnBranch(prompt) === branch.trim()
      violations.push(...assertDefaultBranchProtected(branch.trim(), { directOnException }).violations)
    }
  }
  return { violations, writable }
}

/**
 * Run the dispatch gate over one delegation tool call (opencode
 * `validateDispatchAssignment` parity — the SAME engine fns, so violation
 * codes are identical). Returns the veto decision in hard mode, undefined
 * otherwise (warn mode: log + advisory emit; the caller delegates via `next()`).
 * Non-subagent tools, non-Assignment prompts and malformed payloads are pure
 * pass-through (undefined).
 */
function gateDispatch(
  ctx: Context,
  harnessDir: string | null,
  config: Config,
  adapter: DshHostAdapter,
  exec: ToolExecution,
): PreToolDecision | undefined {
  const toolName = exec.name
  if (!(config.dispatchTools ?? [...DEFAULT_DISPATCH_TOOLS]).includes(toolName)) return undefined
  const args = asRecord(exec.arguments)
  const prompt = typeof args?.prompt === 'string' ? args.prompt : undefined
  if (prompt === undefined || !isAssignmentShaped(prompt)) return undefined

  // The adapter owns the shared dispatch-gate core; the exec context is
  // passed so the lease gate (session-id bound — see leaseGateViolations)
  // joins the SAME verdict as the field/branch/anti-recursion checks.
  const result = adapter.dispatchGate(prompt, exec)
  const hard = resolveDispatchHard(harnessDir, config, prompt)
  const verdict = applyEnforcement(result, { hard })
  if (verdict.hardBlocked) {
    ctx.logger(DISPATCH_LOGGER).error(
      `subagent dispatch (${toolName}) vetoed (Enforcement: hard):\n${verdict.violations.map(formatViolation).join('\n')}`,
    )
    return { kind: 'deny', reason: denyReason(toolName, verdict) }
  }
  if (!verdict.ok) {
    ctx.logger(DISPATCH_LOGGER).warn(
      `subagent dispatch (${toolName}) (advisory):\n${verdict.violations.map(formatViolation).join('\n')}`,
    )
    const role = parseAssignmentFields(prompt).executeAs ?? ''
    ctx.emit('mstar/dispatch-gate', { tool: toolName, role, result: verdict, hard })
  }
  return undefined
}

/**
 * `tools/pre-execute` listener. The waterfall refusal channel is the returned
 * decision: a deny is returned WITHOUT calling `next()` (short-circuits the
 * chain — downstream listeners and the registry default never run); every
 * other path calls `next()` to delegate (the registry's default is
 * `{ kind: 'allow' }`). Engine failures degrade to allow in BOTH modes (hard
 * gates are opt-in — an engine failure must not harden a workflow that was
 * soft; opencode parity) but the degrade is NEVER silent (qc2 W-003): the
 * catch path emits the plugin-owned `mstar/dispatch-gate` advisory with
 * `degraded: true` + an error log, so a hard deployment can detect a dead
 * control instead of only finding it in logs. `next()` itself is invoked
 * outside the guard so a downstream rejection propagates untouched.
 */
async function preExecuteListener(
  ctx: Context,
  harnessDir: string | null,
  config: Config,
  adapter: DshHostAdapter,
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>,
): Promise<PreToolDecision> {
  let veto: PreToolDecision | undefined
  try {
    veto = gateDispatch(ctx, harnessDir, config, adapter, exec)
  } catch (error) {
    ctx.logger(DISPATCH_LOGGER).error(`dispatch gate aborted (degraded, dispatch allowed): ${(error as Error).message}`)
    try {
      ctx.emit('mstar/dispatch-gate', { tool: exec.name, role: '', result: { ok: true, violations: [] }, hard: false, degraded: true })
    } catch (emitError) {
      // Best-effort observability: a throwing advisory consumer must not take
      // the gate down with it (the error log above is the durable signal).
      ctx.logger(DISPATCH_LOGGER).error(`dispatch gate degraded advisory emit failed: ${(emitError as Error).message}`)
    }
  }
  return veto ?? await next()
}

/**
 * Rebuild the canonical Assignment HEADER text from parsed fields (the
 * engine's OWN header grammar — `parseAssignmentFields` reads exactly these
 * labels — so the engine parsers round-trip losslessly). The host hook's
 * engine-typed input is `AssignmentFields`; the shared gate core validates
 * assignment TEXT, so the fields form is normalized to text before gating.
 */
function assignmentTextFromFields(fields: AssignmentFields): string {
  const lines = ['## Assignment', '']
  if (fields.executeAs !== undefined) lines.push(`**Execute as**: ${fields.executeAs}`)
  if (fields.delegation !== undefined) lines.push(`**Delegation**: ${fields.delegation}`)
  if (fields.taskCategory !== undefined) lines.push(`**Task category**: ${fields.taskCategory}`)
  if (fields.workingBranch !== undefined) lines.push(`**Working branch**: ${fields.workingBranch}`)
  if (fields.branchPolicy !== undefined) lines.push(`**Branch policy**: ${fields.branchPolicy}`)
  return lines.join('\n')
}

/**
 * Build the dsh skill-local registration payload from the plugin Config
 * (roadmap D6 — single canonical mount). Semantics mirror the skill-local
 * `Config` contract: `skillRoots` → `customSkillDirs` (custom roots),
 * `bundledSkillDir` → `bundledSkillDir` (bundled root). The provider is
 * named `mstar` and default roots are excluded (`includeDefaultRoots: false`
 * — the repository-plugin convention: an isolated provider must see only its
 * explicit roots, so the mstar mount never claims the host app's own skills;
 * without this the app's user/project skills would be re-discovered under
 * the mstar provider). Returns `undefined` when nothing is configured — no
 * registration happens.
 * @param config - validated plugin configuration.
 */
export function skillLocalConfig(config: Config): SkillLocalConfig | undefined {
  const customSkillDirs = config.skillRoots?.map((root) => root.trim()).filter((root) => root !== '')
  const bundledSkillDir = config.bundledSkillDir?.trim()
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

/** Options for {@link DshHostAdapter}. */
export interface DshHostAdapterOptions {
  /** Resolved `{HARNESS_DIR}` (null when probing found none — gates stay inert). */
  readonly harnessDir: string | null
  /** The plugin Config the gates resolve enforcement + anti-recursion binding from. */
  readonly config: Config
  /**
   * Log sink for `HostAdapter.log`. Defaults to the dsh ctx logger scoped
   * `mstar/host-adapter` (dsh logger naming: `<scope>/<subject>`).
   */
  readonly log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

/**
 * The plugin's `HostAdapter` implementation (engine `host.ts` type-only
 * contract, roadmap §8.4) — the HOST-FACING facade over the P1 gate
 * internals: `host: 'dsh'`, `log` → dsh ctx logger, and the optional hooks
 * wired to the SAME code paths the in-plugin gates use, so host hooks and
 * gates share ONE validation path:
 *
 * - `beforeStatusWrite(path, doc)` — validates the incoming document when
 *   the host provides it (the write's content — the opencode consumer
 *   convention for this engine hook), else the current on-disk document at
 *   `path` via the gate's single-read `validateStatusDoc` semantics (missing
 *   file = first create = pass). Both inputs flow through
 *   `validateStatusValue` — the same pipeline the fs-intent gate runs, so
 *   codes match by construction. Returns the FIRST violation: the engine
 *   hook shape is one `ValidationResult`; the gate's full violation list
 *   stays available on the fs-intent slot.
 * - `beforeDispatch(assignment)` — the dispatch gate validation path
 *   (validateAssignmentFields + branch gate + anti-recursion; read-only
 *   roles skip the branch gate). The lease gate stays listener-side: it
 *   binds the ToolExecution context (session id) this hook's contract does
 *   not carry. The parsed `AssignmentFields` form is normalized to the
 *   engine's own header grammar (lossless — the parsers read exactly these
 *   labels) and gated through the same text path. Enforcement is applied
 *   like the listener (opencode parity): the returned GateResult carries
 *   `hardBlocked` so a refusal-capable host can refuse the dispatch.
 * - `beforeMerge(lease)` — thin wrapper over the engine
 *   `validateIntegrationMergeLease` (reserve/validate the integration merge
 *   lease; the reservation WRITE into status.json is a P3 seam).
 */
export class DshHostAdapter extends Service implements HostAdapter {
  /** Engine host identity (roadmap §8.4 `HostId` union). */
  readonly host = 'dsh' as const

  private readonly harnessDir: string | null
  private readonly config: Config
  private readonly logSink: (level: 'info' | 'warn' | 'error', msg: string) => void

  constructor(ctx: Context, options: DshHostAdapterOptions) {
    // Provided as a dsh service (`ctx.dshHostAdapter`, same convention as
    // `ctx.dshMstar`): construction self-registers on the fiber.
    super(ctx, 'dshHostAdapter')
    this.harnessDir = options.harnessDir
    this.config = options.config
    this.logSink = options.log ?? ((level, msg) => {
      const logger = ctx.logger(HOST_LOGGER)
      if (level === 'warn') logger.warn(msg)
      else if (level === 'error') logger.error(msg)
      else logger.info(msg)
    })
  }

  /**
   * `HostAdapter.log` — the adapter's own reporting channel (the gates keep
   * their scoped loggers; this is the host-facing sink).
   * @param level - log level.
   * @param msg - message.
   */
  log(level: 'info' | 'warn' | 'error', msg: string): void {
    this.logSink(level, msg)
  }

  /**
   * Shared status-gate core (plugin-internal): the fs-intent listeners and
   * the `beforeStatusWrite` on-disk fallback route through this method —
   * ONE validation code path. Missing file = first create = pass (the
   * intent waterfall carries no incoming content, so the vetoable signal is
   * the pre-write on-disk state, qc3 F-1).
   * @param statusPath - the canonical `{HARNESS_DIR}/status.json` path.
   */
  statusGate(statusPath: string): GateResult {
    if (!existsSync(statusPath)) return { ok: true, violations: [] }
    return validateStatusDoc(statusPath)
  }

  /**
   * Shared dispatch-gate core (plugin-internal): the `tools/pre-execute`
   * listener and `beforeDispatch` route through this method — ONE
   * validation code path (field gate + anti-recursion + branch gate;
   * read-only roles skip the branch gate). The listener passes `exec` so
   * the lease gate (ToolExecution-bound: session id, in-flight call) joins
   * the same verdict; the host hook has no exec context and covers the
   * field/branch/anti-recursion path.
   * @param prompt - the Assignment text (engine header grammar).
   * @param exec - the in-flight delegation tool call (listener path only).
   */
  dispatchGate(prompt: string, exec?: ToolExecution): GateResult {
    const { violations, writable } = dispatchGateCore(this.harnessDir, this.config, prompt)
    if (exec !== undefined) {
      violations.push(...leaseGateViolations(this.harnessDir, exec, writable, prompt))
    }
    return { ok: violations.length === 0, violations }
  }

  /**
   * `HostAdapter.beforeStatusWrite` — see the class doc for the doc-first /
   * on-disk-fallback semantics. Never throws; a failing gate maps to its
   * FIRST violation (severity/code/message/fix/aliases preserved — failing
   * gates always carry ≥1 violation), a passing gate to
   * `host.beforeStatusWrite.ok` (the engine test convention for this hook).
   * @param path - the status.json target path.
   * @param doc - the document about to be written (undefined → validate the
   * on-disk document at `path`).
   */
  async beforeStatusWrite(path: string, doc: unknown): Promise<ValidationResult> {
    const gate = doc !== undefined ? validateStatusValue(doc) : this.statusGate(path)
    if (!gate.ok) {
      const first = gate.violations[0]!
      return { ok: false, severity: first.severity, code: first.code, message: first.message, fix: first.fix, aliases: first.aliases }
    }
    return { ok: true, severity: 'low', code: 'host.beforeStatusWrite.ok', message: `status write to ${path} validated` }
  }

  /**
   * `HostAdapter.beforeDispatch` — the dispatch gate validation path (see
   * the class doc). Accepts the raw Assignment text (full fidelity: the
   * `Enforcement` header flag participates in enforcement resolution) or the
   * parsed `AssignmentFields` (engine-typed hook input; normalized to the
   * engine's header grammar before gating). Returns the enforced GateResult
   * — `hardBlocked` mirrors the `tools/pre-execute` deny decision under the
   * same enforcement resolution.
   * @param assignment - raw Assignment text or parsed header fields.
   */
  async beforeDispatch(assignment: AssignmentFields | string): Promise<GateResult> {
    const prompt = typeof assignment === 'string' ? assignment : assignmentTextFromFields(assignment)
    const gate = this.dispatchGate(prompt)
    return applyEnforcement(gate, { hard: resolveDispatchHard(this.harnessDir, this.config, prompt) })
  }

  /**
   * `HostAdapter.beforeMerge` — reserve/validate the integration merge
   * lease. Thin wrapper over the engine `validateIntegrationMergeLease`
   * (the engine owns the lease shape; the reservation write into
   * `{HARNESS_DIR}/status.json` is a P3 seam).
   * @param lease - the `metadata.integration_merge_lease` object.
   */
  async beforeMerge(lease: IntegrationMergeLease): Promise<GateResult> {
    return validateIntegrationMergeLease(lease)
  }
}

/**
 * Apply the plugin to the registrant context: resolve `{HARNESS_DIR}` via the
 * engine, expose the engine surface as `ctx.dshMstar`, construct the host
 * adapter (the gates route through it — one code path with the host hooks),
 * and register the status gate on the fs intent waterfalls + the dispatch
 * gate on `tools/pre-execute`.
 *
 * Layering (qc1 F-002): the gates are co-located engine wrappers in this
 * module importing `@mstar-harness/engine` directly (same plugin, engine
 * bundled at build time); `ctx.dshMstar` is the composition/test façade for
 * future inject consumers (catalogs) — see the README Service section; the
 * adapter is the host-facing facade. The engine is the single grammar for
 * both paths.
 * @param ctx - Cordis context of the composed app.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const harnessDir = resolveHarnessDir(process.cwd(), { harnessDir: config.harnessDir })
  // The Service constructor registers itself on the fiber via reflect.provide,
  // so construction alone exposes `ctx.dshMstar` (dsh service convention).
  new DshMstar(ctx, { harnessDir: harnessDir ?? null })
  // The host-facing HostAdapter facade — the fs-intent / pre-execute gates
  // route through it (host hooks and in-plugin gates share ONE code path).
  // Constructed as a dsh service: `ctx.dshHostAdapter` is available to
  // inject consumers and host hooks after boot.
  const adapter = new DshHostAdapter(ctx, { harnessDir, config })

  // Skills mount — single canonical mount (roadmap D6): register configured
  // skill roots with the dsh skill-local provider contract. The object form
  // mirrors the module shape the dsh Loader composes for the real
  // `@deepseek-ai/dsh-skill-local` package (`{ name, inject, Config, apply }`),
  // so `inject: ['skills']` defers the child fiber until `ctx.skills` exists
  // regardless of mount order. Dev-time the seam package is a peer stub (no
  // real runtime) — this call is the contract-typed registration; real-runtime
  // composition is verified at P3 e2e (README Known Limitations).
  const skillConfig = skillLocalConfig(config)
  if (skillConfig !== undefined) {
    ctx.plugin(
      { name: skillLocalName, inject: skillLocalInject, Config: SkillLocalSchema, apply: applySkillLocal },
      skillConfig,
    )
  }

  // Deploy-time observability (qc2 S-002): when enforcement resolves hard but
  // no dispatchBinding is declared, the anti-recursion red line is off by
  // construction — surface the absence instead of only documenting it.
  const effectiveHard = config.enforcement === 'hard' || (harnessDir !== null && resolveCompassEnforcement(harnessDir).hard)
  if (effectiveHard && (config.dispatchBinding ?? '').trim() === '') {
    ctx.logger(DISPATCH_LOGGER).warn(
      'Enforcement: hard is active but dispatchBinding is unset — the anti-recursion precheck is skipped (an Assignment whose Execute as equals the dispatching agent cannot be detected)',
    )
  }

  // Status gate — fs intent slot (single-slot waterfall; prepend so this
  // decider runs before dsh-fs-policy regardless of mount order).
  ctx.on('fs/write-intent', (target, actor, next) => writeIntentListener(ctx, harnessDir, config, adapter, target, actor, next), { prepend: true })
  ctx.on('fs/edit-intent', (target, actor, next) => editIntentListener(ctx, harnessDir, config, adapter, target, actor, next), { prepend: true })

  // Skill-authoring lint gate — fs/write-intent slot scoped to SKILL.md
  // under the configured skill roots (Task 4; same single-slot waterfall +
  // prepend + next() delegation contract as the status gate — this gate
  // also never throws except the intentional incoming-doc veto in
  // `lintSkillWrite`).
  ctx.on('fs/write-intent', (target, actor, next) => skillWriteIntentListener(ctx, harnessDir, config, target, actor, next), { prepend: true })

  // Dispatch gate — tools/pre-execute waterfall (refusal channel:
  // PreToolDecision.deny returned without next()). Registered prepend for the
  // same reachability reason as the fs slots (qc2 S-001): an earlier-mounted
  // listener that returns a decision without next() would short-circuit the
  // chain and make this security gate unreachable — "a deny short-circuits
  // regardless of order" holds only once the listener is reached.
  ctx.on('tools/pre-execute', (exec, next) => preExecuteListener(ctx, harnessDir, config, adapter, exec, next), { prepend: true })
}
