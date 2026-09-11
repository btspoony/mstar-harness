/**
 * AC6 transcript-row render assertion: the FIRST-PARTY transcript renders the
 * plugin's catalog row — label AND body — when the row carries the locked
 * three-member `plugin` source.
 *
 * Why this spec renders dsh's own chat bundle instead of the panel: the row
 * under test is produced by the host's chat projection and drawn by dsh's chat
 * UI, which this package does not own. Re-implementing either half would prove
 * nothing about what a user sees, so the spec drives the INSTALLED
 * `@deepseek-ai/dsh-client-ui-chat` browser bundle through the module-loader
 * shim (`./client-bundles.ts`) and asserts the HTML it produces:
 *
 * - `apply(ctx)` is called on a capture-only context, so the REAL node
 *   definitions and the REAL keyed `context` renderer are harvested;
 * - the durable log event (a `user/message` whose `source` is the locked
 *   `{ kind: 'plugin', plugin: 'mstar-engine', form: 'catalog' }` row)
 *   is projected through that definition's own `match` + `start`, so the row's
 *   `provenance` / `form` come from upstream's own code, not from this spec;
 * - the renderer is rendered with the disclosure OPEN (`react` is supplied
 *   with `useState` reporting its first state as `true`), because the collapsed
 *   row does not emit its body at all — the body is the half that decides
 *   whether the row is readable as data or falls back to opaque.
 *
 * Asserted surface (all real upstream output):
 * - the row's title label is non-empty and the row carries the source label
 *   span `data-context-source` with this plugin's identity — the label
 *   resolves through the first-party `plugin` arm;
 * - the body is the OPAQUE body: `data-context-injection-body` with NO
 *   `data-context-form`, carrying the model-facing text plus the raw source
 *   fields. The locked source carries no `entries`, and upstream's catalog body
 *   requires a readable `entries` list, so this is the documented fall-back —
 *   the row body stays opaque, unchanged by this plan;
 * - negative control: the SAME row with a readable `entries` list renders
 *   `data-context-form="catalog"` and the entry list. That isolates the cause
 *   of the opaque body to the missing `entries` rather than to a broken label,
 *   form or projection.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import * as realReact from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { clientExports } from './client-bundles.ts'

// Install the module-loader shim before importing the bundle: the `/client`
// subpath entries run `window.__ModuleLoader__.load(...)` at import time.
await import('@deepseek-ai/dsh-client-ui-chat/client')

/** React whose FIRST `useState` reports `true` — renders the disclosure open. */
const openedReact: unknown = new Proxy(realReact, {
  get: (target, prop) => prop === 'useState' ? () => [true, () => {}] : (target as Record<string | symbol, unknown>)[prop],
})

type ChatBundle = {
  apply(ctx: unknown): void
  EMPTY_CHAT_SNAPSHOT: unknown
}

/** A callable stand-in for every service face this spec does not exercise. */
const anything: Record<string | symbol, unknown> = new Proxy(function () {} as unknown as Record<string | symbol, unknown>, {
  get: (_target, prop) => (prop === 'then' || prop === Symbol.toPrimitive ? undefined : anything),
  apply: () => anything,
  construct: () => anything,
}) as Record<string | symbol, unknown>

/** One captured projectable node definition (upstream's own `kind`/`match`/`start`). */
interface NodeDefinition {
  readonly kind: string
  match(event: unknown): unknown
  start(context: unknown, match: unknown, reader: unknown): unknown
}

/** The locked source of the row under test: exactly three first-party members. */
const LOCKED_SOURCE = { kind: 'plugin', plugin: 'mstar-engine', form: 'catalog' } as const

/** The model-facing text the plugin emits beside the row (opaque body input). */
const MODEL_TEXT = '<mstar_engine_status>\nversion: 2.0.4\n</mstar_engine_status>'

/** Harvest upstream's chat bundle: its node definitions, renderers and dicts. */
function harvestChatBundle(): {
  definitions: NodeDefinition[]
  renderer: (props: unknown) => unknown
  t: (key: string, params?: Record<string, unknown>) => string
} {
  const bundle = clientExports('@deepseek-ai/dsh-client-ui-chat', { react: openedReact }) as unknown as ChatBundle
  const definitions: NodeDefinition[] = []
  const renderers = new Map<string, (props: unknown) => unknown>()
  const dicts = new Map<string, Record<string, Record<string, string>>>()

  const ctx = {
    slots: {
      inject: (_name: string, callback: () => unknown) => { callback(); return () => {} },
      register: (options: { key?: string; id?: string; name: string }, component: (props: unknown) => unknown) => {
        renderers.set(options.key ?? options.id ?? options.name, component)
        return () => {}
      },
    },
    effect: (fn: () => unknown) => { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
    locale: {
      register: (ns: string, dict: Record<string, Record<string, string>>) => { dicts.set(ns, dict); return () => {} },
      bind: (ns: string) => (key: string, params?: Record<string, unknown>) => {
        const raw = dicts.get(ns)?.en?.[key] ?? key
        return String(raw).replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''))
      },
    },
    uiSession: { provide: () => () => {} },
    uiConversation: new Proxy({} as Record<string | symbol, unknown>, {
      get: (_target, prop) => prop === 'events'
        ? new Proxy(function () {} as unknown as () => void, {
          get: (_inner, innerProp) => innerProp === 'register'
            ? (definition: NodeDefinition) => { definitions.push(definition); return () => {} }
            : anything,
          apply: () => anything,
        })
        : anything,
    }),
    settingsScope: {
      bind: () => ({
        subscribe: () => () => {},
        get: () => undefined,
        set: () => {},
        getSnapshot: () => ({ value: {} }),
        mode: 'default',
        setMode: () => {},
      }),
    },
  }

  bundle.apply(ctx)
  const renderer = renderers.get('context')
  if (renderer === undefined) throw new Error('the chat bundle registered no `context` renderer')
  const locale = ctx.locale.bind('chat')
  return { definitions, renderer, t: locale }
}

const { definitions, renderer, t } = harvestChatBundle()
const found = definitions.find((definition) => definition.kind === 'input-message')
if (found === undefined) throw new Error('the chat bundle registered no `input-message` definition')
const messageDefinition: NodeDefinition = found

/**
 * Render one `user/message` log event whose `source` is the given context
 * source, through upstream's own projection and renderer.
 * @param source - the durable context source.
 * @returns the row's static HTML.
 */
function renderTranscriptRow(source: unknown): string {
  const event = {
    type: 'user/message',
    surfaceOp: 'append',
    seq: 2,
    time: 1_720_000_000_000,
    data: { id: 'm-1', content: [{ type: 'text', text: MODEL_TEXT }], source },
  }
  // `match` + `start` are upstream's own projection steps; the match object
  // carries the event the real engine hands it.
  const match = { ...(messageDefinition.match(event) as object), event }
  const data = messageDefinition.start({ current: new Map() }, match, { previous: () => undefined })
  return renderToStaticMarkup(createElement(renderer as never, { node: { data }, t } as never))
}

/** Strip inline SVG so the assertions read the row's structure, not its icons. */
function withoutIcons(html: string): string {
  return html.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>')
}

describe('first-party transcript row — the locked engine-status source (AC6)', () => {
  it('renders the row: non-empty label + the plugin identity as the source label', () => {
    const html = withoutIcons(renderTranscriptRow(LOCKED_SOURCE))
    // The row exists and is an expandable disclosure row.
    expect(html).toContain('data-disclosure-row="true"')
    // Its label is non-empty (upstream's own `message.contextInjection` copy).
    expect(t('message.contextInjection').length).toBeGreaterThan(0)
    expect(html).toContain(`>${t('message.contextInjection')}<`)
    // The source label renders THIS plugin's identity — the label resolves
    // through the first-party `plugin` arm (`label = source.plugin`).
    expect(html).toContain('data-context-source="true"')
    expect(html).toContain('>mstar-engine<')
  })

  it('the body stays OPAQUE: no catalog form, the model-facing text plus the raw source fields', () => {
    const html = withoutIcons(renderTranscriptRow(LOCKED_SOURCE))
    // The body exists…
    expect(html).toContain('data-context-injection-body="true"')
    // …and it is the opaque presentation: the form attribute is emitted only
    // when a form's fields were readable, so its absence is the fall-back.
    expect(html).not.toContain('data-context-form=')
    // The durable content is shown verbatim (the only complete account the
    // transcript can give for an unreadable form)…
    expect(html).toContain('data-context-text="true"')
    expect(html).toContain('&lt;mstar_engine_status&gt;')
    // …alongside the source's own fields, so the row still names its producer.
    expect(html).toContain('data-context-fields="true"')
    expect(html).not.toContain('data-context-entries')
  })

  it('negative control: a readable entry list takes the catalog branch (isolates the opaque fall-back)', () => {
    const html = withoutIcons(renderTranscriptRow({
      ...LOCKED_SOURCE,
      // The locked row never carries this member — the control proves the
      // fall-back above is caused by the missing list, nothing else.
      entries: [{ name: 'plans', description: 'open plans' }],
    }))
    expect(html).toContain('data-context-form="catalog"')
    expect(html).toContain('data-context-entries="true"')
    expect(html).toContain('plans')
    expect(html).not.toContain('data-context-fields="true"')
  })

  it('a source carrying an unreadable entry list also falls back to opaque (never a partial list)', () => {
    const html = withoutIcons(renderTranscriptRow({ ...LOCKED_SOURCE, entries: [{ name: '', description: 'x' }] }))
    expect(html).not.toContain('data-context-form=')
    expect(html).toContain('data-context-injection-body="true"')
  })
})
