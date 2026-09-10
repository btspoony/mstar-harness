/**
 * The panel's right-Sidebar tab-type definition (plan sidebar §L1.2) — stage
 * one of the two-stage seat registration: what the panel IS in the tab
 * system. Stage two (the keyed `sidebar.right.pane.tab` body and
 * `sidebar.right.pane.tab.title` chip under the same `id`) lives in the
 * plugin entry (`src/client/index.ts`).
 *
 * A page type: `patterns`/`canOpen` omitted (it recognizes no resource
 * address — it is opened by `kind`), `priority` omitted (defaults to the
 * `extension` band, the right band for a type from outside the product), and
 * exactly one guide entry so the start page carries the MStar capsule. The
 * `title` thunk is re-read on every use, so the guide capsule follows the
 * current locale; the chip's copy is captured at open time by the host.
 */

import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { MstarGlyph } from './mstar-glyph.tsx'
import type { PanelKey } from './locale.ts'

/** This implementation's identity in the tab system — the key its body and title register under. */
export const MSTAR_PANEL_ID = '@mstar-harness/dsh'

/** The page kind the panel owns (U2: one sidebar tab). */
export const MSTAR_PANEL_KIND = 'mstar-workflow'

/** The guide capsule's position among every registered type's entries (files ships order 10). */
export const MSTAR_GUIDE_ORDER = 20

export function mstarPanelDefinition(t: TranslateNS<'mstar-panel'>): SidebarRightTabDefinition {
  const title = (): string => t('view.mstar-workflow' satisfies PanelKey)
  return {
    id: MSTAR_PANEL_ID,
    kind: MSTAR_PANEL_KIND,
    title,
    guide: [{
      order: MSTAR_GUIDE_ORDER,
      title,
      description: () => t('guide.description' satisfies PanelKey),
      icon: MstarGlyph,
    }],
  }
}
