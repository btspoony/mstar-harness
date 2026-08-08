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
  readHarnessVersion as engineReadHarnessVersion,
  resolveHarnessDir as engineResolveHarnessDir,
  validateStatus as engineValidateStatus,
} from '@mstar-harness/engine'
import type {
  GateResult,
  ResolveHarnessDirOptions,
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
 * The service is provided programmatically by the `dsh` function plugin
 * (`ctx.provide`); it exists so gate listeners and future consumers declare
 * `inject: ['dshMstar']` instead of importing the engine directly.
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
