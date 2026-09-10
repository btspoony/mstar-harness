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
const LIST_PAGE = new URL('../src/client/panel/pages/AgentListPage.tsx', import.meta.url).pathname

/** The first file containing the token (for the failure message), if any. */
function firstHolder(files: readonly string[], token: string): string | null {
  for (const file of files) {
    if (readFileSync(file, 'utf8').includes(token)) return file
  }
  return null
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
  it('src/client/** carries no canvas anchor, no card port anchor', () => {
    expectAbsent(collectFiles(CLIENT_DIR), [
      'data-canvas-',
      'data-agent-port',
    ])
  })

  it('AgentListPage.tsx carries no geometry/pan/edge code (layoutAgents / edgePath / panDrag / setPointerCapture)', () => {
    expectAbsent([LIST_PAGE], [
      'layoutAgents',
      'edgePath',
      'panDrag',
      'setPointerCapture',
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
