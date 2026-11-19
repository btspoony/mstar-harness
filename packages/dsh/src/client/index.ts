/**
 * Morning Star workflow panel — dsh client plugin entry (plan sidebar §L1.3):
 * `inject` (cordis service waits) + `apply(ctx: ClientContext)`.
 *
 * On apply: creates the two panel clients over the client `connection` service
 * (the panel's data path is the host's shared `/api` typert gateway: a polled
 * store-backed snapshot, plus the picker's durable write), registers the
 * `mstar-panel` dictionaries, registers the panel as a right-Sidebar page tab type
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
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { MSTAR_PANEL_ID, mstarPanelDefinition } from './panel/definition.ts'
import { MstarWorkflowPickerClient, type MstarWorkflowPickerConnection } from './panel/workflow-picker-client.ts'
import { MstarPanelSnapshotClient } from './panel/panel-snapshot-client.ts'
import { MstarPanelTitle } from './panel/MstarPanelTitle.tsx'
import { createHostThemeFace } from './panel/theme.ts'
import { en, NS, zh } from './panel/locale.ts'
import { createPanelStore } from './panel/panel-store.ts'
import { PanelView } from './panel/PanelView.tsx'

/**
 * Cordis service faces the plugin waits for (spec §4.4: slots + sessions +
 * locale + the wire + the tab-type registry). `sessions` is load-bearing as
 * the session standard scope's wait and `connection` carries the
 * engine-status transport; `sidebarRightTabs` is the registry `apply`
 * registers the page tab type into; `layout` is the panel-selection face the
 * panel's own surfaces drive (a cordis service, so it is declared here before
 * any selection can be reached).
 */
export const inject = ['slots', 'sessions', 'locale', 'connection', 'sidebarRightTabs', 'theme']

export function apply(ctx: ClientContext): void {
  const connection = (ctx as unknown as { connection?: MstarWorkflowPickerConnection }).connection
  const picker = new MstarWorkflowPickerClient(connection)
  ctx.effect(() => () => picker.dispose(), 'ui-mstar-panel: workflow picker client')
  // The store-backed read: the panel polls `mstar/panelSnapshot` while its tab
  // is visible (the hook drives start/stop) — the retired emission read's
  // replacement.
  // One RPC face, no store and no timer: nothing to dispose with the fiber.
  const panelSnapshot = new MstarPanelSnapshotClient(connection)
  // The host's colour SCHEME, never its palette (compass constraint 4): the
  // product's own `--ms-*` values stay, and the scheme flips the shared
  // `[data-ms-theme]` token block.
  const theme = createHostThemeFace(ctx.theme, (listener) => ctx.on('theme/change', listener))
  ctx.effect(() => () => theme.dispose(), 'ui-mstar-panel: theme bridge')
  const themeFace = theme.face
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-mstar-panel: dictionaries')
  ctx.effect(
    () => ctx.sidebarRightTabs.register(mstarPanelDefinition(t)),
    'ui-mstar-panel: tab type',
  )
  // ONE entry: the session's right-pane tab. The product is per-repository state,
  // so the host's GLOBAL panel list gets no row from this plugin — and with no
  // global row there is no keyed `main` seat to open, and no selection call.
  // The body seat closes over the two clients exactly as the old view-tab
  // registration did: the transport is a plugin-level concern, never a
  // host-supplied prop. The `store` option hands the seat the panel's
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
    }, (props: Parameters<typeof PanelView>[0]) =>
      PanelView({
        ...props,
        picker,
        panelSnapshot,
        localeFace: ctx.locale,
        themeFace,
      }))),
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
