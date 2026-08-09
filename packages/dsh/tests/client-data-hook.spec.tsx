/**
 * Data-hook tests for the workflow-viz panel (Task 3, spec §5): the
 * `useMstarEngineStatus(useSession)` hook scans the active session's
 * conversation snapshot for the latest `mstar-engine-status` catalog row
 * (`kind === 'context'` + `form === 'catalog'` + `source.kind ===
 * 'mstar-engine-status'`, spec §2.4) and exposes the catalog message node
 * `time` (Unix ms) for the freshness marker.
 *
 * The `useSession` face is exercised through the runtime-stub snapshot store
 * (`createSnapshotStore`): a bound selector applies the hook's selection to
 * the store's current snapshot, and a `store.set` with a newer catalog row (a
 * snapshot bump — the refresh signal, spec §5) yields the updated hook result.
 * The real uSES subscription wiring is the framework's own and lands in the
 * Task 4 real-composition check; here we pin the selection + update + empty
 * state contract.
 */

import { describe, expect, it } from 'bun:test'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import {
  createSnapshotStore,
  type ConversationNode, type ConversationSnapshot, type SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { MstarEngineStatusSource } from '../src/types'
import { useMstarEngineStatus } from '../src/client/panel/use-mstar-engine-status'

const sessionId = 's-1' as SessionId

/** Engine-status sources with distinguishable versions (watermark asserts). */
const sourceA: MstarEngineStatusSource = {
  kind: 'mstar-engine-status',
  form: 'catalog',
  version: '2.0.4',
  harnessDir: '/proj/.mstar',
  enforcement: { hard: true, source: 'iteration compass' },
  state: null,
}
const sourceB: MstarEngineStatusSource = {
  ...sourceA,
  version: '2.0.5',
  harnessDir: '/proj2/.mstar',
}

/** A finalized user message — never matches the catalog discriminator. */
function userNode(): ConversationNode {
  return { kind: 'user', seq: 1, time: 1_719_999_000_000, content: [], source: null }
}

/** A catalog row of a DIFFERENT mstar kind — must be skipped (spec §2.4 discriminates by `source.kind`). */
function otherKindCatalogRow(): ConversationNode {
  return {
    kind: 'context',
    seq: 3,
    time: 1_720_000_000_000,
    content: [],
    source: { kind: 'mstar-iteration-gate', form: 'catalog' },
    form: 'catalog',
  }
}

/** One `mstar-engine-status` catalog row carrying the given source + message time. */
function engineRow(seq: number, time: number, source: MstarEngineStatusSource): ConversationNode {
  return { kind: 'context', seq, time, content: [], source, form: 'catalog' }
}

/** A minimal immutable snapshot (the shape `useSession` hands the selector). */
function snapshot(nodes: readonly ConversationNode[]): ConversationSnapshot {
  return {
    sessionId,
    nodes,
    running: false,
    openState: 'open',
    composerPhase: 'active',
    blank: false,
  }
}

/** Plain selector binding over the stub store — the dev-time twin of the uSES binding (see `web-react/src/bind.ts`). */
function bindUseSession<T>(store: { getSnapshot(): T }): SnapshotSelectorHook<T> {
  return function useSelector<S>(sel: (s: T) => S): S {
    return sel(store.getSnapshot())
  }
}

describe('useMstarEngineStatus — catalog row selection (spec §2.4, §5)', () => {
  it('returns the LATEST mstar-engine-status catalog row with its message time', () => {
    const older = engineRow(2, 1_720_000_000_000, sourceA)
    const newer = engineRow(4, 1_720_001_000_000, sourceB)
    const store = createSnapshotStore<ConversationSnapshot>(snapshot([
      userNode(),
      otherKindCatalogRow(), // catalog but not engine-status → skipped
      older,
      newer,
    ]))
    const view = useMstarEngineStatus(bindUseSession(store))
    expect(view.source).toBe(newer.source)
    expect(view.lastUpdated).toBe(1_720_001_000_000)
  })

  it('a new catalog row (snapshot bump = refresh signal) updates the hook result', () => {
    const first = engineRow(2, 1_720_000_000_000, sourceA)
    const store = createSnapshotStore<ConversationSnapshot>(snapshot([first]))
    const useSession = bindUseSession(store)

    const before = useMstarEngineStatus(useSession)
    expect(before.source).toBe(sourceA)
    expect(before.lastUpdated).toBe(1_720_000_000_000)

    // Server re-emission appends a newer row → snapshot bump → hook re-scans.
    store.set(snapshot([first, engineRow(5, 1_720_002_000_000, sourceB)]))
    const after = useMstarEngineStatus(useSession)
    expect(after.source).toBe(sourceB)
    expect(after.lastUpdated).toBe(1_720_002_000_000)
  })
})

describe('useMstarEngineStatus — empty states (spec §3, §5)', () => {
  it('no catalog row in the snapshot → null source + null lastUpdated (waiting state)', () => {
    const store = createSnapshotStore<ConversationSnapshot>(snapshot([userNode()]))
    expect(useMstarEngineStatus(bindUseSession(store))).toEqual({ source: null, lastUpdated: null })
  })

  it('catalog rows of other kinds (non mstar-engine-status) → empty state', () => {
    const store = createSnapshotStore<ConversationSnapshot>(snapshot([otherKindCatalogRow()]))
    expect(useMstarEngineStatus(bindUseSession(store))).toEqual({ source: null, lastUpdated: null })
  })

  it('absent session face (selector yields no snapshot) → explicit empty signal, never a crash', () => {
    const noSession = (() => undefined) as unknown as SnapshotSelectorHook<ConversationSnapshot>
    expect(useMstarEngineStatus(noSession)).toEqual({ source: null, lastUpdated: null })
  })

  it('a throwing session face → explicit empty signal, never a crash (hook never throws)', () => {
    const throwing = (() => { throw new Error('session exploded') }) as unknown as SnapshotSelectorHook<ConversationSnapshot>
    expect(useMstarEngineStatus(throwing)).toEqual({ source: null, lastUpdated: null })
  })
})
