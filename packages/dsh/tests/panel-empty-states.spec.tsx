/**
 * Empty-state render tests for the panel's degraded branches: the no-harness
 * card, the waiting state, and the EXPLICIT unavailable state.
 *
 * - no harness (`harnessDir === null && state === null && iteration == null`):
 *   a CENTERED inactive-state card — icon (`data-mstar-empty-icon`) + title
 *   (the reused `empty.no-harness` key, `data-mstar-empty="no-harness"`) +
 *   hint (`empty.no-harness-hint`) inside a card container
 *   (`data-mstar-empty-card`), with the freshness footer, and NO tabs / NO
 *   sidebar / NO meta dock; a harness-present source keeps the normal panel.
 * - waiting (no anchor row): its own anchor, no centered card.
 * - unavailable (the gateway answered a degraded result, or the transport
 *   failed): its own anchor + the machine-readable reason — the panel NEVER
 *   renders an empty plans list / event log / zeroed counter instead.
 *
 * The panel's data path is the host's shared `/api` typert gateway (the
 * persisted catalog row is only the anchor), so these specs stub THE CHANNEL
 * through `./gateway-stub.ts` and render the settled state.
 *
 * The CSS contract (single-column no-harness root + the centered muted card)
 * is asserted against the raw panel.module.css text — under `bun test` the
 * `*.module.css` import resolves to the raw file-path string, so class
 * attributes are dropped from renders and assertions pin `data-*` anchors +
 * CSS text (the established pattern in client-panel.spec.tsx).
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { clientExports } from './client-bundles.ts'
import { Context } from '@deepseek-ai/cordis'
import type { MstarEngineStatusPayload } from '../src/types'
import type { EnforcementSource } from '@mstar-harness/engine'
import { en, NS, zh } from '../src/client/panel/locale'
import { PanelView } from '../src/client/panel/PanelView'
import { MstarEngineStatusClient } from '../src/client/panel/engine-status-client'
import {
  anchorSnapshot,
  bindUseChat,
  bindUseSessions,
  gatewayError,
  SESSION,
  SESSION_CWD,
  SESSION_ID,
  SNAPSHOT_AT,
  servedSnapshot,
  settleRender,
  stubGateway,
} from './gateway-stub.ts'

// The REAL client service values — the store is a plain Node-ESM module
// (direct import); LocaleRuntime is a cordis service loaded from the browser
// bundle through the loader shim (tests/client-bundles.ts).
type LocaleClientExports = typeof import('@deepseek-ai/dsh-client-locale/client')
const { LocaleRuntime: LocaleRuntimeCtor } = clientExports('@deepseek-ai/dsh-client-locale') as unknown as
  Pick<LocaleClientExports, 'LocaleRuntime'>

/** One real LocaleRuntime over a fresh cordis context. */
function newLocale(): LocaleRuntime {
  return new LocaleRuntimeCtor(new Context())
}

/* ------------------------------ fixtures ------------------------------ */

/** `state` null + harnessDir null + no iteration ⇒ no-harness state (spec §3). */
const noHarnessSource: MstarEngineStatusPayload = {
  version: '2.1.1',
  harnessDir: null,
  enforcement: { hard: false, source: 'iteration compass' as EnforcementSource },
  state: null,
}

/** Harness present (state renders normally, no iteration) ⇒ the normal panel branch. */
const harnessSource: MstarEngineStatusPayload = {
  version: '2.1.1',
  harnessDir: '/proj/.mstar',
  enforcement: { hard: false, source: 'iteration compass' as EnforcementSource },
  state: {
    selection: { kind: 'active', workflowId: 'wf-1', dir: 'workflows/wf-1' },
    workflowType: 'plan',
    workflowStatus: 'running',
    plans: [],
    residuals: [],
    residualFindings: null,
    project: { milestones: [], openResiduals: [] },
    iterationBaseBranch: null,
    targetBranch: null,
    specIntegrationBranch: null,
    pushPolicy: null,
    worktreeMode: null,
    controlWorktreePath: null,
    leases: [],
    knowledge: null,
    direction: null,
    agentFlow: null,
  },
}

/* --------------------------- render plumbing --------------------------- */

const ANCHOR_TIME = 1_720_001_000_000

/**
 * Render the panel to static HTML through the real data path: anchor snapshot
 * → `useChat`/`useSessions` → hook → the `/api` gateway → `PanelView`. The
 * first pass issues the gateway call; the returned markup is the settled one.
 */
async function panelHtml(
  source: MstarEngineStatusPayload | null,
  lang: 'en' | 'zh' = 'en',
  reply?: unknown,
): Promise<string> {
  const locale = newLocale()
  locale.register(NS, { zh, en })
  locale.setLocale(lang)
  const store = { getSnapshot: () => anchorSnapshot(source === null ? null : ANCHOR_TIME) }
  const gateway = stubGateway(reply ?? servedSnapshot(source, { at: SNAPSHOT_AT }))
  const engineStatus = new MstarEngineStatusClient(gateway.connection)
  return settleRender(() => renderToStaticMarkup(createElement(PanelView, {
    sessionId: SESSION,
    useChat: bindUseChat(store),
    useSessions: bindUseSessions(SESSION_ID, SESSION_CWD),
    engineStatus,
    t: locale.bind(NS),
    // Visible-tab stub (the sidebar seat's tab-information hook); the gate
    // itself is client-seat.spec.ts's subject — this spec asserts the
    // degraded branches, so every render here sees a visible tab.
    useTabInfo: () => ({ tab: { visible: true } }),
  } as never)))
}

/* ------------------------------- tests -------------------------------- */

describe('workflow panel — no-harness centered inactive state ', () => {
  it('no harness → centered inactive-state card (icon + title + hint + freshness), no tabs / sidebar / meta dock', async () => {
    const html = await panelHtml(noHarnessSource)
    expect(html).toContain('data-mstar-panel="no-harness"')
    // The content-container anchor contract stays on the no-harness main.
    expect(html).toContain('data-mstar-graph')
    // The centered card DOM: card container + icon + the reused title anchor.
    expect(html).toContain('data-mstar-empty-card')
    expect(html).toContain('data-mstar-empty-icon')
    expect(html).toContain('data-mstar-empty="no-harness"')
    expect(html).toContain('No Morning Star harness detected')
    expect(html).toContain('No .mstar/ harness directory found in this workspace')
    // Freshness stays; tabs / sidebar / meta dock never mount in this branch.
    expect(html).toContain('data-mstar-freshness')
    expect(html).not.toContain('data-mstar-tab-nav')
    expect(html).not.toContain('data-mstar-sidebar')
    expect(html).not.toContain('data-mstar-meta')
  })

  it('card DOM order: icon → title → hint, all inside the card container', async () => {
    const html = await panelHtml(noHarnessSource)
    const cardStart = html.indexOf('data-mstar-empty-card')
    const icon = html.indexOf('data-mstar-empty-icon')
    const title = html.indexOf('data-mstar-empty="no-harness"')
    const hint = html.indexOf('No .mstar/ harness directory found in this workspace')
    expect(cardStart).toBeGreaterThan(-1)
    expect(icon).toBeGreaterThan(-1)
    expect(title).toBeGreaterThan(-1)
    expect(hint).toBeGreaterThan(-1)
    expect(cardStart).toBeLessThan(icon)
    expect(icon).toBeLessThan(title)
    expect(title).toBeLessThan(hint)
  })

  it('zh locale localizes the card title + hint', async () => {
    const html = await panelHtml(noHarnessSource, 'zh')
    expect(html).toContain('data-mstar-empty-card')
    expect(html).toContain('未检测到 Morning Star harness')
    expect(html).toContain('未发现 .mstar/ harness 目录')
  })

  it('with harness → the normal panel is unchanged: tabs + sidebar, no centered empty card', async () => {
    const html = await panelHtml(harnessSource)
    expect(html).toContain('data-mstar-panel="panel"')
    expect(html).toContain('data-mstar-tab-nav')
    expect(html).toContain('data-mstar-sidebar')
    expect(html).toContain('data-mstar-graph')
    expect(html).not.toContain('data-mstar-empty-card')
    expect(html).not.toContain('data-mstar-empty-icon')
    expect(html).not.toContain('data-mstar-empty="no-harness"')
  })

  it('waiting branch (no anchor row) is untouched — its own anchor, no centered card', async () => {
    const html = await panelHtml(null)
    expect(html).toContain('data-mstar-panel="waiting"')
    expect(html).toContain('data-mstar-empty="waiting"')
    expect(html).not.toContain('data-mstar-empty-card')
    expect(html).not.toContain('data-mstar-empty-icon')
  })

  it('unavailable branch: the transport failure renders its own anchor + reason — never a silently-empty panel', async () => {
    const html = await panelHtml(harnessSource, 'en', gatewayError('timeout', 'gateway unreachable'))
    expect(html).toContain('data-mstar-panel="unavailable"')
    expect(html).toContain('data-mstar-empty="unavailable"')
    expect(html).toContain('data-mstar-unavailable-reason="transport-error:timeout"')
    expect(html).toContain('Engine-status snapshot unavailable (transport-error:timeout)')
    // No data surfaces: no tabs, no sidebar, no kanban skeleton, no counters.
    expect(html).not.toContain('data-mstar-tab-nav')
    expect(html).not.toContain('data-mstar-sidebar')
    expect(html).not.toContain('data-mstar-kanban')
    expect(html).not.toContain('data-mstar-freshness')
  })

  it('unavailable branch localizes in zh', async () => {
    const html = await panelHtml(harnessSource, 'zh', gatewayError('timeout'))
    expect(html).toContain('data-mstar-empty="unavailable"')
    expect(html).toContain('engine-status 快照不可用（transport-error:timeout）')
  })

  it('CSS contract: single-column no-harness root + centered muted card (flex center, no orange)', () => {
    const cssText = readFileSync(new URL('../src/client/panel/panel.module.css', import.meta.url), 'utf8')
    // The single-column no-harness root (existing contract).
    expect(cssText).toMatch(/\.root\[data-mstar-panel='no-harness'\]\s*\{[\s\S]*?grid-template-columns:\s*1fr/)
    // The centered card: flex centering + a muted frame.
    const card = cssText.match(/\.noHarnessCard\s*\{[\s\S]*?\}/)
    expect(card).not.toBeNull()
    expect(card![0]).toContain('align-items: center')
    expect(card![0]).toContain('justify-content: center')
    expect(card![0]).toContain('border: 1px solid var(--dsw-alias-border-l1)')
    expect(card![0]).toContain('border-radius: 8px')
    // Muted only — no orange/error state token on the card, and the file
    // carries zero bare colors (the theme audit stays green).
    expect(card![0]).not.toMatch(/state-(?:warn|error)-/)
    expect(cssText).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  })
})
