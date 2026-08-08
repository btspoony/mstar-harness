/**
 * Morning Star harness gates for the DeepSeek Harness SDK (dsh).
 *
 * Cordis function plugin: named exports only — the dsh Loader discards the plugin's namespace
 * (dropping `inject` metadata) when a default export is present, so this module never
 * default-exports. Registrations happen through `ctx` effects/events in `apply`.
 *
 * @module @mstar-harness/dsh
 */

import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { Context } from 'cordis'
import z from 'schemastery'
import {
  applyEnforcement,
  findingsCleanupGate,
  readJson,
  resolveCompassEnforcement,
  resolveHarnessDir,
  validateStatus,
} from '@mstar-harness/engine'
import type { GateResult, StatusDoc, ValidationResult } from '@mstar-harness/engine'
import type { FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { DshMstar } from './service.ts'

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
}

/** Schemastery configuration schema for the plugin consumer. Object keys are optional by default (`.optional()` is a vendored-fork addition not present in npm schemastery). */
export const Config: z<Config> = z.object({
  harnessDir: z.string(),
  enforcement: z.union(['hard', 'soft']),
})

/**
 * Typed veto thrown by the status gate's hard path. Rejects the
 * `fs/write-intent`/`fs/edit-intent` waterfall — the dsh fs intent slot has no
 * deny shape, so a throw IS the refusal channel (dsh-fs-policy README; the
 * tool surfaces it as an `isError` tool result carrying `{ name, code }`).
 */
export class StatusGateError extends Error {
  /** Stable machine code for the veto (tool-result `code`). */
  readonly code = 'STATUS_GATE_HARD_BLOCK' as const
  /** Which intent slot was vetoed. */
  readonly operation: 'write' | 'edit'
  /** `displayPath` of the guarded file. */
  readonly target: string
  /** The gate verdict that hardened (`hardBlocked: true`). */
  readonly result: GateResult

  constructor(operation: 'write' | 'edit', target: string, result: GateResult) {
    super([
      `status.json ${operation} blocked by Enforcement: hard — the current document fails the status gate`,
      ...result.violations.map(formatViolation),
      'refusal channel: fs intent waterfall (veto = throw); skill: mstar-plan-artifacts/references/status-and-residuals.md',
    ].join('\n'))
    this.name = 'StatusGateError'
    this.operation = operation
    this.target = target
    this.result = result
  }
}

/**
 * Advisory emitted on warn-mode gate passes (the plan's "emit `agent/status`
 * (advisory)" step). Named `mstar/status-gate` instead: the dsh `agent/status`
 * event is a lifecycle-only channel (`{ agent, status }`, idle ⇄ running, with
 * an invariant rejecting no-op transitions) — emitting gate warnings on it
 * would violate the seam contract. Consumers (later tasks, catalogs) observe
 * this event for model-visible/session-log surfacing.
 */
export interface StatusGateAdvisory {
  /** Which intent slot passed the gate. */
  operation: 'write' | 'edit'
  /** `displayPath` of the guarded file. */
  target: string
  /** The gate verdict (warn-mode: `hardBlocked` is false). */
  result: GateResult
  /** Whether hard enforcement is on (advisory events are warn-mode by construction). */
  hard: boolean
}

declare module 'cordis' {
  interface Events {
    /**
     * Advisory: a `{HARNESS_DIR}/status.json` write/edit intent passed the
     * status gate in warn mode (violations logged, write allowed). Emitted
     * only when the current document has violations; clean passes stay silent.
     * @param payload - the gate verdict and target.
     * @mode emit
     */
    'mstar/status-gate'(payload: StatusGateAdvisory): void
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
 * Run the status gate over the CURRENT on-disk document. The fs intent
 * waterfall carries only `(target, actor)` — never the incoming content — so
 * the vetoable check is the pre-write state (the opencode hook's fallback for
 * the same reason). A missing file (first create) has no document to validate
 * and passes. `findingsCleanupGate` runs per plan row that CONFIGURES a mode
 * (`plans[].metadata.findings_cleanup`); schema violations short-circuit it
 * (the doc must parse for the cleanup gate to be meaningful).
 */
function validateStatusDoc(harnessDir: string, statusPath: string): GateResult {
  const base = validateStatus(statusPath)
  if (!base.ok) return base
  // base.ok proves the file parsed as JSON, so the second read cannot throw.
  const doc = readJson(statusPath) as StatusDoc
  const violations: ValidationResult[] = []
  for (const row of Array.isArray(doc.plans) ? doc.plans : []) {
    const metadata = asRecord(row.metadata)
    const mode = metadata?.['findings_cleanup']
    if (mode !== 'zero-residual' && mode !== 'allow-residual') continue
    const planId = typeof row.id === 'string' ? row.id : typeof row.plan_id === 'string' ? row.plan_id : undefined
    if (planId === undefined) continue
    violations.push(...findingsCleanupGate(doc, planId, { mode }).violations)
  }
  if (violations.length === 0) return base
  return { ok: false, violations }
}

/**
 * Gate one fs intent on `{HARNESS_DIR}/status.json`. Warn mode (default):
 * log + advisory emit + delegate; hard mode: log + throw the typed veto.
 * Non-status targets and absent documents are pure pass-through.
 */
function gateStatusIntent(
  ctx: Context,
  harnessDir: string | null,
  config: Config,
  operation: 'write' | 'edit',
  target: FsTarget,
): void {
  if (harnessDir === null) return
  if (!isStatusTarget(harnessDir, target)) return
  const statusPath = join(harnessDir, STATUS_FILE)
  if (!existsSync(statusPath)) return // first create: nothing to validate
  const result = validateStatusDoc(harnessDir, statusPath)
  const hard = resolveHard(harnessDir, config)
  const verdict = applyEnforcement(result, { hard })
  if (verdict.hardBlocked) {
    ctx.logger(LOGGER_NAME).error(`status.json ${operation} vetoed (Enforcement: hard):\n${verdict.violations.map(formatViolation).join('\n')}`)
    throw new StatusGateError(operation, target.displayPath, verdict)
  }
  if (!verdict.ok) {
    ctx.logger(LOGGER_NAME).warn(`status.json ${operation} (advisory):\n${verdict.violations.map(formatViolation).join('\n')}`)
    ctx.emit('mstar/status-gate', { operation, target: target.displayPath, result: verdict, hard })
  }
}

/**
 * `fs/write-intent` listener. Registered with `prepend` so this decider runs
 * BEFORE dsh-fs-policy regardless of mount order: the slot is first-wins by
 * registration order (dsh-fs-policy README), so without prepend a policy
 * plugin mounted earlier would make this gate unreachable. Non-vetoed intents
 * call `next()` — delegating the observed-state intent decision to the
 * remaining chain (fs-policy when mounted; the bare `undefined` default
 * otherwise) rather than terminating the slot with `undefined` (which would
 * silently disable fs-policy's CAS for status.json in composed deployments).
 */
async function writeIntentListener(
  ctx: Context,
  harnessDir: string | null,
  config: Config,
  target: FsTarget,
  _actor: object | undefined,
  next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>,
): Promise<FsWriteIntent | undefined> {
  gateStatusIntent(ctx, harnessDir, config, 'write', target)
  return await next()
}

/** `fs/edit-intent` listener — same gate and delegation contract as {@link writeIntentListener}. */
async function editIntentListener(
  ctx: Context,
  harnessDir: string | null,
  config: Config,
  target: FsTarget,
  _actor: object | undefined,
  next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>,
): Promise<{ version: FsVersion } | undefined> {
  gateStatusIntent(ctx, harnessDir, config, 'edit', target)
  return await next()
}

/**
 * Apply the plugin to the registrant context: resolve `{HARNESS_DIR}` via the
 * engine, expose the engine surface as `ctx.dshMstar`, and register the status
 * hard gate on the fs intent waterfalls.
 * @param ctx - Cordis context of the composed app.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const harnessDir = resolveHarnessDir(process.cwd(), { harnessDir: config.harnessDir })
  // The Service constructor registers itself on the fiber via reflect.provide,
  // so construction alone exposes `ctx.dshMstar` (dsh service convention).
  new DshMstar(ctx, { harnessDir: harnessDir ?? null })

  // Status hard gate — fs intent slot (single-slot waterfall; prepend so this
  // decider runs before dsh-fs-policy regardless of mount order).
  ctx.on('fs/write-intent', (target, actor, next) => writeIntentListener(ctx, harnessDir, config, target, actor, next), { prepend: true })
  ctx.on('fs/edit-intent', (target, actor, next) => editIntentListener(ctx, harnessDir, config, target, actor, next), { prepend: true })
}
