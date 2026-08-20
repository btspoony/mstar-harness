/**
 * Empty-state render tests for the no-harness branch (plan
 * 20260812-panel-f5-agent-layout Task 3): when the catalog source carries no
 * harness (`harnessDir === null && state === null && iteration == null`), the
 * panel renders a CENTERED inactive-state card — icon (`data-mstar-empty-icon`)
 * + title (the reused `empty.no-harness` key, `data-mstar-empty="no-harness"`)
 * + hint (`empty.no-harness-hint`) inside a card container
 * (`data-mstar-empty-card`), with the freshness footer, and NO tabs / NO
 * sidebar / NO meta dock — replacing the former left-aligned hint. A
 * harness-present source keeps the normal panel unchanged (tabs + sidebar,
 * no centered card). The waiting branch (no catalog row) is untouched.
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
import type { ConversationNode, ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { clientExports } from './client-bundles.ts'
import { Context } from '@deepseek-ai/cordis'
import type { MstarEngineStatusSource } from '../src/types'
import type { EnforcementSource } from '@mstar-harness/engine'
import { en, NS, zh } from '../src/client/panel/locale'
import { PanelView } from '../src/client/panel/PanelView'

// The REAL client service values — loaded from the browser bundles through the
// loader shim (tests/client-bundles.ts).
type LocaleClientExports = typeof import('@deepseek-ai/dsh-client-locale/client')
const { LocaleRuntime: LocaleRuntimeCtor } = clientExports('@deepseek-ai/dsh-client-locale') as unknown as
  Pick<LocaleClientExports, 'LocaleRuntime'>
type RuntimeClientExports = typeof import('@deepseek-ai/dsh-client-runtime/client')
const { createSnapshotStore } = clientExports('@deepseek-ai/dsh-client-runtime') as unknown as
  Pick<RuntimeClientExports, 'createSnapshotStore'>

/** One real LocaleRuntime over a fresh cordis context. */
function newLocale(): LocaleRuntime {
  return new LocaleRuntimeCtor(new Context())
}

/* ------------------------------ fixtures ------------------------------ */

/** `state` null + harnessDir null + no iteration ⇒ no-harness state (spec §3). */
const noHarnessSource: MstarEngineStatusSource = {
  kind: 'mstar-engine-status',
  form: 'catalog',
  version: '2.1.1',
  harnessDir: null,
  enforcement: { hard: false, source: 'iteration compass' as EnforcementSource },
  state: null,
}

/** Harness present (state renders normally, no iteration) ⇒ the normal panel branch. */
const harnessSource: MstarEngineStatusSource = {
  kind: 'mstar-engine-status',
  form: 'catalog',
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

/** Session-standard kit the view ring hands every conversation.view entry (stub faces; unused by the pure render). */
function kitProps(overrides?: Partial<ConvViewProps>): ConvViewProps {
  return {
    sessionId: 's-1' as SessionId,
    useSession: (() => null) as never,
    useProjection: (() => null) as never,
    useSessions: (() => null) as never,
    useWorkspaces: (() => null) as never,
    ...overrides,
  } as unknown as ConvViewProps
}

/** Plain selector binding over the stub snapshot store (dev-time twin of the real uSES binding). */
function bindUseSession(store: { getSnapshot(): ConversationSnapshot }): SnapshotSelectorHook<ConversationSnapshot> {
  return function useSelector<S>(sel: (s: ConversationSnapshot) => S): S {
    return sel(store.getSnapshot())
  }
}

/** Build a conversation snapshot carrying the fixture source as the newest catalog row (spec §5 data path). */
function snapshotFor(source: MstarEngineStatusSource | null, lastUpdated: number | null): ConversationSnapshot {
  const nodes: ConversationNode[] = [
    { kind: 'user', seq: 1, time: 1_719_999_000_000, content: [], source: null },
  ]
  if (source !== null) {
    nodes.push({
      kind: 'context',
      seq: 2,
      time: lastUpdated ?? 1_720_001_000_000,
      content: [],
      source,
      form: 'catalog',
    } as unknown as ConversationNode)
  }
  return {
    sessionId: 's-1' as SessionId,
    nodes,
    running: false,
    openState: 'open',
    composerPhase: 'active',
    blank: false,
  } as unknown as ConversationSnapshot
}

/** Render the panel to static HTML through the real data path: snapshot store → useSession → hook → PanelView. */
function panelHtml(
  source: MstarEngineStatusSource | null,
  lang: 'en' | 'zh' = 'en',
  lastUpdated: number | null = 1_720_001_000_000,
): string {
  const locale = newLocale()
  locale.register(NS, { zh, en })
  locale.setLocale(lang)
  const store = createSnapshotStore(snapshotFor(source, lastUpdated))
  return renderToStaticMarkup(createElement(PanelView, {
    ...kitProps({ useSession: bindUseSession(store) }),
    t: locale.bind(NS),
  }))
}

/* ------------------------------- tests -------------------------------- */

describe('workflow panel — no-harness centered inactive state (plan 20260812-panel-f5-agent-layout T3)', () => {
  it('no harness → centered inactive-state card (icon + title + hint + freshness), no tabs / sidebar / meta dock', () => {
    const html = panelHtml(noHarnessSource)
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

  it('card DOM order: icon → title → hint, all inside the card container', () => {
    const html = panelHtml(noHarnessSource)
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

  it('zh locale localizes the card title + hint', () => {
    const html = panelHtml(noHarnessSource, 'zh')
    expect(html).toContain('data-mstar-empty-card')
    expect(html).toContain('未检测到 Morning Star harness')
    expect(html).toContain('未发现 .mstar/ harness 目录')
  })

  it('with harness → the normal panel is unchanged: tabs + sidebar, no centered empty card', () => {
    const html = panelHtml(harnessSource)
    expect(html).toContain('data-mstar-panel="panel"')
    expect(html).toContain('data-mstar-tab-nav')
    expect(html).toContain('data-mstar-sidebar')
    expect(html).toContain('data-mstar-graph')
    expect(html).not.toContain('data-mstar-empty-card')
    expect(html).not.toContain('data-mstar-empty-icon')
    expect(html).not.toContain('data-mstar-empty="no-harness"')
  })

  it('waiting branch (no catalog row) is untouched — its own anchor, no centered card', () => {
    const html = panelHtml(null)
    expect(html).toContain('data-mstar-panel="waiting"')
    expect(html).toContain('data-mstar-empty="waiting"')
    expect(html).not.toContain('data-mstar-empty-card')
    expect(html).not.toContain('data-mstar-empty-icon')
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
    // carries zero bare colors (the T4 theme audit stays green).
    expect(card![0]).not.toMatch(/state-(?:warn|error)-/)
    expect(cssText).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  })
})
