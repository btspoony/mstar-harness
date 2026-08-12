/**
 * Host adapter — the plugin's engine `HostAdapter` implementation (`host:
 * 'dsh'`), the host-facing facade over the gate internals (plan
 * `20260810-dsh-entry-split` §13 extraction).
 *
 * The adapter owns the SHARED status/dispatch gate cores (`statusGate` /
 * `dispatchGate` — the SAME validation paths the fs-intent listeners and the
 * `tools/pre-execute` listener run) plus the optional host hooks
 * (`beforeStatusWrite` / `beforeDispatch` / `beforeMerge`), so host hooks and
 * in-plugin gates share ONE code path. The status and dispatch modules import
 * only the `DshHostAdapter` TYPE from this module (erased at runtime — no
 * cycle; the adapter imports their values at runtime).
 *
 * Module boundary: no barrel — the entry imports by explicit relative path;
 * public exports (`DshHostAdapter`, `DshHostAdapterOptions`) are re-exported
 * verbatim by the entry.
 */
import { existsSync } from 'node:fs'
import { Service, type Context } from '@deepseek-ai/cordis'
import { applyEnforcement, assignmentHeaderRegion, validateIntegrationMergeLease } from '@mstar-harness/engine'
import type {
  AssignmentFields,
  GateResult,
  HostAdapter,
  IntegrationMergeLease,
  ValidationResult,
} from '@mstar-harness/engine'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { HarnessResolver, Config } from './_shared.ts'
import { validateStatusDoc, validateStatusValue } from './status.ts'
import {
  dispatchGateCore,
  leaseGateViolations,
  assignmentTextFromFields,
  isAssignmentShaped,
  resolveDispatchHard,
} from './dispatch.ts'
import { recordDispatch, AGENT_FLOW_LOGGER } from './agent-flow.ts'
import type { AgentFlowPairing } from './agent-flow.ts'
/** Logger label for the host adapter (dsh logger naming: `<scope>/<subject>`). */
const HOST_LOGGER = 'mstar/host-adapter'
/** Options for {@link DshHostAdapter}. */
export interface DshHostAdapterOptions {
  /**
   * The per-workspace `{HARNESS_DIR}` resolver (explicit config wins; the
   * probe never starts from the process cwd). The exec-bound gate paths
   * resolve per the calling session's workspace.
   */
  readonly resolver: HarnessResolver
  /** The plugin Config the gates resolve enforcement + anti-recursion binding from. */
  readonly config: Config
  /**
   * The apply-scoped agent-flow pairing store (plan
   * `20260811-panel-f4-timeliness` Task 1 — created by the entry `apply`,
   * shared with the settle listener): passed to `recordDispatch` so an
   * exec-bound dispatch registers `callId → dispatchRef` for the later
   * post-execute settle pairing. Absent (host-adapter tests / direct
   * construction) → no pairing registration (record-only).
   */
  readonly pairing?: AgentFlowPairing
  /**
   * Log sink for `HostAdapter.log`. Defaults to the dsh ctx logger scoped
   * `mstar/host-adapter` (dsh logger naming: `<scope>/<subject>`).
   */
  readonly log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

/**
 * The plugin's `HostAdapter` implementation (engine `host.ts` type-only
 * contract) — the HOST-FACING facade over the gate
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
 *   (engine `composeDispatchGate` — fields + branch gate + anti-recursion —
 *   plus worktree L1/L2 checks; read-only roles skip the branch gate). The lease gate
 *   stays listener-side: it binds the ToolExecution context (session id)
 *   this hook's contract does not carry. The parsed `AssignmentFields` form
 *   is normalized to the engine's own header grammar (lossless — the
 *   parsers read exactly these labels) and gated through the same text path.
 *   Enforcement is applied like the listener (opencode parity): the
 *   returned GateResult carries `hardBlocked` so a refusal-capable host can
 *   refuse the dispatch.
 * - `beforeMerge(lease)` — thin wrapper over the engine
 *   `validateIntegrationMergeLease` (reserve/validate the integration merge
 *   lease; the reservation WRITE into status.json is a P3 seam).
 */
export class DshHostAdapter extends Service implements HostAdapter {
  /** Engine host identity (`HostId` union). */
  readonly host = 'dsh' as const

  private readonly resolver: HarnessResolver
  private readonly config: Config
  private readonly pairing: AgentFlowPairing | undefined
  private readonly logSink: (level: 'info' | 'warn' | 'error', msg: string) => void

  constructor(ctx: Context, options: DshHostAdapterOptions) {
    // Provided as a dsh service (`ctx.dshHostAdapter`, same convention as
    // `ctx.dshMstar`): construction self-registers on the fiber.
    super(ctx, 'dshHostAdapter')
    this.resolver = options.resolver
    this.config = options.config
    this.pairing = options.pairing
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
   * the pre-write on-disk state).
   * @param statusPath - the canonical `{HARNESS_DIR}/status.json` path.
   */
  statusGate(statusPath: string): GateResult {
    if (!existsSync(statusPath)) return { ok: true, violations: [] }
    return validateStatusDoc(statusPath)
  }

  /**
   * Shared dispatch-gate core (plugin-internal): the `tools/pre-execute`
   * listener and `beforeDispatch` route through this method — ONE
   * validation code path (field gate + anti-recursion + branch gate +
   * worktree L1/L2 checks; read-only roles skip the branch gate). The
   * listener passes `exec` so the lease gate (ToolExecution-bound: session
   * id, in-flight call) joins the same verdict; the host hook has no exec
   * context and covers the field/branch/anti-recursion/worktree path.
   * @param prompt - the Assignment text (engine header grammar).
   * @param exec - the in-flight delegation tool call (listener path only).
   * @param hard - the caller's ONE `resolveDispatchHard` resolution (qc1
   * F-002 / qc2 F-3 / qc3 F-002 fix-wave): passed in so the record block and
   * the caller's enforcement decision share a single compass resolution;
   * when omitted (external callers) the adapter resolves it itself.
   */
  dispatchGate(prompt: string, exec?: ToolExecution, hard?: boolean): GateResult {
    const harnessDir = this.resolver.forAgent(exec?.agent)
    const { violations, writable } = dispatchGateCore(this.config, harnessDir, prompt)
    if (exec !== undefined) {
      violations.push(...leaseGateViolations(harnessDir, exec, writable, prompt))
    }
    // Agent-flow ledger — the ONE recording point for both dispatch paths
    // (spec §2.1.1: this shared core sits behind the `tools/pre-execute`
    // listener AND the host `beforeDispatch` hook). Recorded UNCONDITIONALLY
    // for Assignment-shaped text (verdict derivation covers clean / advisory
    // / hard deny) and advisory-only: `recordDispatch` is fully
    // try/catch-contained and this belt-and-braces guard keeps a ledger bug
    // from ever reaching the gate. The SHAPE GUARD lives here too (qc2 F-2
    // fix-wave): the listener path guards before calling, and the exec-less
    // host-hook path must stay equally silent for non-Assignment text — no
    // phantom records on either surface (spec §2.1.1 "非 Assignment 不记录").
    // The apply-scoped `pairing` rides along (plan
    // `20260811-panel-f4-timeliness` Task 1): an exec-bound record registers
    // `callId → dispatchRef` inside `recordDispatch`, so the later
    // `tools/post-execute` for the same call can settle with the same
    // identity; the exec-less host-hook path has no callId → no pairing.
    if (harnessDir !== null && isAssignmentShaped(assignmentHeaderRegion(prompt))) {
      try {
        recordDispatch({
          harnessDir,
          exec,
          prompt,
          violations,
          hard: hard ?? resolveDispatchHard(harnessDir, this.config, prompt),
          pairing: this.pairing,
        })
      } catch (error) {
        this.ctx.logger(AGENT_FLOW_LOGGER).error(
          `agent-flow dispatch record failed (contained — dispatch proceeds): ${(error as Error).message}`,
        )
      }
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
    // The hook contract carries no exec/session context, so the harness dir
    // resolves to the explicit config or null (never a process-cwd probe) —
    // the exec-bound `tools/pre-execute` listener is the per-workspace path.
    // `hard` resolves ONCE (qc1 F-002 / qc2 F-3 / qc3 F-002 fix-wave) and is
    // shared by the record block (via dispatchGate) and this enforcement
    // decision — no duplicate compass read per dispatch.
    const harnessDir = this.resolver.forWorkspace(undefined)
    const hard = resolveDispatchHard(harnessDir, this.config, prompt)
    const gate = this.dispatchGate(prompt, undefined, hard)
    return applyEnforcement(gate, { hard })
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

