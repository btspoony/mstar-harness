/**
 * Package-owned invariant companion for `@mstar-harness/dsh`.
 * @module @mstar-harness/dsh/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'

/* dsh 0.2.1-alpha.1 removed `@deepseek-ai/dsh-invariants`, its `./invariant`
 * subpath convention and the `ctx.invariants` service, so there is no registry
 * left to reserve package ownership in. The entry stays as a loadable no-op so
 * a profile row naming `@mstar-harness/dsh/invariant` still activates. */

/** Cordis companion plugin name. */
export const name = 'dsh-invariant'

/**
 * Apply this package's invariant companion.
 *
 * No runtime invariant: this package registers no package-owned mutable state
 * an invariant registry could assert over an event/data relation. Its
 * contributions are lifecycle registrations — the fs intent waterfall
 * listeners (`fs/write-intent` + `fs/edit-intent` status gate, the scoped
 * skill-lint gate, the v2 seam gates for design-md/audit/compound/roles
 * paths), the `tools/pre-execute` dispatch listener (field + lease + worktree
 * L1/L2 gates), the advisory `agent/pre-step` catalog listener (engine-status
 * watermark + iteration-gate row), the v2 seam tools registered on `ctx.tools`
 * (`mstar_sdd_*`, `mstar_iteration_gate`, the validate wrappers), the
  * `ctx.dshMstar` and `ctx.dshHostAdapter` services, and the child skill-filesystem
 * mount (skills provider registration) — whose presence and removal are
 * asserted by the real-composition suites and the HMR-safety disposal tests
 * (hmr-safety.spec.ts aggregate, catalog.spec.ts teardown, skill-lint.spec.ts
 * HMR, skills-mount disposal, sdd-iteration-tools.spec.ts / worktree-l2.spec.ts
 * / misc-seams.spec.ts tool lifetimes, e2e-session.spec.ts full-app boot),
 * not by an invariant companion. The profile-bundle manifest
 * (`dsh.bundle.patch` in package.json) and the packaged `harness-skills/` /
 * `harness-commands/` mirrors are static package contents, not runtime state.
 * A config↔listener presence check would duplicate those tests.
 *
 * @param _ctx - Cordis context; unused, the host no longer offers an invariant registry.
 * @returns the companion's disposer.
 */
export const apply = (_ctx: Context): (() => void) => () => {}
/* jscpd:ignore-end */
