/**
 * Morning Star workflow panel — dsh client plugin entry (spec §4.1):
 * `inject` (cordis service waits) + `apply(ctx: ClientContext)`.
 *
 * On apply: creates the engine-status client over the client `connection`
 * service (the panel's data path is the host's shared `/api` typert gateway —
 * the persisted catalog row is only the anchor), registers the `mstar-panel`
 * dictionaries, then waits for the ui-conversation `conversation.view`
 * declaration and registers the panel as a view tab (`id: 'mstar-workflow'`,
 * `order: 20`, locale-following label thunk — the trajectory precedent shape).
 * The tab label re-reads through `ctx.locale.bind(NS)` so a locale switch
 * flips it without re-registering.
 *
 * The client is created ONCE per apply and disposed with the fiber, so a
 * reloaded plugin starts from a clean snapshot cache.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { MstarEngineStatusClient, type MstarEngineStatusConnection } from './panel/engine-status-client.ts'
import { en, NS, zh } from './panel/locale.ts'
import { PanelView } from './panel/PanelView.tsx'

/** Cordis service faces the plugin waits for (spec §4.4: slots + sessions + locale + the wire). */
export const inject = ['slots', 'sessions', 'locale', 'connection']

export function apply(ctx: ClientContext): void {
  const engineStatus = new MstarEngineStatusClient(
    (ctx as unknown as { connection?: MstarEngineStatusConnection }).connection,
  )
  ctx.effect(() => () => engineStatus.dispose(), 'ui-mstar-panel: engine-status client')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-mstar-panel: dictionaries')
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'mstar-workflow',
    order: 20,
    label: () => ctx.locale.bind(NS)('view.mstar-workflow'),
    locale: NS,
  }, (props: Parameters<typeof PanelView>[0]) => PanelView({ ...props, engineStatus })))
}
