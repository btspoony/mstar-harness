/**
 * `ctx.dshMstar` service — the in-process Morning Star engine surface for
 * dsh gate plugins. Backed by `@mstar-harness/engine` (bundled into the
 * plugin dist at build time per the single-version convention; resolved
 * through the workspace devDependency at dev/test time).
 *
 * @module @mstar-harness/dsh
 */

import { Context, Service } from 'cordis'
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
  StatusDoc,
} from '@mstar-harness/engine'

declare module 'cordis' {
  interface Context {
    /** Morning Star engine service provided by `@mstar-harness/dsh`. */
    dshMstar: DshMstar
  }
}

/** Options for constructing the service (resolved plugin config). */
export interface DshMstarOptions {
  /** Resolved `{HARNESS_DIR}` (null when no harness dir was found). */
  readonly harnessDir: string | null
}

/**
 * Morning Star engine access for dsh gate plugins.
 *
 * Layering (qc1 F-002): this service is the composition/test façade for
 * FUTURE inject consumers (host adapters, catalogs, P2/P3 seams) — the
 * P1 gates in `index.ts` are co-located engine wrappers that import
 * `@mstar-harness/engine` directly (same plugin, engine bundled at build
 * time), so the engine stays the single grammar for both paths. The service
 * is constructed (and thereby self-registered) by the `dsh` function
 * plugin's `apply`.
 */
export class DshMstar extends Service {
  /** Resolved `{HARNESS_DIR}` for this app (null when probing found none). */
  readonly harnessDir: string | null

  constructor(ctx: Context, options: DshMstarOptions) {
    super(ctx, 'dshMstar')
    this.harnessDir = options.harnessDir
  }

  /**
   * Validate a status.json document or file path.
   * @param docOrPath - parsed status document or path to a status.json file.
   */
  validateStatus(docOrPath: StatusDoc | string): GateResult {
    return engineValidateStatus(docOrPath)
  }

  /**
   * Validate one residual entry (status-and-residuals.md § Basic structure).
   * @param entry - the residual entry as parsed from status.json.
   */
  validateResidual(entry: ResidualEntry | unknown): GateResult {
    return engineValidateResidual(entry)
  }

  /**
   * Findings cleanup gate for one plan (status-and-residuals.md § Findings
   * cleanup modes). Mode resolution: explicit `opts.mode` → `plans[].metadata.
   * findings_cleanup` → `allow-residual`.
   * @param doc - the parsed status document.
   * @param planId - the plan whose open residuals are checked.
   * @param opts - explicit cleanup-mode override.
   */
  findingsCleanupGate(doc: StatusDoc, planId: string, opts?: { mode?: FindingsCleanupMode }): GateResult {
    return engineFindingsCleanupGate(doc, planId, opts)
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
   * Resolve `{HARNESS_DIR}` per plan-conventions resolution order.
   * @param startDir - directory to probe from (defaults to the process cwd).
   * @param opts - explicit harness-dir override or environment fallback.
   */
  resolveHarnessDir(startDir?: string, opts?: ResolveHarnessDirOptions): string | null {
    return engineResolveHarnessDir(startDir, opts)
  }

  /**
   * Read the harness version (single-version invariant — 2.0.0).
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
