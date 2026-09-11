/**
 * The panel's chip title seat (plan sidebar §L1.3): draws the MStar glyph
 * before the tab title, exactly as the shipped glyph-bearing title seats do,
 * so the chip does not read as a bare label next to first-party chips. It is
 * decoration only — the copy comes from the registry's `title(address)` text
 * captured at open time, so it does not follow a live locale switch
 * (documented regression F2; restoring liveness would cost a store-backed
 * title registration for no user-visible gain).
 */

import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { MstarGlyph } from './mstar-glyph.tsx'

/** The chip title seat's props: the framework-injected tab information hook. */
export type MstarPanelTitleProps = PropsRuntime<'sidebar.right.pane.tab.title'>

export function MstarPanelTitle({ useTabInfo }: MstarPanelTitleProps) {
  const { tab } = useTabInfo()
  return (
    // The chip renders in host chrome OUTSIDE the panel `.root`, where the
    // `--mstar-space-*` ramp is not defined — the px fallback keeps the gap
    // honest there (the token scale still applies wherever the ramp exists).
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--mstar-space-1, 4px)' }}>
      <MstarGlyph size={14} />
      <span>{tab.title}</span>
    </span>
  )
}
