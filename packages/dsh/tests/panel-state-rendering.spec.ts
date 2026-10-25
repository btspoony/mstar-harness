/**
 * Every failure on this surface is a DESIGNED state, in both languages: the
 * shared state surfaces plus a human sentence per reason.
 *
 * The defect this pins: the panel rendered `工作区快照不可用：session-cwd-absent` — a
 * bare interpolated internal token. Now each reason has a human sentence through
 * the shared `Notice`/`EmptyState` surfaces, the code survives only as a
 * diagnostic attribute, and an unknown future reason still renders a designed
 * state rather than falling back to printing the token.
 */

import { describe, expect, it } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { clientExports } from './client-bundles.ts'
import { gatewayOk, SESSION, settleRender, stubGateway } from './gateway-stub.ts'
import { PanelSeat } from '../src/client/panel/panel-shell.tsx'
import { MstarPanelSnapshotClient } from '../src/client/panel/panel-snapshot-client.ts'
import { PANEL_SNAPSHOT_ENDPOINT } from '../src/engine-status-wire.ts'
import { en, NS, zh } from '../src/client/panel/locale.ts'

type LocaleClientExports = typeof import('@deepseek-ai/dsh-client-locale/client')
const { LocaleRuntime: LocaleRuntimeCtor } = clientExports('@deepseek-ai/dsh-client-locale') as unknown as
  Pick<LocaleClientExports, 'LocaleRuntime'>

const SESSION_CWD = '/proj'

function localeRuntime(active: 'en' | 'zh'): LocaleRuntime {
  const locale = new LocaleRuntimeCtor(new Context())
  locale.register(NS, { zh, en })
  locale.setLocale(active)
  return locale
}

/** Render the seat with a digest transport answering `payload`. */
async function renderSeat(payload: unknown, active: 'en' | 'zh' = 'en', scheme?: 'light' | 'dark'): Promise<string> {
  const locale = localeRuntime(active)
  const gateway = stubGateway()
  gateway.replyFor(PANEL_SNAPSHOT_ENDPOINT, gatewayOk(payload))
  const client = new MstarPanelSnapshotClient(gateway.connection)
  let markup = ''
  for (let pass = 0; pass < 3; pass += 1) {
    markup = await settleRender(() =>
      renderToStaticMarkup(createElement(PanelSeat, {
        visible: true,
        destination: 'focus',
        onSelect: () => {},
        t: locale.bind(NS),
        sessionId: SESSION,
        useSessions: ((selector: (state: unknown) => unknown) =>
          selector({ byId: { [SESSION]: { id: SESSION, cwd: SESSION_CWD } } })) as never,
        panelSnapshot: client,
        localeFace: locale,
        ...(scheme === undefined ? {} : { themeFace: { getSnapshot: () => scheme, subscribe: () => () => {} } }),
      } as never)))
  }
  return markup
}

/** Occurrences of a token in the markup (attribute included). */
function count(markup: string, token: string): number {
  return markup.split(token).length - 1
}

describe('failure reasons render as human sentences, never as tokens', () => {
  const CASES = [
    ['session-absent', en['state.failure.session-absent'], zh['state.failure.session-absent']],
    ['session-cwd-absent', en['state.failure.session-cwd-absent'], zh['state.failure.session-cwd-absent']],
    ['session-inspect-failed', en['state.failure.session-inspect-failed'], zh['state.failure.session-inspect-failed']],
    ['cwd-mismatch', en['state.failure.cwd-mismatch'], zh['state.failure.cwd-mismatch']],
    ['malformed-answer', en['state.failure.malformed-answer'], zh['state.failure.malformed-answer']],
  ] as const

  for (const [reason, english, chinese] of CASES) {
    it(`${reason}: shared Notice anchor, human sentence, code only as an attribute`, async () => {
      const payload = { kind: 'unavailable', reason }
      const markup = await renderSeat(payload, 'en')
      // The shared state surface, with its tone anchor.
      expect(markup).toContain('data-ms-notice-tone="warning"')
      expect(markup).toContain(english)
      // The diagnostic attribute keeps the code for a maintainer…
      expect(markup).toContain(`data-mstar-reason="${reason}"`)
      // …and the reader sees it NOWHERE else: exactly one occurrence, in that attribute.
      expect(count(markup, reason)).toBe(1)
    })

    it(`${reason}: the Chinese sentence, and still no token in the text`, async () => {
      const markup = await renderSeat({ kind: 'unavailable', reason }, 'zh')
      expect(markup).toContain('data-ms-notice-tone="warning"')
      expect(markup).toContain(chinese)
      expect(count(markup, reason)).toBe(1)
    })
  }

  it('no-harness reads as an absence explanation, not an error or a token', async () => {
    const markup = await renderSeat({ kind: 'no-harness' }, 'en')
    expect(markup).toContain('data-ms-absence="absent"')
    expect(markup).toContain(en['empty.no-harness'])
    // The hint is the actionable line.
    expect(markup).toContain(en['empty.no-harness-hint'])
  })

  it('an UNKNOWN future reason still renders a designed state, never the token', async () => {
    const markup = await renderSeat({ kind: 'unavailable', reason: 'brand-new-reason' }, 'en')
    expect(markup).toContain('data-ms-notice-tone="warning"')
    expect(markup).toContain(en['state.failure.unknown'])
    expect(count(markup, 'brand-new-reason')).toBe(1)
  })

  it('no failure key carries a {reason} placeholder any more', () => {
    for (const locale of [en, zh]) {
      for (const [key, value] of Object.entries(locale)) {
        // The picker's own `state.pick.failed` interpolates the PICKER's message
        // (a human string), not an internal token — this rule is about the
        // failure keys that used to splice a reason code into a sentence.
        if (!key.startsWith('state.failure.') && key !== 'empty.no-harness-hint') continue
        expect({ key, value }).not.toMatchObject({ value: expect.stringContaining('{reason}') })
      }
    }
  })
})

describe('every failure arm carries the host scheme', () => {
  it('a dark host themes the failure state (the carrier is an ancestor of the message)', async () => {
    const markup = await renderSeat({ kind: 'unavailable', reason: 'session-cwd-absent' }, 'en', 'dark')
    // The shared surfaces paint `--ms-*`: outside a `data-ms-theme` carrier they
    // render the light token set under a dark host — the pre-fix behaviour, where
    // these arms returned BEFORE `PanelShell`'s wrapper existed.
    expect(markup).toContain('data-ms-theme="dark"')
    expect(markup).toContain('data-ms-notice-tone="warning"')
    expect(markup.indexOf('data-ms-theme="dark"')).toBeLessThan(markup.indexOf('data-ms-notice-tone'))
  })

  it('the light host gets the light carrier, and no-harness/loading/waiting arms get one too', async () => {
    for (const payload of [{ kind: 'unavailable', reason: 'session-absent' }, { kind: 'no-harness' }, { kind: 'ok', snapshot: null }]) {
      const markup = await renderSeat(payload, 'en', 'light')
      expect(markup).toContain('data-ms-theme="light"')
    }
  })

  it('a dark host themes the no-harness absence too', async () => {
    const markup = await renderSeat({ kind: 'no-harness' }, 'en', 'dark')
    expect(markup).toContain('data-ms-theme="dark"')
    expect(markup.indexOf('data-ms-theme="dark"')).toBeLessThan(markup.indexOf('data-ms-absence'))
  })
})
