/**
 * The workflow panel's entry store (plan sidebar §L2.4): the selected
 * internal section, keyed by the sidebar tab record's id.
 *
 * Why a slot store and not `useState`: a docked sidebar body is UNMOUNTED
 * whenever another tab in the pane becomes active (and the sidebar layout is
 * memory-only), so component state would silently reset the section on every
 * glance at the file tree. The store instance is framework-cached per
 * (entry, session) and survives the unmount by construction; keying inside
 * the state by `tab.id` keeps two panes showing the panel independent. The
 * registration passes the handle as the seat's `store` option, so the body
 * receives `useStore` + the baked `select` action through its props share.
 */

import { defineStore } from '@deepseek-ai/dsh-client-store'

/** The panel's three internal sections (one sidebar tab, three sections). */
export type PanelSection = 'tasks' | 'agents' | 'events'

/** The entry-store state: the selected section per sidebar tab record. */
export interface PanelStoreState {
  byTab: Record<string, PanelSection | undefined>
}

/**
 * The panel entry store handle. `undefined` reads as the `'tasks'` default —
 * the body applies `?? 'tasks'` at the read site, so nothing writes the
 * default into the state.
 */
export function createPanelStore() {
  return defineStore({
    init: (): PanelStoreState => ({ byTab: {} }),
    actions: {
      select(d, tabId: string, section: PanelSection): void {
        d.byTab[tabId] = section
      },
    },
  })
}

export type PanelStore = ReturnType<typeof createPanelStore>
