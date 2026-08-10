/**
 * Status gate — `{HARNESS_DIR}/status.json` fs-intent gating (plan
 * `20260810-dsh-entry-split` §8 extraction).
 *
 * The gate runs on `fs/write-intent` / `fs/edit-intent` (registered by the
 * entry `apply` with `prepend`), sharing ONE validation code path with the
 * host adapter's `beforeStatusWrite` hook (`validateStatusValue` /
 * `validateStatusDoc` are the module's wiring exports for the adapter).
 * Enforcement is the status-gate repair-escape contract: the intent waterfall
 * carries no incoming content, so hard mode with an ALREADY-invalid document
 * allows the write as a repair (loud error log + `repair: true` advisory).
 *
 * Module boundary: no barrel — the entry and the adapter import by explicit
 * relative path; public exports (`StatusGateAdvisory`) are re-exported
 * verbatim by the entry.
 */
import { basename, dirname, join, resolve } from 'node:path'
import { type Context } from 'cordis'
import {
  applyEnforcement,
  findingsCleanupGate,
  readJson,
  resolveCompassEnforcement,
  validateStatus,
} from '@mstar-harness/engine'
import type {
  GateResult,
  StatusDoc,
  ValidationResult,
} from '@mstar-harness/engine'
import type { FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { STATUS_FILE, asRecord, formatViolation, HarnessResolver, actorAgentOf } from './_shared.ts'
import type { Config } from './_shared.ts'
// Type-only (erased at runtime — no cycle): the adapter owns the shared
// status-gate core and is constructed by the entry `apply`; the listener
// signatures type their adapter parameter through the entry until the adapter
// moves into `src/gates/` (Task 3).
import type { DshHostAdapter } from '../index.ts'
/** Logger label for the status gate (dsh logger naming: `<scope>/<subject>`). */
const LOGGER_NAME = 'mstar/status-gate'
/**
 * Advisory emitted on status-gate decisions (the plan's "emit `agent/status`
 * (advisory)" step). Named `mstar/status-gate` instead: the dsh `agent/status`
 * event is a lifecycle-only channel (`{ agent, status }`, idle ⇄ running, with
 * an invariant rejecting no-op transitions) — emitting gate warnings on it
 * would violate the seam contract. Consumers (later tasks, catalogs) observe
 * this event for model-visible/session-log surfacing.
 *
 * The status gate NEVER throws: the fs intent waterfall
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
 * Whether a target is the canonical `{HARNESS_DIR}/status.json`. Matching is by
 * resolved path equality on `displayPath` (the local backend reports absolute
 * paths; remote/URI backends never match and the gate is inert for them).
 *
 * simplify: case-sensitive `===` comparison — on case-insensitive
 * filesystems (macOS/Windows defaults) a case-variant write path escapes the
 * gate (inert, never a false positive); case-normalized matching would need
 * the fs backend's canonical-case notion, revisit if case-variant writes
 * become an observed bypass.
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
export function validateStatusValue(doc: unknown): GateResult {
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
 * Single-read contract: the file is parsed exactly once and the
 * parsed doc is passed to {@link validateStatusValue} — the previous
 * path-first read then `readJson` re-read was a TOCTOU window (a concurrent
 * writer between the two reads threw a raw error from inside the gate).
 * Malformed JSON is contained here with the engine's `status.invalid-json`
 * shape; never throws. Missing files are guarded by the callers
 * (`gateStatusIntent`, {@link DshHostAdapter.statusGate}) — first create has
 * no document to validate and passes before this function runs.
 */
export function validateStatusDoc(statusPath: string): GateResult {
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
 * Warn mode logs + advisory emit + delegates; hard
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
export async function writeIntentListener(
  ctx: Context,
  resolver: HarnessResolver,
  config: Config,
  adapter: DshHostAdapter,
  target: FsTarget,
  actor: object | undefined,
  next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>,
): Promise<FsWriteIntent | undefined> {
  gateStatusIntent(ctx, resolver.forAgent(actorAgentOf(actor)), config, adapter, 'write', target)
  return await next()
}

/** `fs/edit-intent` listener — same gate and delegation contract as {@link writeIntentListener}. */
export async function editIntentListener(
  ctx: Context,
  resolver: HarnessResolver,
  config: Config,
  adapter: DshHostAdapter,
  target: FsTarget,
  actor: object | undefined,
  next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>,
): Promise<{ version: FsVersion } | undefined> {
  gateStatusIntent(ctx, resolver.forAgent(actorAgentOf(actor)), config, adapter, 'edit', target)
  return await next()
}
