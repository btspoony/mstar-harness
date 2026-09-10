/**
 * Morning Star workflow panel — dsh client plugin entry (plan sidebar §L1.3):
 * `inject` (cordis service waits) + `apply(ctx: ClientContext)`.
 *
 * On apply: creates the engine-status client over the client `connection`
 * service (the panel's data path is the host's shared `/api` typert gateway —
 * the persisted catalog row is only the anchor), registers the `mstar-panel`
 * dictionaries, registers the panel as a right-Sidebar page tab type
 * (`ctx.sidebarRightTabs.register`, `kind: 'mstar-workflow'`, one guide
 * capsule at order 20), then waits for the ui-sidebar-right seat
 * declarations and registers the panel body and its chip title as keyed
 * entries under the definition's `id` — the two-stage seat contract. The old
 * conversation-area view-tab registration is gone: the sidebar tab REPLACES
 * the conversation-area tab (a migration, not a second surface).
 *
 * The client is created ONCE per apply and disposed with the fiber, so a
 * reloaded plugin starts from a clean snapshot cache. Every registration
 * sits in its own `ctx.effect` so unload disposes it.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { MSTAR_PANEL_ID, mstarPanelDefinition } from './panel/definition.ts'
import { MstarEngineStatusClient, type MstarEngineStatusConnection } from './panel/engine-status-client.ts'
import { MstarPanelTitle } from './panel/MstarPanelTitle.tsx'
import { en, NS, zh } from './panel/locale.ts'
import { createPanelStore } from './panel/panel-store.ts'
import { PanelView } from './panel/PanelView.tsx'

/**
 * Cordis service faces the plugin waits for (spec §4.4: slots + sessions +
 * locale + the wire + the tab-type registry). `sessions` is load-bearing as
 * the session standard scope's wait and `connection` carries the
 * engine-status transport; `sidebarRightTabs` is the registry `apply`
 * registers the page tab type into.
 */
export const inject = ['slots', 'sessions', 'locale', 'connection', 'sidebarRightTabs']

export function apply(ctx: ClientContext): void {
  const engineStatus = new MstarEngineStatusClient(
    (ctx as unknown as { connection?: MstarEngineStatusConnection }).connection,
  )
  ctx.effect(() => () => engineStatus.dispose(), 'ui-mstar-panel: engine-status client')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-mstar-panel: dictionaries')
  ctx.effect(
    () => ctx.sidebarRightTabs.register(mstarPanelDefinition(t)),
    'ui-mstar-panel: tab type',
  )
  // The body seat closes over the engine-status client exactly as the old
  // view-tab registration did: the transport is a plugin-level concern, never
  // a host-supplied prop. The `store` option hands the seat the panel's
  // entry store (plan sidebar §L2.4): the framework caches one instance per
  // (entry, session), so the selected section survives the body's unmount
  // while another pane tab is active.
  const panelStore = createPanelStore()
  ctx.effect(
    () => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: MSTAR_PANEL_ID,
      locale: NS,
      store: panelStore,
    }, (props: Parameters<typeof PanelView>[0]) => PanelView({ ...props, engineStatus }))),
    'ui-mstar-panel: panel body',
  )
  ctx.effect(
    () => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: MSTAR_PANEL_ID,
    }, MstarPanelTitle)),
    'ui-mstar-panel: panel chip title',
  )
}
