/**
 * The `sidebar.panellist` occupant (plan dsh-panel-unification Task 1): one row
 * in the sidebar's global panel list, whose id is the panel's main key — the
 * sidebar owns the row button, its label and the selection, and this component
 * only draws the mark.
 *
 * The owner props are the host's own: `SidebarPanelIconOwnerProps` from
 * `@deepseek-ai/dsh-client-ui-sidebar/client` ("Icon presentation supplied by
 * the global panel row": `size` = requested square edge, `active` = whether this
 * panel is selected in the main column). `active` needs no distinct drawing: the
 * row's own selected state already themes the `currentColor` mark.
 */

import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { MstarGlyph } from './mstar-glyph.tsx'

export function SidebarRowIcon({ size }: SidebarPanelIconOwnerProps) {
  return <MstarGlyph size={size} />
}
