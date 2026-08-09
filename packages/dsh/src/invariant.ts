/**
 * Package-owned invariant companion for `@mstar-harness/dsh`.
 * @module @mstar-harness/dsh/invariant
 */

/* jscpd:ignore-start */
import type { Context } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@mstar-harness/dsh'

/** Cordis companion plugin name. */
export const name = 'dsh-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package registers no package-owned mutable state
 * the invariant service could assert over an event/data relation. Its
 * contributions are lifecycle registrations — the fs intent waterfall
 * listeners (`fs/write-intent` + `fs/edit-intent` status gate, the scoped
 * skill-lint gate, the v2 seam gates for design-md/audit/compound/roles
 * paths), the `tools/pre-execute` dispatch listener (field + lease + worktree
 * L1/L2 gates), the advisory `agent/pre-step` catalog listener (engine-status
 * watermark + iteration-gate row), the v2 seam tools registered on `ctx.tools`
 * (`mstar_sdd_*`, `mstar_iteration_gate`, the validate wrappers), the
 * `ctx.dshMstar` and `ctx.dshHostAdapter` services, and the child skill-local
 * mount (skills provider registration) — whose presence and removal are
 * asserted by the real-composition suites and the HMR-safety disposal tests
 * (hmr-safety.spec.ts aggregate, catalog.spec.ts teardown, skill-lint.spec.ts
 * HMR, skills-mount disposal, sdd-iteration-tools.spec.ts / worktree-l2.spec.ts
 * / misc-seams.spec.ts tool lifetimes, e2e-session.spec.ts full-app boot),
 * not by an invariant companion. The profile-bundle manifest
 * (`dsh.bundle.patch` in package.json) and the `skills/README.md` mount
 * target are static package contents, not runtime state. A config↔listener
 * presence check would duplicate those tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
