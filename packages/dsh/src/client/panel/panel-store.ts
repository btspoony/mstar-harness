/**
 * The workflow panel's entry store: the active DESTINATION, keyed by the sidebar
 * tab record's id.
 *
 * Why a slot store and not `useState`: a docked sidebar body is UNMOUNTED
 * whenever another tab in the pane becomes active (and the sidebar layout is
 * memory-only), so component state would silently reset the destination on every
 * glance at the file tree. The store instance is framework-cached per (entry,
 * session) and survives the unmount by construction; keying the state by
 * `tab.id` keeps two panes showing the panel independent. The registration
 * passes the handle as the seat's `store` option, so the body receives
 * `useStore` + the baked `select` action through its props share.
 */

import { defineStore } from '@deepseek-ai/dsh-client-store'

/**
 * The panel's destinations: the five product destinations plus this host's
 * session landing. The ids are the shared nav's ids (IA §8.2 order), so the
 * store never invents a vocabulary of its own.
 */
export type PanelDestination = 'focus' | 'overview' | 'issues' | 'workflows' | 'iterations' | 'projects'

/** Legal destinations, in nav order. */
const DESTINATIONS: readonly PanelDestination[] = ['focus', 'overview', 'issues', 'workflows', 'iterations', 'projects']

/**
 * Is this string a legal destination? The store's `select` refuses anything
 * else, so a stale or hand-written id can never be written into the state and
 * never reaches a render.
 */
export function isPanelDestination(value: unknown): value is PanelDestination {
  return typeof value === 'string' && (DESTINATIONS as readonly string[]).includes(value)
}

/** The entry-store state: the active destination per sidebar tab record. */
export interface PanelStoreState {
  byTab: Record<string, PanelDestination | undefined>
}

/**
 * The panel entry store handle. `undefined` reads as the `'focus'` default — the
 * body applies `?? 'focus'` at the read site, so nothing writes the default into
 * the state.
 */
export function createPanelStore() {
  return defineStore({
    init: (): PanelStoreState => ({ byTab: {} }),
    actions: {
      select(d, tabId: string, destination: PanelDestination): void {
        // A refused id leaves the previous destination untouched (never a blank body).
        if (!isPanelDestination(destination)) return
        d.byTab[tabId] = destination
      },
    },
  })
}

export type PanelStore = ReturnType<typeof createPanelStore>
