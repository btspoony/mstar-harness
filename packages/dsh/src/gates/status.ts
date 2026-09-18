/**
 * Status gate — `{HARNESS_DIR}` coordination-document fs-intent gating
 *. *
 * The gate runs on `fs/write-intent` / `fs/edit-intent` (registered by the
 * entry `apply` with `prepend`), sharing ONE validation code path with the
 * host adapter's `beforeStatusWrite` hook (`validateStatusValue` /
 * `validateStatusDoc` are the module's wiring exports for the adapter).
 * Enforcement is the status-gate repair-escape contract: the intent waterfall
 * carries no incoming content, so hard mode with an ALREADY-invalid document
 * allows the write as a repair (loud error log + `repair: true` advisory) —
 * EXCEPT the store-authority refusal class, which no write can repair and
 * which is therefore vetoed (throw; {@link StatusVetoError}).
 *
 * Module boundary: no barrel — the entry and the adapter import by explicit
 * relative path; public exports (`StatusGateAdvisory`) are re-exported
 * verbatim by the entry.
 */
import { existsSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { type Context } from '@deepseek-ai/cordis'
import {
  applyEnforcement,
  findingsCleanupGate,
  readJson,
  resolveProjectDir,
  resolveRepoEnforcement,
  resolveWorkflowDir,
  validateProjectRegister,
  validateStatus,
  validateWorkflowSnapshot,
  PROJECT_REGISTER_FILE,
  WORKFLOW_SNAPSHOT_FILE,
} from '@mstar-harness/engine'
import type {
  GateResult,
  StatusV2Doc,
  ValidationResult,
} from '@mstar-harness/engine'
import type { FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { STATUS_FILE, asRecord, formatViolation, HarnessResolver, actorAgentOf } from './_shared.ts'
import type { Config } from './_shared.ts'
// Type-only (erased at runtime — no cycle): the adapter owns the shared
// status-gate core and is constructed by the entry `apply`; the listener
// signatures type their adapter parameter through the adapter module.
import type { DshHostAdapter } from './adapter.ts'
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
 * The status gate throws only the typed store-authority veto
 * ({@link StatusVetoError}) — the one refusal this content-blind seam CAN
 * make, because no write to the document can repair an unreadable issue
 * authority. Every other decision surfaces through this advisory: the intent
 * waterfall carries no incoming content, so the only hard-mode decision about
 * an ALREADY-invalid document is to allow the write as a repair escape.
 * Unexpected internal errors degrade to an allow with `degraded: true`.
 */
export interface StatusGateAdvisory {
  /** Which intent slot passed the gate. */
  operation: 'write' | 'edit'
  /** `displayPath` of the guarded file. */
  target: string
  /** The gate verdict (warn-mode: `hardBlocked` false; hard repair escape: `hardBlocked` true). */
  result: GateResult
  /**
   * Resolved enforcement flag: true whenever the gate ran under hard
   * enforcement — for hard-mode repair escapes AND for degraded-hard
   * advisories (f9: the catch emits `hard` reflecting ACTUAL enforcement,
   * so a hard deployment can distinguish a dead control from a warn-only
   * pass). False only for warn-mode advisories.
   */
  hard: boolean
  /** True when hard mode allowed a write/edit to an ALREADY-invalid document (repair escape). */
  repair?: boolean
  /** True when the gate errored internally and degraded to allow (error-containment envelope). */
  degraded?: boolean
}
/**
 * Canonical `{HARNESS_DIR}` coordination-document kinds the status gate
 * covers (opencode-parity vocabulary — the SAME three kinds the P2-fixed
 * opencode `harnessDocKindOfTarget` classifies): the v2 root `status.json`,
 * `workflows/<id>/snapshot.json`, and `projects/<id>/residuals.json`. Each
 * kind maps to its matching engine validator in
 * {@link validateStatusValue}.
 */
export type HarnessDocKind = 'status' | 'snapshot' | 'register'

/**
 * Classify one fs target as a canonical `{HARNESS_DIR}` coordination
 * document: basename ∈ {status.json, snapshot.json, residuals.json} AND the
 * harness-relative path matches the canonical home (root `status.json`,
 * `{WORKFLOW_DIR}/<id>/snapshot.json`, `{PROJECT_DIR}/<id>/residuals.json`
 * — one path component each, mirroring the P2-fixed opencode
 * `harnessDocKindOfTarget`).
 *
 * Phase-5 F1: the snapshot/register rel is computed against the RESOLVED
 * layout dirs (`resolveWorkflowDir` / `resolveProjectDir` — a `.mstarc`
 * `[config] workflow_dir` / `project_dir` declaration wins, defaults
 * `workflows` / `projects` under the harness dir), so a custom layout
 * classifies at the same location the runtime writes; resolver failure
 * (never expected with the explicit harness dir) falls back to the default
 * names.
 *
 * dsh divergence from the opencode probe (documented): opencode resolves
 * the harness root by marker probe (W-REV-1) with a declared-root fallback;
 * the dsh gates ALREADY resolve `{HARNESS_DIR}` per calling session
 * workspace through the shared `HarnessResolver` BEFORE the intent slot
 * runs, so classification here is against that resolved root — no second
 * probe, no W-REV-3 rebuild. Returns the kind when gated, `null` otherwise
 * (a non-coordination target, or a path outside the resolved harness dir —
 * the gate is inert for them).
 */
export function harnessDocKindOfTarget(harnessDir: string, targetPath: string): HarnessDocKind | null {
  const resolved = resolve(targetPath)
  const name = basename(resolved)
  if (name !== STATUS_FILE && name !== WORKFLOW_SNAPSHOT_FILE && name !== PROJECT_REGISTER_FILE) return null
  const rel = relative(harnessDir, resolved)
  if (name === STATUS_FILE && rel === STATUS_FILE) return 'status'
  let workflowDir: string
  let projectDir: string
  try {
    workflowDir = resolveWorkflowDir(harnessDir, { harnessDir })
    projectDir = resolveProjectDir(harnessDir, { harnessDir })
  } catch {
    workflowDir = join(harnessDir, 'workflows')
    projectDir = join(harnessDir, 'projects')
  }
  if (name === WORKFLOW_SNAPSHOT_FILE && /^[^/]+\/snapshot\.json$/.test(relative(workflowDir, resolved))) return 'snapshot'
  if (name === PROJECT_REGISTER_FILE && /^[^/]+\/residuals\.json$/.test(relative(projectDir, resolved))) return 'register'
  return null
}

/**
 * Resolve the hard-enforcement flag: explicit Config override wins, else
 * the repo `.mstarc` `[config] enforcement`, else the iteration compass
 * frontmatter (`resolveRepoEnforcement`), else warn-only.
 */
function resolveHard(harnessDir: string, config: Config): boolean {
  if (config.enforcement === 'hard') return true
  if (config.enforcement === 'soft') return false
  return resolveRepoEnforcement(harnessDir).hard
}

/**
 * The violation code the snapshot cleanup extension raises when the issue
 * authority cannot be consulted at all — missing (`store.not-initialized`),
 * staged (`store.not-active`), corrupt (`store.corrupt`), below-floor /
 * capability-less (`store.runtime-unsupported`), drifted (`store.schema-*`) or
 * busy store. The store-authority refusal class: the cleanup gate's VERDICT is
 * unknown, as opposed to a cleanup violation the authority actually reported.
 *
 * The fs-intent repair escape is unsound for this class: the violation says the
 * authority could not be READ, so the write that would "repair" it is a store
 * command (`mstar store init|upgrade|migrate`), never a write to the document —
 * every document write admissible under the escape is instead an evasion of the
 * very plan row the closure gate is asking about (dropping its
 * `metadata.findings_cleanup` mode while no authority can re-derive the
 * violation).
 */
const CLEANUP_AUTHORITY_UNAVAILABLE_CODE = 'findings.cleanup-authority-unavailable'

/**
 * Typed hard-mode veto for the status gate's store-authority refusal class
 * (the dsh fs-policy veto channel: "veto = throw"; the fs tool turns the throw
 * into an isError tool result carrying `{ name, code }`). Thrown ONLY by
 * {@link gateStatusIntent}, and only when the pre-write document's violations
 * include a store-authority refusal under hard enforcement — the repair escape
 * every other violation class still gets is unavailable there.
 *
 * The content-blind listener has no incoming content to lint, but it does not
 * need any for THIS decision: the refusal is about the authority's
 * readability, which no content can change.
 */
export class StatusVetoError extends Error {
  /** Stable code for tool-result serialization (the `{ name, code }` convention). */
  readonly code = 'status.veto' as const
  /** The violations that caused the veto (the store-authority refusal included). */
  readonly violations: readonly ValidationResult[]

  constructor(target: string, violations: readonly ValidationResult[]) {
    super(
      `${target} write vetoed by Enforcement: hard — the issue authority cannot be consulted, so the findings cleanup gate has no verdict and no filesystem write can repair it:\n${violations.map(formatViolation).join('\n')}`,
    )
    this.name = 'StatusVetoError'
    this.violations = violations
  }
}

/**
 * Validate a PARSED harness coordination document through the
 * kind-matched engine validator (v2 root / workflow snapshot / project
 * register — the P2-fixed "one validator per kind" shape) plus the
 * snapshot-only `findingsCleanupGate` extension per plan row that
 * CONFIGURES a mode (the v1 per-plan-row cleanup gate relocated: plan rows
 * live on the snapshot, the plan's linked OPEN issues live in the issue
 * store). Shared by {@link validateStatusDoc} (the on-disk single-read path)
 * and the host adapter's `beforeStatusWrite` (the incoming document) — the
 * fs-intent gate, the adapter hook and the repair escape all surface the
 * SAME violation codes.
 *
 * ASYNC because the cleanup extension reads the issue authority
 * (`{HARNESS_DIR}/store.db`), the engine's async domain boundary. The
 * register kind stays SYNCHRONOUS shape validation: a project register is
 * migration history, and validating a document about to be written to that
 * retired path is not a lookup.
 * @param kind - the target's {@link HarnessDocKind} (matching engine validator).
 * @param harnessDir - the resolved `{HARNESS_DIR}`; required for the
 * snapshot kind's cleanup extension (it is the store context), otherwise
 * unused.
 */
export async function validateStatusValue(doc: unknown, kind: HarnessDocKind, harnessDir?: string | null): Promise<GateResult> {
  if (kind === 'register') return validateProjectRegister(doc)
  if (kind !== 'snapshot') return validateStatus(doc as StatusV2Doc)
  const base = validateWorkflowSnapshot(doc)
  if (!base.ok) return base
  if (harnessDir === null || harnessDir === undefined) return base
  const violations = await snapshotFindingsCleanupViolations(doc, harnessDir)
  if (violations.length === 0) return base
  return { ok: false, violations }
}

/**
 * The snapshot-target cleanup extension: for every snapshot plan row whose
 * `metadata.findings_cleanup` CONFIGURES a mode (zero-residual /
 * allow-residual — the P2 mode-resolution contract: explicit mode wins,
 * the v1 `plans[].metadata.findings_cleanup` mirror is deleted, no
 * dual-track), run the engine `findingsCleanupGate(context, planId, …)`
 * against the issue store: the plan's OPEN issues linked through
 * `provenance(kind='plan', target=<plan-id>)`, the single findings authority
 * (issue contract §4). A plan with no linked open issue passes.
 *
 * FAIL-CLOSED: the authority must be readable AND active. A missing
 * (`store.not-initialized`), staged (`store.not-active`), corrupt
 * (`store.corrupt`), below-floor or capability-less
 * (`store.runtime-unsupported`), drifted (`store.schema-*`) or busy store is
 * reported as a HIGH violation carrying the engine's own refusal message —
 * NEVER as "no findings". The store is never replaced by a JSON fallback:
 * the retired registers are migration history, not a second authority.
 */
async function snapshotFindingsCleanupViolations(doc: unknown, harnessDir: string): Promise<ValidationResult[]> {
  const record = asRecord(doc)
  if (record === undefined) return []
  const violations: ValidationResult[] = []
  for (const row of Array.isArray(record.plans) ? record.plans : []) {
    const planRow = asRecord(row)
    const metadata = planRow === undefined ? undefined : asRecord(planRow.metadata)
    const mode = metadata?.['findings_cleanup']
    if (mode !== 'zero-residual' && mode !== 'allow-residual') continue
    const planId = typeof planRow?.id === 'string' ? planRow.id : typeof planRow?.plan_id === 'string' ? planRow.plan_id : undefined
    if (planId === undefined) continue
    try {
      const gate = await findingsCleanupGate({ harnessDir }, planId, { mode })
      violations.push(...gate.violations)
    } catch (error) {
      const code = (error as { code?: unknown } | null | undefined)?.code
      violations.push({
        ok: false,
        severity: 'high',
        code: CLEANUP_AUTHORITY_UNAVAILABLE_CODE,
        message:
          `the findings cleanup gate for plan ${planId} cannot be evaluated: ` +
          `${typeof code === 'string' && code !== '' ? `[${code}] ` : ''}${(error as Error).message}`,
        fix: 'restore the issue store (mstar store init|upgrade|migrate) — an unreadable findings authority is never treated as no findings',
      })
    }
  }
  return violations
}

/**
 * Run the status gate over the CURRENT on-disk document at a canonical
 * harness coordination target. The fs intent waterfall carries only
 * `(target, actor)` — never the incoming content — so the vetoable check
 * is the pre-write state (the opencode hook's fallback for the same
 * reason). The kind-matched validator runs via {@link validateStatusValue}
 * (the snapshot kind's `findingsCleanupGate` extension included) — schema
 * violations short-circuit it (the doc must parse for the cleanup gate to
 * be meaningful).
 *
 * Single-read contract: the file is parsed exactly once and the
 * parsed doc is passed to {@link validateStatusValue} — the previous
 * path-first read then `readJson` re-read was a TOCTOU window (a concurrent
 * writer between the two reads threw a raw error from inside the gate).
 * Malformed JSON is contained here with the engine's `status.invalid-json`
 * shape; never throws. Missing files are guarded by the callers
 * (`gateStatusIntent`, {@link DshHostAdapter.statusGate}) — first create has
 * no document to validate and passes before this function runs.
 * @param path - the canonical coordination-document path (root status.json
 * / workflow snapshot / project register — the caller classifies it).
 * @param kind - the target's {@link HarnessDocKind}.
 * @param harnessDir - the resolved `{HARNESS_DIR}` (the store context of the
 * snapshot kind's cleanup extension).
 */
export async function validateStatusDoc(path: string, kind: HarnessDocKind, harnessDir?: string | null): Promise<GateResult> {
  let doc: unknown
  try {
    doc = readJson(path)
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
  return await validateStatusValue(doc, kind, harnessDir)
}

/**
 * Gate one fs intent on a canonical `{HARNESS_DIR}` coordination document
 * (root `status.json` / `workflows/<id>/snapshot.json` /
 * `projects/<id>/residuals.json` — the v3 write-intent target set). The gate
 * throws only {@link StatusVetoError} (the store-authority refusal veto); it
 * never throws anything else. Warn mode logs + advisory emit + delegates; hard
 * mode with an ALREADY-invalid document logs an error-level REPAIR advisory
 * and delegates — the intent waterfall carries no incoming content, so a
 * hard veto here would deadlock the very write that repairs the document.
 * The coherent content-blind policy: invalid on-disk → allow-as-repair; valid
 * on-disk → normal validation path (pass). EXCEPTION (narrowed repair
 * escape): a store-authority refusal is vetoed instead — no write to the
 * document can repair an unreadable issue authority, so admitting the write
 * could only serve to remove the plan row the closure gate asks about while no
 * authority can re-derive the violation. Non-coordination targets and absent
 * documents are pure pass-through.
 *
 * Error-containment envelope: any unexpected error (TOCTOU race, backend
 * contract violation on `displayPath`, throwing advisory consumer) degrades
 * to allow in BOTH modes with a loud log + `degraded: true` advisory — an
 * untyped throw from the gate would spuriously block legitimate writes (the
 * fs waterfall has no error containment of its own).
 */
async function gateStatusIntent(
  ctx: Context,
  harnessDir: string | null,
  config: Config,
  adapter: DshHostAdapter,
  operation: 'write' | 'edit',
  target: FsTarget,
): Promise<void> {
  try {
    if (harnessDir === null) return
    const kind = harnessDocKindOfTarget(harnessDir, target.displayPath)
    if (kind === null) return
    // The adapter owns the shared status-gate core (missing file = first
    // create = pass); this listener adds enforcement + observability.
    const result = await adapter.statusGate(target.displayPath, kind, harnessDir)
    const hard = resolveHard(harnessDir, config)
    const verdict = applyEnforcement(result, { hard })
    if (!verdict.ok) {
      if (verdict.hardBlocked) {
        // The one refusal this seam CAN make: the store-authority class (see
        // CLEANUP_AUTHORITY_UNAVAILABLE_CODE). Thrown past the error-containment
        // envelope below, which contains UNEXPECTED errors only — the veto is a
        // decision, and the fs-policy channel turns it into an isError write.
        if (verdict.violations.some((violation) => violation.code === CLEANUP_AUTHORITY_UNAVAILABLE_CODE)) {
          ctx.logger(LOGGER_NAME).error(
            `status.json ${operation} VETOED (Enforcement: hard; the issue authority is unavailable, so the findings cleanup gate has no verdict — no filesystem write can repair that):\n${verdict.violations.map(formatViolation).join('\n')}`,
          )
          // The advisory is contained: a throwing consumer must not hand the
          // catch below an error it would contain as a degrade-to-allow (the
          // throw at the end of this branch IS the decision).
          try {
            ctx.emit('mstar/status-gate', { operation, target: target.displayPath, result: verdict, hard })
          } catch (emitError) {
            ctx.logger(LOGGER_NAME).error(`status gate veto advisory emit failed: ${(emitError as Error).message}`)
          }
          throw new StatusVetoError(target.displayPath, verdict.violations)
        }
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
    // The typed veto is rethrown untouched (the only throw this gate makes).
    if (error instanceof StatusVetoError) throw error
    ctx.logger(LOGGER_NAME).error(`status gate degraded to allow: ${(error as Error).message}`)
    try {
      // f9: the degraded advisory reflects ACTUAL enforcement mode — under
      // hard the envelope still allows the write (never a veto), but the
      // advisory carries `hard: true` so hard deployments can tell a dead
      // control apart from a warn-only pass. `repair` stays unset (this was
      // NOT a repair-escape allow — the gate errored, the write was never
      // vetoed).
      let hard = false
      try {
        hard = harnessDir !== null && resolveHard(harnessDir, config)
      } catch {
        // `resolveHard` reads `.mstarc`/compass frontmatter from disk — a
        // throwing resolve must not re-enter the envelope (second-catch
        // death loop); fall back to a fail-safe warn-mode advisory.
      }
      ctx.emit('mstar/status-gate', { operation, target: target.displayPath, result: { ok: true, violations: [] }, hard, degraded: true })
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
 * plugin mounted earlier would make this gate unreachable. Every NON-VETO gate
 * decision (warn advisory, repair escape, degraded allow) calls `next()` —
 * delegating the observed-state intent decision to the remaining chain
 * (fs-policy when mounted; the bare `undefined` default otherwise) rather
 * than terminating the slot with `undefined` (which would silently disable
 * fs-policy's CAS for status.json in composed deployments). The store-authority
 * veto ({@link StatusVetoError}) is the single decision that does NOT delegate:
 * it rejects the waterfall so the write cannot land (dsh fs-policy "veto =
 * throw").
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
  await gateStatusIntent(ctx, resolver.forAgent(actorAgentOf(actor)), config, adapter, 'write', target)
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
  await gateStatusIntent(ctx, resolver.forAgent(actorAgentOf(actor)), config, adapter, 'edit', target)
  return await next()
}
