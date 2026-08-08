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
 * listeners (`fs/write-intent` + `fs/edit-intent` status gate, `fs/write-intent`
 * skill-lint gate), the `tools/pre-execute` dispatch listener, the advisory
 * `agent/pre-step` catalog listener, the `ctx.dshMstar` and
 * `ctx.dshHostAdapter` services, and the child skill-local mount (skills
 * provider registration) — whose presence and removal are asserted by the
 * real-composition suite and the HMR-safety disposal tests (hmr-safety.spec.ts
 * aggregate, catalog.spec.ts teardown, skill-lint.spec.ts HMR, skills-mount
 * disposal), not by an invariant companion. A config↔listener presence check
 * would duplicate those tests.
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
