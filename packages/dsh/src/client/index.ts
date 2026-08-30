/**
 * Morning Star workflow panel — dsh client plugin entry (spec §4.1):
 * `inject` (cordis service waits) + `apply(ctx: ClientContext)`.
 *
 * On apply: registers the `mstar-panel` dictionaries, then waits for the
 * ui-conversation `conversation.view` declaration and registers the panel as
 * a view tab (`id: 'mstar-workflow'`, `order: 20`, locale-following label
 * thunk — the trajectory precedent shape). The tab label re-reads through
 * `ctx.locale.bind(NS)` so a locale switch flips it without re-registering.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, NS, zh } from './panel/locale.ts'
import { PanelView } from './panel/PanelView.tsx'

/** Cordis service faces the plugin waits for (spec §4.4: slots + sessions + locale). */
export const inject = ['slots', 'sessions', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-mstar-panel: dictionaries')
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'mstar-workflow',
    order: 20,
    label: () => ctx.locale.bind(NS)('view.mstar-workflow'),
    locale: NS,
  }, PanelView))
}
