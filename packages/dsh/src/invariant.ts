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
 * No runtime invariant: the scaffold registers no mutable state yet — the status/dispatch/lease
 * gate listeners and their `Enforcement: hard` configuration land in later tasks of this plan;
 * the companion gains a config↔listener presence check once those listeners exist.
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
