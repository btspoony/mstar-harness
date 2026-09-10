/**
 * Smoke spec for the dsh client-seam faces the panel consumes (T1):
 * anchor reading — the latest `kind==='context' && form==='catalog'` node
 * whose FIRST-PARTY `plugin` source carries this plugin's identity — the
 * panel's own exported discriminator, over `ChatSnapshot.legacy.nodes`,
 * driven by the `createSnapshotStore` test double. The source is the locked
 * three-member arm (never a payload), and the payload itself travels over
 * the host's shared `/api` gateway (`use-mstar-engine-status` /
 * `engine-status-client`).
 *
 * (The former conversation.view registry describe is retired with the
 * panel's right-Sidebar migration: the view ring is no longer part of the
 * panel's surface, and the seat contract lives in client-seat.spec.ts.)
 */

import { describe, expect, it } from 'bun:test'
import type { ContextMessageNode, ConversationNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
// The plugin's OWN `LocaleNamespaceMap` augmentation (src/client/panel/locale.ts)
// is the single declaration of the `'mstar-panel'` namespace.
import { latestEngineStatusRow } from '../src/client/panel/use-mstar-engine-status.ts'

describe('dsh client-seam — catalog reading (spec §5)', () => {
  /**
   * The persisted ANCHOR row: the first-party `plugin` arm with exactly three
   * members — the payload is NOT on the source (it is fetched over the `/api`
   * gateway), and a fourth key here would be refused by every released
   * session-format edge.
   */
  const anchorSource = { kind: 'plugin', plugin: 'mstar-engine-status', form: 'catalog' } as const
  const engineRow = {
    kind: 'context',
    seq: 2,
    time: 1_720_000_000_000,
    content: [],
    source: anchorSource,
    form: 'catalog',
  } as unknown as ContextMessageNode

  /** The panel's OWN discriminator (spec §2.4) — imported, never re-declared. */
  const latestEngineStatus = latestEngineStatusRow

  it('the anchor source is exactly the three first-party members — never a payload', () => {
    expect(Object.keys(anchorSource).sort()).toEqual(['form', 'kind', 'plugin'])
    for (const payloadMember of ['version', 'harnessDir', 'enforcement', 'iteration', 'state']) {
      expect(anchorSource).not.toHaveProperty(payloadMember)
    }
  })

  it('reads the latest mstar-engine-status catalog row from the snapshot nodes', () => {
    const store = createSnapshotStore<ChatSnapshot>({
      legacy: {
        nodes: [
          { kind: 'user', seq: 1, time: 1_719_999_000_000, content: [], source: null },
          engineRow,
        ],
        turnTimings: new Map(),
        turnEnds: new Map(),
        partial: null,
        runningCalls: [],
      },
    } as unknown as ChatSnapshot)
    // useChat-shaped selector over the test double (the framework hook is a
    // uSES selector over the same bare source).
    const nodes = store.getSnapshot().legacy.nodes
    expect(latestEngineStatus(nodes)).toBe(engineRow)
  })

  it('returns null while no catalog row exists (empty state) and on a later re-emission returns the newest', () => {
    const store = createSnapshotStore<ChatSnapshot>({
      legacy: {
        nodes: [{ kind: 'user', seq: 1, time: 1_719_999_000_000, content: [], source: null }],
        turnTimings: new Map(),
        turnEnds: new Map(),
        partial: null,
        runningCalls: [],
      },
    } as unknown as ChatSnapshot)
    expect(latestEngineStatus(store.getSnapshot().legacy.nodes)).toBeNull()

    const newer: ContextMessageNode = {
      ...engineRow,
      seq: 4,
      time: 1_720_001_000_000,
      source: { ...anchorSource },
    }
    store.set({
      legacy: {
        nodes: [
          { kind: 'user', seq: 1, time: 1_719_999_000_000, content: [], source: null },
          engineRow,
          newer,
        ],
        turnTimings: new Map(),
        turnEnds: new Map(),
        partial: null,
        runningCalls: [],
      },
    } as unknown as ChatSnapshot)
    expect(latestEngineStatus(store.getSnapshot().legacy.nodes)).toBe(newer)
  })
})
