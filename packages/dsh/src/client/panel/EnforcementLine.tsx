/**
 * The harness ENFORCEMENT flag — one line, the session fact that changes what a
 * gate will let the session do (plan dsh-panel-unification Task 6, IA §7).
 *
 * It is the host's own line rather than product copy because the flag is host
 * chrome the shared dictionary cannot know: the snapshot carries an
 * `EnforcementFlag` (`{ hard, source }`), and the product's `Focus` copy only
 * knows a label. The line renders the literal enum (`soft` / `hard`) with the
 * shared status treatment, and an unreadable member renders its own
 * `unavailable` line with the read's reason — never a guessed `soft`.
 *
 * Named `Line`, not `EnforcementFlag`: the snapshot's own type is already called
 * `EnforcementFlag`, and this module would then carry a type and a component
 * under one identifier.
 *
 * NOT here, by decision (D30): the knowledge rollup — no document count, no
 * categories, no inventory. And not on `Overview`, in a detail view, or in the
 * main-area panel: the flag is session chrome.
 *
 * @module @mstar-harness/dsh/client/panel/EnforcementLine
 */

import * as React from 'react'
import { StatusDot } from '@mstar-harness/ui'
import type { EnforcementFlag } from '@mstar-harness/engine'
import css from './panel.module.css'

export type EnforcementLineProps = {
  /** The digest's member, or null when the read did not produce one. */
  enforcement: EnforcementFlag | null | undefined
  /** The product copy for the flag (`Enforcement ${flag}` from the shared dictionary). */
  enforce: (flag: string) => string
}

export function EnforcementLine({ enforcement, enforce }: EnforcementLineProps): React.ReactElement {
  if (enforcement === null || enforcement === undefined || typeof enforcement.hard !== 'boolean') {
    return (
      <p className={css.enforcement} data-ms-enforcement-line="unavailable">
        <StatusDot label="unavailable" tone="neutral" mono />
        <span data-ms-enforcement-reason="">unavailable</span>
      </p>
    )
  }
  const flag = enforcement.hard ? 'hard' : 'soft'
  return (
    <p className={css.enforcement} data-ms-enforcement-line={flag}>
      <StatusDot label={flag} tone={enforcement.hard ? 'warning' : 'neutral'} mono />
      <span data-ms-enforcement-flag={flag}>{enforce(flag)}</span>
    </p>
  )
}
