/**
 * `ctx.dshMstar` service — the in-process Morning Star engine surface for
 * dsh gate plugins. Backed by `@mstar-harness/engine` (bundled into the
 * plugin dist at build time per the single-version convention; resolved
 * through the workspace devDependency at dev/test time).
 *
 * @module @mstar-harness/dsh
 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  applyEnforcement as engineApplyEnforcement,
  findingsCleanupGate as engineFindingsCleanupGate,
  readHarnessVersion as engineReadHarnessVersion,
  resolveCompassEnforcement as engineResolveCompassEnforcement,
  resolveHarnessDir as engineResolveHarnessDir,
  validateResidual as engineValidateResidual,
  validateStatus as engineValidateStatus,
} from '@mstar-harness/engine'
import type {
  EnforcementFlag,
  FindingsCleanupMode,
  GateResult,
  ResolveHarnessDirOptions,
  ResidualEntry,
  StatusV2Doc,
  StoreContext,
} from '@mstar-harness/engine'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Morning Star engine service provided by `@mstar-harness/dsh`. */
    dshMstar: DshMstar
  }
}

/** Options for constructing the service (resolved plugin config). */
export interface DshMstarOptions {
  /**
   * The boot-resolved `{HARNESS_DIR}`: the explicit `harnessDir` config root
   * (null when unset). The plugin never probes from the process cwd —
   * without the explicit config the harness dir resolves per session
   * workspace at event time (the gates / pre-step catalog / tools), so the
   * boot value is only the config-known part.
   */
  readonly harnessDir: string | null
}

/**
 * Morning Star engine access for dsh gate plugins.
 *
 * Layering: this service is the composition/test façade for
 * FUTURE inject consumers (host adapters, catalogs, P2/P3 seams) — the
 * P1 gates in `index.ts` are co-located engine wrappers that import
 * `@mstar-harness/engine` directly (same plugin, engine bundled at build
 * time), so the engine stays the single grammar for both paths. The service
 * is constructed (and thereby self-registered) by the `dsh` function
 * plugin's `apply`.
 */
export class DshMstar extends Service {
  /**
   * The boot-resolved `{HARNESS_DIR}` (the explicit config root, null when
   * unset — per-workspace resolution happens at event time, never from the
   * process cwd).
   */
  readonly harnessDir: string | null

  constructor(ctx: Context, options: DshMstarOptions) {
    super(ctx, 'dshMstar')
    this.harnessDir = options.harnessDir
  }

  /**
   * Validate a status.json document or file path (the v2 root schema —
   * engine `validateStatus` = `validateStatusV2`; a v1 document fails with
   * `status.migration-required` carrying the `mstar migrate` hint).
   * @param docOrPath - parsed v2 status document or path to a status.json file.
   */
  validateStatus(docOrPath: StatusV2Doc | string): GateResult {
    return engineValidateStatus(docOrPath)
  }

  /**
   * Validate one residual entry (status-and-residuals.md § Basic structure).
   * @param entry - the residual entry as parsed from a project register.
   */
  validateResidual(entry: ResidualEntry | unknown): GateResult {
    return engineValidateResidual(entry)
  }

  /**
   * Findings cleanup gate for one plan (status-and-residuals.md § Findings
   * cleanup modes; issue-governance cutover — the input is the issue store
   * `{HARNESS_DIR}/store.db`, and the plan's OPEN issues are the ones linked
   * to it through `provenance(kind='plan', target=<plan-id>)`). A missing,
   * staged, corrupt or unreadable authority refuses (`store.not-initialized`
   * / `store.not-active` / `store.corrupt` / `store.runtime-unsupported`, …)
   * — never an empty "no findings" gate. The retired project register is
   * migration history and is not consulted.
   * @param context - the store context (the resolved `{HARNESS_DIR}`).
   * @param planId - the plan whose open linked issues are checked.
   * @param opts - explicit cleanup-mode override.
   */
  async findingsCleanupGate(context: StoreContext, planId: string, opts?: { mode?: FindingsCleanupMode }): Promise<GateResult> {
    return await engineFindingsCleanupGate(context, planId, opts)
  }

  /**
   * Resolve the repo-level hard-enforcement flag from the iteration compass
   * (`{ITERATION_DIR}/<id>/delivery-compass.md` frontmatter `enforcement: hard`
   * on active/locked compasses). Hard gates are never the default.
   * @param harnessDir - the resolved `{HARNESS_DIR}`.
   */
  resolveCompassEnforcement(harnessDir: string): EnforcementFlag {
    return engineResolveCompassEnforcement(harnessDir)
  }

  /**
   * Resolve `{HARNESS_DIR}` per plan-conventions resolution order. This is
   * the generic engine mirror — callers pass the workspace root they probe
   * from explicitly; the plugin itself never probes from the process cwd.
   * @param startDir - directory to probe from (defaults to the process cwd).
   * @param opts - explicit harness-dir override or environment fallback.
   */
  resolveHarnessDir(startDir?: string, opts?: ResolveHarnessDirOptions): string | null {
    return engineResolveHarnessDir(startDir, opts)
  }

  /**
   * Read the harness version (single-version invariant — 2.1.1).
   * @returns the version string of the bundled/workspace engine manifest.
   */
  readHarnessVersion(): string {
    return engineReadHarnessVersion()
  }

  /**
   * Apply the `Enforcement: hard` flag to a gate result.
   * @param gate - gate result to escalate.
   * @param opts - whether hard enforcement is on.
   */
  applyEnforcement(gate: GateResult, opts: { hard: boolean }): GateResult {
    return engineApplyEnforcement(gate, opts)
  }
}
