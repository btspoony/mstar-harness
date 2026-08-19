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
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  applyEnforcement,
  assignmentHeaderRegion,
  readJson,
  validateIntegrationMergeLease,
  WORKFLOW_SNAPSHOT_FILE,
} from '@mstar-harness/engine'
import type {
  AssignmentFields,
  GateResult,
  HostAdapter,
  IntegrationMergeLease,
  ValidationResult,
} from '@mstar-harness/engine'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { HarnessResolver, Config } from './_shared.ts'
import { harnessDocKindOfTarget, validateStatusDoc, validateStatusValue, type HarnessDocKind } from './status.ts'
import { resolveActiveWorkflow } from './workflow-selection.ts'
import {
  dispatchGateCore,
  leaseGateViolations,
  assignmentTextFromFields,
  isAssignmentShaped,
  resolveDispatchHard,
} from './dispatch.ts'
import { recordDispatch, recordWorkflowVerdict as appendWorkflowVerdict, AGENT_FLOW_LOGGER } from './agent-flow.ts'
import type { AgentFlowPairing, WorkflowVerdictInput } from './agent-flow.ts'
// P-c first-seen ask cache (plan `20260815-dsh-workflow-gate` Task 2):
// apply-scoped, owned here (constructed with the adapter) so the dispatch
// gate and tests share ONE instance per plugin apply. workflow-policy
// imports dispatch.ts type-only — no runtime cycle.
import { WorkflowAskCache } from './workflow-policy.ts'
/** Logger label for the host adapter (dsh logger naming: `<scope>/<subject>`). */
const HOST_LOGGER = 'mstar/host-adapter'

/**
 * No-steal comparison for the integration merge lease: the passed lease and
 * the snapshot-stored lease must agree on every identity field (holder,
 * claimed_at, plan_id, source_branch, target_branch). `session_label` is
 * descriptive only and never part of the identity.
 */
function mergeLeasesMatch(left: unknown, right: unknown): boolean {
  const a = (left as Record<string, unknown> | null | undefined) ?? {}
  const b = (right as Record<string, unknown> | null | undefined) ?? {}
  return ['holder', 'claimed_at', 'plan_id', 'source_branch', 'target_branch'].every((key) => a[key] === b[key])
}
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
   * The P-c first-seen ask cache (plan `20260815-dsh-workflow-gate`
   * Task 2): workflow name → resolved decision, apply-scoped. Absent (the
   * entry relies on this default — `index.ts` constructs the adapter
   * without it) → the constructor builds ONE cache per adapter per apply,
   * shared by the gate and any answerer integration via the readonly
   * property. An explicit instance may be passed to share a specific cache
   * (host-adapter tests / direct construction).
   */
  readonly workflowAskCache?: WorkflowAskCache
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
 *   file = first create = pass). The path is classified against the resolved
 *   harness dir (v2 root / workflow snapshot / project register — the
 *   P2-fixed `harnessDocKindOfTarget` shape) and validated with the MATCHING
 *   engine validator; non-coordination paths pass. Both inputs flow through
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
  /**
   * The P-c first-seen ask cache (plan `20260815-dsh-workflow-gate`
   * Task 2) — apply-scoped with the adapter: the dispatch gate reads it
   * through `gateDispatch`, and tests/answerer integrations reach the same
   * instance via `ctx.dshHostAdapter.workflowAskCache`. Dies with the
   * fiber (no module-level reference — an HMR reload starts a fresh cache).
   */
  readonly workflowAskCache: WorkflowAskCache
  private readonly logSink: (level: 'info' | 'warn' | 'error', msg: string) => void

  constructor(ctx: Context, options: DshHostAdapterOptions) {
    // Provided as a dsh service (`ctx.dshHostAdapter`, same convention as
    // `ctx.dshMstar`): construction self-registers on the fiber.
    super(ctx, 'dshHostAdapter')
    this.resolver = options.resolver
    this.config = options.config
    this.pairing = options.pairing
    this.workflowAskCache = options.workflowAskCache ?? new WorkflowAskCache()
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
   * ONE validation code path, kind-dispatched (v2 root / workflow snapshot
   * / project register — the matching engine validator per
   * {@link validateStatusValue}). Missing file = first create = pass (the
   * intent waterfall carries no incoming content, so the vetoable signal is
   * the pre-write on-disk state).
   * @param path - the canonical coordination-document path (the caller
   * classifies it against the resolved harness dir).
   * @param kind - the target's {@link HarnessDocKind}.
   * @param harnessDir - the resolved `{HARNESS_DIR}` (the snapshot kind's
   * cleanup extension needs it to locate the project registers).
   */
  statusGate(path: string, kind: HarnessDocKind, harnessDir: string | null): GateResult {
    if (!existsSync(path)) return { ok: true, violations: [] }
    return validateStatusDoc(path, kind, harnessDir)
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
   * Record one workflow/ralph gate verdict row (plan
   * `20260815-dsh-workflow-gate` Task 4 — the durable ledger row for every
   * gated workflow/ralph call: verdict + metaName/objective + mode, via the
   * ledger plan's record path). `gateWorkflow` routes the record through
   * this adapter method so dispatch.ts stays free of a runtime agent-flow
   * import (the ledger imports dispatch helpers — the adapter is the
   * acyclic junction, the same role it plays for `dispatchGate`). The
   * underlying record is fully try/catch-contained (a failing ledger write
   * logs and never reaches the gate) — this method never throws.
   * @param input - the gate's decision identity (harness dir + tool +
   *   workflow/objective + mode + verdict + code).
   */
  recordWorkflowVerdict(input: WorkflowVerdictInput): void {
    appendWorkflowVerdict(input)
  }

  /**
   * `HostAdapter.beforeStatusWrite` — see the class doc for the doc-first /
   * on-disk-fallback semantics, now KIND-DISPATCHED: the path is classified
   * against the resolved harness dir (`harnessDocKindOfTarget` — root
   * status.json / workflow snapshot / project register, the P2-fixed shape)
   * and validated with the matching engine validator
   * (`validateStatusValue`). Non-coordination paths (unclassifiable) pass —
   * the hook's business is harness coordination documents only. Never
   * throws; a failing gate maps to its FIRST violation
   * (severity/code/message/fix/aliases preserved — failing gates always
   * carry ≥1 violation), a passing gate to
   * `host.beforeStatusWrite.ok` (the engine test convention for this hook).
   * @param path - the coordination-document target path.
   * @param doc - the document about to be written (undefined → validate the
   * on-disk document at `path`).
   */
  async beforeStatusWrite(path: string, doc: unknown): Promise<ValidationResult> {
    const harnessDir = this.resolver.forWorkspace(undefined)
    const kind = harnessDir === null ? null : harnessDocKindOfTarget(harnessDir, path)
    if (kind === null) {
      // Not a canonical harness coordination document — nothing to gate.
      return { ok: true, severity: 'low', code: 'host.beforeStatusWrite.ok', message: `status write to ${path} validated` }
    }
    const gate = doc !== undefined ? validateStatusValue(doc, kind, harnessDir) : this.statusGate(path, kind, harnessDir)
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
   * lease. v3 relocation (plan `20260819-workflow-dsh-viz` Task 3): the
   * `integration_merge_lease` home is the ACTIVE workflow snapshot
   * (`workflows/<id>/snapshot.json` top-level — the v1 root-metadata home
   * is gone), so the hook READS the snapshot's current lease and validates
   * it (CLI `lease verify-integration` parity) plus a no-steal comparison
   * against the passed lease. The passed lease object is still
   * shape-validated (the hook contract). Degrade edges (never false
   * positives): no harness dir (exec-less hook — the explicit config
   * resolves or nothing), no active workflow, an unreadable/missing
   * snapshot, or a snapshot WITHOUT an `integration_merge_lease`
   * (unclaimed) all skip the snapshot read — the passed-lease shape gate
   * stands alone.
   * @param lease - the `metadata.integration_merge_lease` object being
   * reserved/validated.
   */
  async beforeMerge(lease: IntegrationMergeLease): Promise<GateResult> {
    const violations = [...validateIntegrationMergeLease(lease).violations]
    const harnessDir = this.resolver.forWorkspace(undefined)
    if (harnessDir !== null) {
      const selection = resolveActiveWorkflow(harnessDir)
      if (selection.kind === 'active') {
        const snapshotPath = join(harnessDir, selection.dir, WORKFLOW_SNAPSHOT_FILE)
        try {
          const snapshot = readJson(snapshotPath) as Record<string, unknown> | null | undefined
          const stored = snapshot?.integration_merge_lease
          if (stored !== undefined) {
            // The durable lease validates (CLI parity), and the passed lease
            // must be the SAME reservation (no-steal — a different holder /
            // plan / branch pair is not the active merge).
            violations.push(...validateIntegrationMergeLease(stored).violations)
            if (!mergeLeasesMatch(lease, stored)) {
              violations.push({
                ok: false,
                severity: 'high',
                code: 'lease.merge.snapshot-mismatch',
                message: `snapshot integration_merge_lease (${snapshotPath}) differs from the lease being reserved — the active merge belongs to another holder/plan`,
                fix: 'merge only under the snapshot-recorded integration_merge_lease (or release the lease with user authorization + audit note)',
              })
            }
          }
        } catch (error) {
          // Contained: an unreadable snapshot cannot harden the shape gate
          // (the passed-lease violations above still stand). The snapshot
          // write gate owns the document's validity.
          this.ctx.logger(HOST_LOGGER).warn(
            `beforeMerge snapshot lease read failed (contained — the passed-lease shape gate stands): ${(error as Error).message}`,
          )
        }
      }
    }
    return { ok: violations.length === 0, violations }
  }
}

