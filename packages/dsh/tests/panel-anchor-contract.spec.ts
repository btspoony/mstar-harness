/**
 * Panel ANCHOR CONTRACT (plan sidebar §L6.2, AC5 + AC6) — a SOURCE-LEVEL
 * resurrection guard over `src/client/**`: the deleted surfaces must stay
 * deleted. The sidebar migration (plan sidebar) removed the conversation
 * view seat, the composer-overlay opt-in and the `ctx.sessions` wait; the
 * agents re-layout (plan sidebar §L3) deleted the agent canvas with its
 * pan subsystem, geometry layer, card ports and SVG edge layer; the
 * narrow-column shell (§L2.6) made "no layout-bound work" operational: the
 * panel performs NO JS layout measurement in any state. This spec pins all
 * three contracts at the source level so a resurrection fails a test, not
 * a user.
 *
 * Raw-token scanning (no comment stripping): a resurrected anchor would be
 * live code, and the deleted tokens have no legitimate use in a comment —
 * if a comment ever needs to NAME a deleted anchor, it must phrase around
 * it (that is the point: the vocabulary dies with the code).
 */

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'

/** Extensions scanned (the client tree is TS/TSX/CSS only). */
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.css']

/** Every file under `dir` (recursively) matching the scanned extensions,
 * as absolute paths — deterministic order. */
function collectFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...collectFiles(full))
    else if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full)
  }
  return out.sort()
}

const CLIENT_DIR = new URL('../src/client/', import.meta.url).pathname
const PANEL_DIR = new URL('../src/client/panel/', import.meta.url).pathname
/** The retired agents page — its absence is the contract. */
const LIST_PAGE = new URL('../src/client/panel/pages/AgentListPage.tsx', import.meta.url).pathname

/** The first file containing the token (for the failure message), if any. */
function firstHolder(files: readonly string[], token: string): string | null {
  for (const file of files) {
    if (readFileSync(file, 'utf8').includes(token)) return file
  }
  return null
}

/** Assert at least one file in the set contains EACH token. */
function expectPresent(files: readonly string[], tokens: readonly string[]): void {
  for (const token of tokens) {
    const holder = firstHolder(files, token)
    expect(holder !== null, `required token "${token}" is missing from every scanned file`).toBe(true)
  }
}

/** Assert the given path no longer exists. */
function expectFileAbsent(path: string): void {
  let exists = true
  try {
    readFileSync(path, 'utf8')
  } catch {
    exists = false
  }
  expect(exists, `deleted file ${path} is back`).toBe(false)
}

/** Assert NO file in the set contains ANY of the tokens. */
function expectAbsent(files: readonly string[], tokens: readonly string[]): void {
  for (const token of tokens) {
    const holder = firstHolder(files, token)
    expect(holder === null, `deleted token "${token}" resurrected in ${holder ?? '<nowhere>'}`).toBe(true)
  }
}

describe('panel anchor contract — deleted conversation-view seat stays deleted (plan sidebar §L1, AC1)', () => {
  it('src/client/** carries no composer-overlay opt-in, no conversation.view registration, no ctx.sessions', () => {
    expectAbsent(collectFiles(CLIENT_DIR), [
      'data-conversation-composer-overlay',
      'conversation.view',
      'ctx.sessions',
    ])
  })
})

describe('panel anchor contract — the agent canvas stays deleted (plan sidebar §L3.4/§L3.5, AC5)', () => {
  it('src/client/** carries no canvas anchor, no card port anchor, no deleted edge-anchor family', () => {
    expectAbsent(collectFiles(CLIENT_DIR), [
      'data-canvas-',
      'data-canvas-viewport',
      'data-canvas-pan',
      'data-agent-port',
      'data-mstar-edge-',
      'data-agent-edge-',
      'canvasEdges',
    ])
  })

  it('the panel carries no geometry/pan/edge code (layoutAgents / edgePath / panDrag / setPointerCapture)', () => {
    expectAbsent(collectFiles(PANEL_DIR), [
      'layoutAgents',
      'edgePath',
      'panDrag',
      'setPointerCapture',
    ])
  })
})

describe('panel anchor contract — the retired agents surface stays retired', () => {
  it('the agents page, its roster anchors, its locale family and its projection member are gone', () => {
    // The whole vocabulary dies with the surface: no `data-agent-*` anchor, no
    // agents page route, no agents tab id, no agents locale family, no
    // `projectAgents` projection member.
    expectAbsent(collectFiles(CLIENT_DIR), [
      'data-agent-',
      'data-mstar-page="agents"',
      "'tab.agents'",
      'AgentListPage',
      'projectAgents',
      'zone.agents.',
    ])
    expectFileAbsent(LIST_PAGE)
  })

  it('the roadmap page and its anchor family exist', () => {
    expectPresent(collectFiles(PANEL_DIR), [
      'data-mstar-page="roadmap"',
      'data-roadmap-state',
      'data-roadmap-milestone',
      'data-roadmap-not-applicable',
      'data-roadmap-absent',
      'data-roadmap-unavailable',
    ])
  })
})

describe('panel anchor contract — no JS layout measurement anywhere in the panel (plan sidebar §L2.6, AC6)', () => {
  it('src/client/panel/** contains no ResizeObserver / IntersectionObserver / getBoundingClientRect / offsetWidth / clientWidth', () => {
    expectAbsent(collectFiles(PANEL_DIR), [
      'ResizeObserver',
      'IntersectionObserver',
      'getBoundingClientRect',
      'offsetWidth',
      'clientWidth',
    ])
  })
})
