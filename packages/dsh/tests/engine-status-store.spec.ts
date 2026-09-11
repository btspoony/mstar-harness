/**
 * Store spec for the durable engine-status snapshot
 * (`src/engine-status-store.ts`).
 *
 * Covered: envelope schema (`sv` / `rv`), session keying (including ids that
 * name `Object.prototype` members), the prune boundary (per-session cap + 30-day
 * age + the global byte ceiling, all enforced on write), the unknown-`sv` and
 * torn-file paths on BOTH sides (the reader answers the explicit unavailable
 * state and the writer REFUSES rather than replacing a store it cannot parse),
 * lock contention (the short bounded timeout degrades instead of stalling the
 * per-turn path), and the atomic replace (writer-unique temp file + rename, no
 * left-over temp).
 *
 * Fixtures use the package's synthetic harness layout (`/proj/.mstar/…`), never
 * a real checkout path.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENGINE_STATUS_SNAPSHOT_ENTRY_VERSION,
  ENGINE_STATUS_SNAPSHOT_LOCK_TIMEOUT_MS,
  ENGINE_STATUS_SNAPSHOT_MAX_AGE_MS,
  ENGINE_STATUS_SNAPSHOT_MAX_BYTES,
  ENGINE_STATUS_SNAPSHOT_MAX_PER_SESSION,
  ENGINE_STATUS_SNAPSHOT_RELATIVE_PATH,
  ENGINE_STATUS_SNAPSHOT_VERSION,
  engineStatusSnapshotPath,
  readEngineStatusSnapshot,
  readWorkflowSessionBinding,
  updateWorkflowSessionBinding,
  writeEngineStatusSnapshot,
} from '../src/engine-status-store.ts'
import { WORKFLOW_LEDGER_LOCKDIR } from '../src/gates/agent-flow.ts'

const dirs: string[] = []

/** Fresh synthetic `{HARNESS_DIR}` under the OS temp dir. */
function freshHarnessDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mstar-engine-status-snapshot-'))
  dirs.push(dir)
  return dir
}

/** One stored envelope read back as raw JSON. */
function envelopeOf(harnessDir: string): { sv: number; entries: Record<string, unknown[]> } {
  return JSON.parse(readFileSync(engineStatusSnapshotPath(harnessDir), 'utf8'))
}

/** A plausible catalog payload object. */
function payload(marker: number): Record<string, unknown> {
  return { version: '3.7.3', harnessDir: '/proj/.mstar', marker }
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('engine-status snapshot store — write + schema', () => {
  it('writes the sv:1 envelope with a rv:1 entry keyed by session id under snapshots/', () => {
    const harness = freshHarnessDir()
    const result = writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_a',
      cwd: '/proj',
      turn: 3,
      payload: payload(1),
      now: new Date('2026-09-10T12:00:00.000Z'),
    })
    expect(result.kind).toBe('written')
    expect(engineStatusSnapshotPath(harness)).toBe(join(harness, ENGINE_STATUS_SNAPSHOT_RELATIVE_PATH))
    expect(engineStatusSnapshotPath(harness)).toBe(
      join(harness, 'snapshots', 'engine-status.json'),
    )
    const doc = envelopeOf(harness)
    expect(doc.sv).toBe(ENGINE_STATUS_SNAPSHOT_VERSION)
    expect(Object.keys(doc.entries)).toEqual(['ses_a'])
    expect(doc.entries.ses_a).toEqual([
      {
        rv: ENGINE_STATUS_SNAPSHOT_ENTRY_VERSION,
        cwd: '/proj',
        at: '2026-09-10T12:00:00.000Z',
        turn: 3,
        payload: payload(1),
      },
    ])
  })

  it('keeps sessions independent and appends per-session in emission order', () => {
    const harness = freshHarnessDir()
    const base = { cwd: '/proj', payload: payload(1) }
    writeEngineStatusSnapshot(harness, { sessionId: 'ses_a', turn: 1, ...base, now: new Date('2026-09-10T12:00:00.000Z') })
    writeEngineStatusSnapshot(harness, { sessionId: 'ses_b', turn: 7, ...base, now: new Date('2026-09-10T12:00:01.000Z') })
    writeEngineStatusSnapshot(harness, { sessionId: 'ses_a', turn: 2, ...base, now: new Date('2026-09-10T12:00:02.000Z') })
    const doc = envelopeOf(harness)
    expect(Object.keys(doc.entries).sort()).toEqual(['ses_a', 'ses_b'])
    expect((doc.entries.ses_a as Array<{ turn: number }>).map((e) => e.turn)).toEqual([1, 2])
    expect((doc.entries.ses_b as Array<{ turn: number }>).map((e) => e.turn)).toEqual([7])
  })

  it('never leaves a temp file behind after an atomic replace', () => {
    const harness = freshHarnessDir()
    writeEngineStatusSnapshot(harness, { sessionId: 'ses_a', cwd: '/proj', turn: 1, payload: payload(1) })
    const snapshots = join(harness, 'snapshots')
    expect(readdirSync(snapshots)).toEqual(['engine-status.json'])
    // The replace is a rename: no `.tmp` sibling, and the file holds the envelope.
    expect(envelopeOf(harness).sv).toBe(ENGINE_STATUS_SNAPSHOT_VERSION)
  })

  it('REFUSES to replace a store it cannot parse — every other session keeps its snapshots', () => {
    const harness = freshHarnessDir()
    mkdirSync(join(harness, 'snapshots'), { recursive: true })
    const torn = '{"sv":1,"entries":{"ses_old":[{"rv":1,'
    writeFileSync(engineStatusSnapshotPath(harness), torn)
    const result = writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_new',
      cwd: '/proj',
      turn: 5,
      payload: payload(5),
    })
    // Degraded WITH a reason, and the bytes on disk are untouched.
    expect(result).toEqual({ kind: 'degraded', reason: 'store-invalid-json' })
    expect(readFileSync(engineStatusSnapshotPath(harness), 'utf8')).toBe(torn)
    // No temp file was left behind by the refused write.
    expect(readdirSync(join(harness, 'snapshots')).sort()).toEqual(['engine-status.json'])
  })

  it('REFUSES to replace an envelope with an unknown sv instead of resetting it', () => {
    const harness = freshHarnessDir()
    mkdirSync(join(harness, 'snapshots'), { recursive: true })
    const newer = JSON.stringify({
      sv: 2,
      entries: { ses_old: [{ rv: 9, cwd: '/proj', at: '2026-09-10T12:00:00.000Z', turn: 1, payload: {} }] },
    })
    writeFileSync(engineStatusSnapshotPath(harness), newer)
    expect(writeEngineStatusSnapshot(harness, { sessionId: 'ses_new', cwd: '/proj', turn: 5, payload: payload(5) }))
      .toEqual({ kind: 'degraded', reason: 'store-envelope-schema' })
    expect(readFileSync(engineStatusSnapshotPath(harness), 'utf8')).toBe(newer)
  })

  it('REFUSES a store holding a record version this build does not know — it never deletes it', () => {
    // Upgrade/downgrade overlap: a newer plugin wrote `rv: 2` records (possibly
    // for other sessions) while keeping the envelope at `sv: 1`. The write is a
    // full-file replace, so filtering the unknown record out would ERASE it.
    const harness = freshHarnessDir()
    mkdirSync(join(harness, 'snapshots'), { recursive: true })
    const newer = JSON.stringify({
      sv: 1,
      entries: {
        ses_other: [{ rv: 2, cwd: '/other', at: '2026-09-10T12:00:00.000Z', turn: 9, payload: { v: 2 } }],
        ses_mine: [{ rv: 1, cwd: '/proj', at: '2026-09-10T11:00:00.000Z', turn: 1, payload: { v: 1 } }],
      },
    })
    writeFileSync(engineStatusSnapshotPath(harness), newer)
    expect(writeEngineStatusSnapshot(harness, { sessionId: 'ses_mine', cwd: '/proj', turn: 5, payload: payload(5) }))
      .toEqual({ kind: 'degraded', reason: 'store-entry-schema' })
    // The other session's newer record is still there, byte for byte.
    expect(readFileSync(engineStatusSnapshotPath(harness), 'utf8')).toBe(newer)
    expect(readdirSync(join(harness, 'snapshots')).sort()).toEqual(['engine-status.json'])
  })

  it('REFUSES a store whose bucket is not an array, instead of dropping the bucket', () => {
    const harness = freshHarnessDir()
    mkdirSync(join(harness, 'snapshots'), { recursive: true })
    const foreign = JSON.stringify({ sv: 1, entries: { ses_other: { rv: 1, cwd: '/other' } } })
    writeFileSync(engineStatusSnapshotPath(harness), foreign)
    expect(writeEngineStatusSnapshot(harness, { sessionId: 'ses_new', cwd: '/proj', turn: 5, payload: payload(5) }))
      .toEqual({ kind: 'degraded', reason: 'store-entry-schema' })
    expect(readFileSync(engineStatusSnapshotPath(harness), 'utf8')).toBe(foreign)
  })

  it('still starts a fresh envelope when the store is simply absent', () => {
    const harness = freshHarnessDir()
    // A directory where the file belongs is NOT "absent": it is unreadable, so
    // the write refuses rather than losing whatever a reader would have seen.
    mkdirSync(engineStatusSnapshotPath(harness), { recursive: true })
    expect(writeEngineStatusSnapshot(harness, { sessionId: 'ses_a', cwd: '/proj', turn: 1, payload: payload(1) }))
      .toEqual({ kind: 'degraded', reason: 'store-unreadable' })
    // …and the plain absent case writes normally.
    const clean = freshHarnessDir()
    expect(writeEngineStatusSnapshot(clean, { sessionId: 'ses_a', cwd: '/proj', turn: 1, payload: payload(1) }).kind)
      .toBe('written')
  })
})

describe('engine-status snapshot store — prune boundary', () => {
  it('keeps exactly the newest 50 entries per session', () => {
    const harness = freshHarnessDir()
    for (let i = 1; i <= ENGINE_STATUS_SNAPSHOT_MAX_PER_SESSION + 4; i += 1) {
      writeEngineStatusSnapshot(harness, {
        sessionId: 'ses_a',
        cwd: '/proj',
        turn: i,
        payload: payload(i),
        now: new Date(Date.parse('2026-09-10T12:00:00.000Z') + i * 1000),
      })
    }
    const doc = envelopeOf(harness)
    const bucket = doc.entries.ses_a as Array<{ turn: number }>
    expect(bucket).toHaveLength(ENGINE_STATUS_SNAPSHOT_MAX_PER_SESSION)
    expect(bucket[0]?.turn).toBe(5)
    expect(bucket[bucket.length - 1]?.turn).toBe(ENGINE_STATUS_SNAPSHOT_MAX_PER_SESSION + 4)
  })

  it('drops entries older than 30 days on the next write', () => {
    const harness = freshHarnessDir()
    const now = Date.parse('2026-09-10T12:00:00.000Z')
    writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_a',
      cwd: '/proj',
      turn: 1,
      payload: payload(1),
      now: new Date(now - ENGINE_STATUS_SNAPSHOT_MAX_AGE_MS - 1000),
    })
    writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_a',
      cwd: '/proj',
      turn: 2,
      payload: payload(2),
      now: new Date(now),
    })
    const bucket = envelopeOf(harness).entries.ses_a as Array<{ turn: number }>
    expect(bucket.map((e) => e.turn)).toEqual([2])
  })

  it('drops a session bucket once every entry has aged out', () => {
    const harness = freshHarnessDir()
    const now = Date.parse('2026-09-10T12:00:00.000Z')
    writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_stale',
      cwd: '/proj',
      turn: 1,
      payload: payload(1),
      now: new Date(now - ENGINE_STATUS_SNAPSHOT_MAX_AGE_MS - 1000),
    })
    writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_live',
      cwd: '/proj',
      turn: 1,
      payload: payload(1),
      now: new Date(now),
    })
    expect(Object.keys(envelopeOf(harness).entries)).toEqual(['ses_live'])
  })

  it('keeps the age boundary inclusive (exactly 30 days is retained)', () => {
    const harness = freshHarnessDir()
    const now = Date.parse('2026-09-10T12:00:00.000Z')
    writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_a',
      cwd: '/proj',
      turn: 1,
      payload: payload(1),
      now: new Date(now - ENGINE_STATUS_SNAPSHOT_MAX_AGE_MS),
    })
    writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_a',
      cwd: '/proj',
      turn: 2,
      payload: payload(2),
      now: new Date(now),
    })
    const bucket = envelopeOf(harness).entries.ses_a as Array<{ turn: number }>
    expect(bucket.map((e) => e.turn)).toEqual([1, 2])
  })
})

describe('engine-status snapshot store — read rule', () => {
  const write = (harness: string, sessionId = 'ses_a'): void => {
    writeEngineStatusSnapshot(harness, { sessionId, cwd: '/proj', turn: 4, payload: payload(4) })
  }

  it('returns the newest entry of the requested session', () => {
    const harness = freshHarnessDir()
    writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_a',
      cwd: '/proj',
      turn: 4,
      payload: payload(4),
      now: new Date('2026-09-10T12:00:00.000Z'),
    })
    writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_a',
      cwd: '/proj',
      turn: 9,
      payload: payload(9),
      now: new Date('2026-09-10T12:00:01.000Z'),
    })
    const read = readEngineStatusSnapshot(harness, 'ses_a')
    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') throw new Error('unreachable')
    expect(read.entry.turn).toBe(9)
    expect(read.entry.cwd).toBe('/proj')
    expect(read.entry.rv).toBe(ENGINE_STATUS_SNAPSHOT_ENTRY_VERSION)
    expect(read.entry.payload).toEqual(payload(9))
  })

  it('answers unavailable for an unresolved {HARNESS_DIR}', () => {
    expect(readEngineStatusSnapshot(null, 'ses_a')).toEqual({ kind: 'unavailable', reason: 'no-harness-dir' })
    expect(readEngineStatusSnapshot('', 'ses_a')).toEqual({ kind: 'unavailable', reason: 'no-harness-dir' })
  })

  it('answers unavailable when the file is absent', () => {
    expect(readEngineStatusSnapshot(freshHarnessDir(), 'ses_a')).toEqual({
      kind: 'unavailable',
      reason: 'absent',
    })
  })

  it('answers unavailable for an unknown session key — never another session data', () => {
    const harness = freshHarnessDir()
    write(harness, 'ses_a')
    expect(readEngineStatusSnapshot(harness, 'ses_b')).toEqual({
      kind: 'unavailable',
      reason: 'no-session-entry',
    })
  })

  it('answers unavailable for an unknown envelope sv', () => {
    const harness = freshHarnessDir()
    mkdirSync(join(harness, 'snapshots'), { recursive: true })
    writeFileSync(
      engineStatusSnapshotPath(harness),
      JSON.stringify({ sv: 2, entries: { ses_a: [{ rv: 1, cwd: '/proj', at: '2026-09-10T12:00:00.000Z', turn: 1, payload: {} }] } }),
    )
    expect(readEngineStatusSnapshot(harness, 'ses_a')).toEqual({
      kind: 'unavailable',
      reason: 'envelope-schema',
    })
  })

  it('answers unavailable for a torn file (never a best-effort parse)', () => {
    const harness = freshHarnessDir()
    mkdirSync(join(harness, 'snapshots'), { recursive: true })
    writeFileSync(engineStatusSnapshotPath(harness), '{"sv":1,"entries":{"ses_a":[{"rv":1,')
    expect(readEngineStatusSnapshot(harness, 'ses_a')).toEqual({
      kind: 'unavailable',
      reason: 'invalid-json',
    })
  })

  it('answers unavailable for a non-object envelope and for a non-object entries map', () => {
    const harness = freshHarnessDir()
    mkdirSync(join(harness, 'snapshots'), { recursive: true })
    writeFileSync(engineStatusSnapshotPath(harness), '"nope"')
    expect(readEngineStatusSnapshot(harness, 'ses_a').kind).toBe('unavailable')
    writeFileSync(engineStatusSnapshotPath(harness), JSON.stringify({ sv: 1, entries: [] }))
    expect(readEngineStatusSnapshot(harness, 'ses_a')).toEqual({
      kind: 'unavailable',
      reason: 'envelope-schema',
    })
  })

  it('answers unavailable for an entry whose rv is unknown', () => {
    const harness = freshHarnessDir()
    mkdirSync(join(harness, 'snapshots'), { recursive: true })
    writeFileSync(
      engineStatusSnapshotPath(harness),
      JSON.stringify({ sv: 1, entries: { ses_a: [{ rv: 2, cwd: '/proj', at: '2026-09-10T12:00:00.000Z', turn: 1, payload: {} }] } }),
    )
    expect(readEngineStatusSnapshot(harness, 'ses_a')).toEqual({
      kind: 'unavailable',
      reason: 'entry-schema',
    })
  })

  it('answers unavailable for an empty session bucket', () => {
    const harness = freshHarnessDir()
    mkdirSync(join(harness, 'snapshots'), { recursive: true })
    writeFileSync(engineStatusSnapshotPath(harness), JSON.stringify({ sv: 1, entries: { ses_a: [] } }))
    expect(readEngineStatusSnapshot(harness, 'ses_a')).toEqual({
      kind: 'unavailable',
      reason: 'no-session-entry',
    })
  })

  it('reports a non-ENOENT read fault as unreadable (not as absent)', () => {
    const harness = freshHarnessDir()
    // A directory where the file belongs: readFileSync fails with EISDIR.
    mkdirSync(engineStatusSnapshotPath(harness), { recursive: true })
    expect(readEngineStatusSnapshot(harness, 'ses_a')).toEqual({
      kind: 'unavailable',
      reason: 'unreadable',
    })
  })
})

describe('engine-status snapshot store — write guards', () => {
  it('degrades without touching the disk when the identity is unusable', () => {
    const harness = freshHarnessDir()
    const bad = [
      { sessionId: '', reason: 'no-session-id' },
      { sessionId: 'ses_a', cwd: '', reason: 'no-session-cwd' },
    ] as const
    for (const item of bad) {
      const result = writeEngineStatusSnapshot(harness, {
        sessionId: item.sessionId,
        cwd: 'cwd' in item ? item.cwd : '/proj',
        turn: 1,
        payload: payload(1),
      })
      expect(result).toEqual({ kind: 'degraded', reason: item.reason })
    }
    expect(writeEngineStatusSnapshot(null, { sessionId: 'ses_a', cwd: '/proj', turn: 1, payload: payload(1) })).toEqual({
      kind: 'degraded',
      reason: 'no-harness-dir',
    })
    expect(existsSync(engineStatusSnapshotPath(harness))).toBe(false)
  })

  it('degrades on a non-finite turn and on a non-object payload', () => {
    const harness = freshHarnessDir()
    expect(
      writeEngineStatusSnapshot(harness, { sessionId: 'ses_a', cwd: '/proj', turn: Number.NaN, payload: payload(1) }),
    ).toEqual({ kind: 'degraded', reason: 'invalid-turn' })
    expect(
      writeEngineStatusSnapshot(harness, {
        sessionId: 'ses_a',
        cwd: '/proj',
        turn: 1,
        payload: [] as unknown as Record<string, unknown>,
      }),
    ).toEqual({ kind: 'degraded', reason: 'payload-not-object' })
  })

  it('degrades within the bounded lock budget when another writer holds the lockdir', () => {
    const harness = freshHarnessDir()
    const snapshotDir = join(harness, 'snapshots')
    mkdirSync(join(snapshotDir, WORKFLOW_LEDGER_LOCKDIR), { recursive: true })
    const started = Date.now()
    const result = writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_a',
      cwd: '/proj',
      turn: 1,
      payload: payload(1),
    })
    const elapsed = Date.now() - started
    // Degraded with the lock's own reason, and the advisory write NEVER waits
    // for the ledger's 30 s default on the per-turn path.
    expect(result.kind).toBe('degraded')
    expect((result as { reason: string }).reason).toContain(WORKFLOW_LEDGER_LOCKDIR)
    expect(elapsed).toBeLessThan(ENGINE_STATUS_SNAPSHOT_LOCK_TIMEOUT_MS * 10)
    // Nothing was written, and the contended write left no temp file behind.
    expect(existsSync(engineStatusSnapshotPath(harness))).toBe(false)
    expect(readdirSync(snapshotDir).sort()).toEqual([WORKFLOW_LEDGER_LOCKDIR])
    // The holder's lockdir is never removed for it.
    expect(existsSync(join(snapshotDir, WORKFLOW_LEDGER_LOCKDIR))).toBe(true)
  })
})

describe('engine-status snapshot store — session ids that name Object.prototype members', () => {
  // The session id is caller-chosen on the host's `session.create` (a branded
  // string with no shape validation), so an id colliding with an inherited
  // member is reachable, not theoretical. On a plain-object map each of these
  // ids either threw a raw `TypeError` or was reported `written` while
  // persisting nothing.
  const HOSTILE_IDS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'] as const

  for (const sessionId of HOSTILE_IDS) {
    it(`keys ${sessionId} like any other session and serves it back`, () => {
      const harness = freshHarnessDir()
      expect(writeEngineStatusSnapshot(harness, { sessionId, cwd: '/proj', turn: 3, payload: payload(3) })).toMatchObject({
        kind: 'written',
        entries: 1,
      })
      const doc = envelopeOf(harness)
      expect(Object.keys(doc.entries)).toEqual([sessionId])
      expect(doc.entries[sessionId]).toHaveLength(1)
      const read = readEngineStatusSnapshot(harness, sessionId)
      expect(read.kind).toBe('ok')
      if (read.kind !== 'ok') throw new Error('unreachable')
      expect(read.entry.turn).toBe(3)
      // …and it is an ORDINARY key: no inherited member is ever served.
      expect(readEngineStatusSnapshot(harness, 'ses_other').kind).toBe('unavailable')
    })
  }

  it('never resolves an inherited member for a session that has no bucket', () => {
    const harness = freshHarnessDir()
    writeEngineStatusSnapshot(harness, { sessionId: 'ses_a', cwd: '/proj', turn: 1, payload: payload(1) })
    for (const probe of HOSTILE_IDS) {
      expect(readEngineStatusSnapshot(harness, probe)).toEqual({
        kind: 'unavailable',
        reason: 'no-session-entry',
      })
    }
  })

  it('keeps the hostile-key bucket and the ordinary buckets independent', () => {
    const harness = freshHarnessDir()
    writeEngineStatusSnapshot(harness, { sessionId: '__proto__', cwd: '/proj', turn: 1, payload: payload(1) })
    writeEngineStatusSnapshot(harness, { sessionId: 'ses_b', cwd: '/proj', turn: 2, payload: payload(2) })
    expect(Object.keys(envelopeOf(harness).entries).sort()).toEqual(['__proto__', 'ses_b'])
  })
})

describe('engine-status snapshot store — global bound', () => {
  /** A payload sized so a handful of entries crosses the test's byte ceiling. */
  function bulkPayload(bytes: number): Record<string, unknown> {
    return { blob: 'x'.repeat(bytes) }
  }

  // A small ceiling keeps the case fast; the mechanism is the same one the
  // production constant drives (the constant itself is asserted below).
  const CEILING = 8 * 1024
  const ENTRY_BYTES = 1024
  const SESSIONS = 24

  it('sheds the oldest session buckets once the store crosses its byte ceiling', () => {
    const harness = freshHarnessDir()
    const base = Date.parse('2026-09-10T12:00:00.000Z')
    let lastEvicted = 0
    for (let i = 0; i < SESSIONS; i += 1) {
      const result = writeEngineStatusSnapshot(harness, {
        sessionId: `ses_${String(i).padStart(4, '0')}`,
        cwd: '/proj',
        turn: 1,
        payload: bulkPayload(ENTRY_BYTES),
        now: new Date(base + i * 1000),
        maxBytes: CEILING,
      })
      expect(result.kind).toBe('written')
      lastEvicted = (result as { evicted: number }).evicted
    }
    const doc = envelopeOf(harness)
    // Under the ceiling, the newest session is always retained, and the oldest
    // ones were shed rather than kept (which is what a global bound means).
    expect(Buffer.byteLength(JSON.stringify(doc), 'utf8')).toBeLessThanOrEqual(CEILING)
    expect(lastEvicted).toBeGreaterThan(0)
    expect(Object.keys(doc.entries)).toContain(`ses_${String(SESSIONS - 1).padStart(4, '0')}`)
    expect(Object.keys(doc.entries)).not.toContain('ses_0000')
    // Every surviving session still reads back (the shed is bucket-scoped).
    for (const key of Object.keys(doc.entries)) {
      expect(readEngineStatusSnapshot(harness, key).kind).toBe('ok')
    }
  })

  it('asks for the oversize warning when a single session alone exceeds the ceiling', () => {
    const harness = freshHarnessDir()
    const result = writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_a',
      cwd: '/proj',
      turn: 1,
      payload: bulkPayload(CEILING * 2),
      maxBytes: CEILING,
    })
    expect(result).toMatchObject({ kind: 'written', evicted: 0 })
    expect((result as { warn?: string }).warn).toContain('byte ceiling')
  })

  it('reports the oversize condition ONCE per store, never once per turn', () => {
    const harness = freshHarnessDir()
    const base = Date.parse('2026-09-10T12:00:00.000Z')
    const warnings: string[] = []
    // A session far larger than the ceiling on its own: the store is oversize
    // from this first write on, and every later write must stay silent.
    const seed = writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_huge',
      cwd: '/proj',
      turn: 0,
      payload: bulkPayload(CEILING * 4),
      now: new Date(base),
      maxBytes: CEILING,
    })
    expect(seed).toMatchObject({ kind: 'written', evicted: 0 })
    if (seed.kind === 'written' && seed.warn !== undefined) warnings.push(seed.warn)

    for (let i = 0; i < 12; i += 1) {
      const result = writeEngineStatusSnapshot(harness, {
        sessionId: `ses_live_${String(i).padStart(2, '0')}`,
        cwd: '/proj',
        turn: i + 1,
        payload: bulkPayload(256),
        now: new Date(base + (i + 1) * 1000),
        maxBytes: CEILING,
      })
      expect(result.kind).toBe('written')
      if (result.kind === 'written' && result.warn !== undefined) warnings.push(result.warn)
    }
    // One oversize store, thirteen writes, exactly ONE warning — the per-store
    // latch, not a warning per turn (a per-turn warning would be 13 here). It
    // names the recovery step; the seed could not shed anything (it was the
    // only session), and no later write repeats the warning.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`${CEILING}-byte ceiling`)
    expect(warnings[0]).toContain('recovery: delete the file')
    expect(warnings[0]).toContain('shed 0 oldest session bucket(s)')
    // The first subsequent write sheds the oversize resident bucket (oldest
    // first) without complaining again, so the store then holds only the fresh
    // per-session buckets.
    expect(Object.keys(envelopeOf(harness).entries)).toHaveLength(12)
    expect(Object.keys(envelopeOf(harness).entries)).not.toContain('ses_huge')
  })

  it('keeps a store well under the production ceiling without evicting anything', () => {
    const harness = freshHarnessDir()
    const first = writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_a',
      cwd: '/proj',
      turn: 1,
      payload: payload(1),
    })
    expect(first).toMatchObject({ kind: 'written', evicted: 0 })
    expect((first as { warn?: string }).warn).toBeUndefined()
    expect(Object.keys(envelopeOf(harness).entries)).toEqual(['ses_a'])
    // The production ceiling is a real global bound (the per-session numbers
    // alone cannot bound a file every session in the workspace shares).
    expect(ENGINE_STATUS_SNAPSHOT_MAX_BYTES).toBeGreaterThan(ENGINE_STATUS_SNAPSHOT_MAX_PER_SESSION)
  })
})

/* -------------------------------------------------------------------------- */
/* D4 — session-scoped workflow bindings (picker control state)                */
/* -------------------------------------------------------------------------- */

describe('engine-status snapshot store — workflow session bindings (D4 control state)', () => {
  /** A payload sized so a handful of entries crosses a test's byte ceiling. */
  function bulkPayload(bytes: number): Record<string, unknown> {
    return { blob: 'x'.repeat(bytes) }
  }

  it('reads an old sv:1 envelope without bindings as ok-without-binding, then round-trips one', () => {
    const harness = freshHarnessDir()
    // The pre-D4 envelope (sv:1, entries only) — absence of the control map is
    // "no pick / floor 0", never an error.
    writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_a',
      cwd: '/proj',
      turn: 1,
      payload: payload(1),
      now: new Date('2026-09-10T12:00:00.000Z'),
    })
    expect(readWorkflowSessionBinding(harness, 'ses_a', '/proj')).toEqual({ kind: 'ok' })
    // A store that does not exist yet is the same answer.
    expect(readWorkflowSessionBinding(freshHarnessDir(), 'ses_a', '/proj')).toEqual({ kind: 'ok' })

    expect(updateWorkflowSessionBinding(harness, 'ses_a', '/proj', {
      selectedWorkflowId: 'wf-b',
      excludedBeforeSeq: 4,
    })).toEqual({ kind: 'written' })
    expect(readWorkflowSessionBinding(harness, 'ses_a', '/proj')).toEqual({
      kind: 'ok',
      binding: { cwd: '/proj', selectedWorkflowId: 'wf-b', excludedBeforeSeq: 4 },
    })
    // No version bump, and the unknown-session query stays a plain "no binding".
    expect(envelopeOf(harness).sv).toBe(ENGINE_STATUS_SNAPSHOT_VERSION)
    expect(readWorkflowSessionBinding(harness, 'ses_other', '/proj')).toEqual({ kind: 'ok' })
  })

  it('preserves every stored emission field and value when the picker updates the binding', () => {
    const harness = freshHarnessDir()
    writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_a',
      cwd: '/proj',
      turn: 3,
      payload: payload(3),
      now: new Date('2026-09-10T12:00:00.000Z'),
    })
    writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_b',
      cwd: '/other',
      turn: 9,
      payload: payload(9),
      now: new Date('2026-09-10T12:00:01.000Z'),
    })
    const before = envelopeOf(harness).entries

    expect(updateWorkflowSessionBinding(harness, 'ses_a', '/proj', {
      selectedWorkflowId: 'wf-a',
      excludedBeforeSeq: 2,
    })).toEqual({ kind: 'written' })

    expect(envelopeOf(harness).entries).toEqual(before)
    expect(readEngineStatusSnapshot(harness, 'ses_a')).toEqual({
      kind: 'ok',
      entry: {
        rv: 1,
        cwd: '/proj',
        at: '2026-09-10T12:00:00.000Z',
        turn: 3,
        payload: payload(3),
      },
    })
  })

  it('a binding survives an intervening emission write and a store reload', () => {
    const harness = freshHarnessDir()
    expect(updateWorkflowSessionBinding(harness, 'ses_a', '/proj', {
      selectedWorkflowId: 'wf-b',
      excludedBeforeSeq: 7,
    })).toEqual({ kind: 'written' })
    // The emission is a read-modify-write of the SAME envelope: the control
    // record must not be dropped by the entry-only writer.
    expect(writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_a',
      cwd: '/proj',
      turn: 5,
      payload: payload(5),
      now: new Date('2026-09-10T12:00:02.000Z'),
    }).kind).toBe('written')
    expect(readWorkflowSessionBinding(harness, 'ses_a', '/proj')).toEqual({
      kind: 'ok',
      binding: { cwd: '/proj', selectedWorkflowId: 'wf-b', excludedBeforeSeq: 7 },
    })
    expect(readEngineStatusSnapshot(harness, 'ses_a').kind).toBe('ok')
  })

  it('keeps two same-cwd sessions independent (choices and floors)', () => {
    const harness = freshHarnessDir()
    expect(updateWorkflowSessionBinding(harness, 'ses_a', '/proj', {
      selectedWorkflowId: 'wf-a',
      excludedBeforeSeq: 3,
    })).toEqual({ kind: 'written' })
    expect(updateWorkflowSessionBinding(harness, 'ses_b', '/proj', {
      selectedWorkflowId: 'wf-b',
      excludedBeforeSeq: 9,
    })).toEqual({ kind: 'written' })
    expect(readWorkflowSessionBinding(harness, 'ses_a', '/proj')).toEqual({
      kind: 'ok',
      binding: { cwd: '/proj', selectedWorkflowId: 'wf-a', excludedBeforeSeq: 3 },
    })
    expect(readWorkflowSessionBinding(harness, 'ses_b', '/proj')).toEqual({
      kind: 'ok',
      binding: { cwd: '/proj', selectedWorkflowId: 'wf-b', excludedBeforeSeq: 9 },
    })
  })

  it('merges the exclusion floor by max and preserves an omitted preference', () => {
    const harness = freshHarnessDir()
    expect(updateWorkflowSessionBinding(harness, 'ses_a', '/proj', {
      selectedWorkflowId: 'wf-a',
      excludedBeforeSeq: 5,
    })).toEqual({ kind: 'written' })
    // A lower floor never walks back; the omitted preference is preserved.
    expect(updateWorkflowSessionBinding(harness, 'ses_a', '/proj', { excludedBeforeSeq: 2 }))
      .toEqual({ kind: 'written' })
    expect(readWorkflowSessionBinding(harness, 'ses_a', '/proj')).toEqual({
      kind: 'ok',
      binding: { cwd: '/proj', selectedWorkflowId: 'wf-a', excludedBeforeSeq: 5 },
    })
    expect(updateWorkflowSessionBinding(harness, 'ses_a', '/proj', { excludedBeforeSeq: 11 }))
      .toEqual({ kind: 'written' })
    expect(readWorkflowSessionBinding(harness, 'ses_a', '/proj')).toEqual({
      kind: 'ok',
      binding: { cwd: '/proj', selectedWorkflowId: 'wf-a', excludedBeforeSeq: 11 },
    })
    // A real re-pick replaces the stored preference.
    expect(updateWorkflowSessionBinding(harness, 'ses_a', '/proj', {
      selectedWorkflowId: 'wf-b',
      excludedBeforeSeq: 11,
    })).toEqual({ kind: 'written' })
    expect(readWorkflowSessionBinding(harness, 'ses_a', '/proj')).toEqual({
      kind: 'ok',
      binding: { cwd: '/proj', selectedWorkflowId: 'wf-b', excludedBeforeSeq: 11 },
    })
  })

  it('refuses a record whose stored cwd is not this session cwd', () => {
    const harness = freshHarnessDir()
    expect(updateWorkflowSessionBinding(harness, 'ses_a', '/proj', { excludedBeforeSeq: 0 }))
      .toEqual({ kind: 'written' })
    expect(updateWorkflowSessionBinding(harness, 'ses_a', '/elsewhere', { excludedBeforeSeq: 1 }))
      .toEqual({ kind: 'degraded', reason: 'cwd-mismatch' })
    expect(readWorkflowSessionBinding(harness, 'ses_a', '/elsewhere'))
      .toEqual({ kind: 'unavailable', reason: 'cwd-mismatch' })
    // The stored record is untouched by the refused write.
    expect(readWorkflowSessionBinding(harness, 'ses_a', '/proj')).toEqual({
      kind: 'ok',
      binding: { cwd: '/proj', excludedBeforeSeq: 0 },
    })
  })

  it('refuses a malformed bindings map or record instead of resetting the store', () => {
    const cases = [
      JSON.stringify({ sv: 1, entries: {}, bindings: [] }),
      JSON.stringify({ sv: 1, entries: {}, bindings: { ses_a: { cwd: '/proj', excludedBeforeSeq: -1 } } }),
      JSON.stringify({ sv: 1, entries: {}, bindings: { ses_a: { cwd: '', excludedBeforeSeq: 0 } } }),
      JSON.stringify({ sv: 1, entries: {}, bindings: { ses_a: { cwd: '/proj', selectedWorkflowId: 7, excludedBeforeSeq: 0 } } }),
      JSON.stringify({ sv: 1, entries: {}, bindings: { ses_a: 'nope' } }),
    ]
    for (const doc of cases) {
      const harness = freshHarnessDir()
      mkdirSync(join(harness, 'snapshots'), { recursive: true })
      writeFileSync(engineStatusSnapshotPath(harness), doc)
      expect(updateWorkflowSessionBinding(harness, 'ses_b', '/proj', { excludedBeforeSeq: 0 }))
        .toEqual({ kind: 'degraded', reason: 'store-bindings-schema' })
      // A malformed map/record is unavailable for its own key (a different
      // session's read is simply "no binding" — the corruption is not theirs).
      expect(readWorkflowSessionBinding(harness, 'ses_a', '/proj'))
        .toEqual({ kind: 'unavailable', reason: 'store-bindings-schema' })
      // The emission writer refuses the same store (one unknown content rule).
      expect(writeEngineStatusSnapshot(harness, { sessionId: 'ses_b', cwd: '/proj', turn: 1, payload: payload(1) }))
        .toEqual({ kind: 'degraded', reason: 'store-bindings-schema' })
      expect(readFileSync(engineStatusSnapshotPath(harness), 'utf8')).toBe(doc)
    }
  })

  it('answers unavailable for a corrupt store — never a silent empty record', () => {
    const harness = freshHarnessDir()
    mkdirSync(join(harness, 'snapshots'), { recursive: true })
    writeFileSync(engineStatusSnapshotPath(harness), '{"sv":1,"entries":')
    expect(readWorkflowSessionBinding(harness, 'ses_a', '/proj'))
      .toEqual({ kind: 'unavailable', reason: 'store-invalid-json' })
    writeFileSync(engineStatusSnapshotPath(harness), JSON.stringify({ sv: 2, entries: {} }))
    expect(readWorkflowSessionBinding(harness, 'ses_a', '/proj'))
      .toEqual({ kind: 'unavailable', reason: 'store-envelope-schema' })
  })

  it('keys hostile session ids in the binding map like any other session', () => {
    for (const sessionId of ['__proto__', 'constructor', 'toString']) {
      const harness = freshHarnessDir()
      expect(updateWorkflowSessionBinding(harness, sessionId, '/proj', {
        selectedWorkflowId: 'wf-a',
        excludedBeforeSeq: 1,
      })).toEqual({ kind: 'written' })
      expect(readWorkflowSessionBinding(harness, sessionId, '/proj')).toEqual({
        kind: 'ok',
        binding: { cwd: '/proj', selectedWorkflowId: 'wf-a', excludedBeforeSeq: 1 },
      })
      // An ordinary lookup never resolves an inherited member.
      expect(readWorkflowSessionBinding(harness, 'ses_other', '/proj')).toEqual({ kind: 'ok' })
    }
  })

  it('degrades the binding write on unusable identity without touching the disk', () => {
    const harness = freshHarnessDir()
    expect(updateWorkflowSessionBinding('', 'ses_a', '/proj', { excludedBeforeSeq: 0 }))
      .toEqual({ kind: 'degraded', reason: 'no-harness-dir' })
    expect(updateWorkflowSessionBinding(harness, '', '/proj', { excludedBeforeSeq: 0 }))
      .toEqual({ kind: 'degraded', reason: 'no-session-id' })
    expect(updateWorkflowSessionBinding(harness, 'ses_a', '', { excludedBeforeSeq: 0 }))
      .toEqual({ kind: 'degraded', reason: 'no-session-cwd' })
    expect(updateWorkflowSessionBinding(harness, 'ses_a', '/proj', { excludedBeforeSeq: -1 }))
      .toEqual({ kind: 'degraded', reason: 'invalid-excluded-before-seq' })
    expect(existsSync(engineStatusSnapshotPath(harness))).toBe(false)
    expect(readWorkflowSessionBinding(harness, 'ses_a', '/proj')).toEqual({ kind: 'ok' })
  })

  it('degrades within the bounded lock budget when another writer holds the lockdir', () => {
    const harness = freshHarnessDir()
    const snapshotDir = join(harness, 'snapshots')
    mkdirSync(join(snapshotDir, WORKFLOW_LEDGER_LOCKDIR), { recursive: true })
    const result = updateWorkflowSessionBinding(harness, 'ses_a', '/proj', { excludedBeforeSeq: 0 })
    expect(result.kind).toBe('degraded')
    // Nothing was written and no temp file was left behind.
    expect(existsSync(engineStatusSnapshotPath(harness))).toBe(false)
    expect(readdirSync(snapshotDir).sort()).toEqual([WORKFLOW_LEDGER_LOCKDIR])
  })

  it('counts bindings in the emission byte accounting and never sheds them', () => {
    const harness = freshHarnessDir()
    const CEILING = 4 * 1024
    const pick = 'wf-' + 'p'.repeat(1200)
    expect(updateWorkflowSessionBinding(harness, 'ses_pick', '/proj', {
      selectedWorkflowId: pick,
      excludedBeforeSeq: 1,
    })).toEqual({ kind: 'written' })
    // The entries alone fit; entries + the control record do not, and the write
    // may not drop the control record to get under the ceiling.
    const result = writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_live',
      cwd: '/proj',
      turn: 1,
      payload: bulkPayload(CEILING - 512),
      maxBytes: CEILING,
    })
    expect(result.kind).toBe('written')
    expect((result as { warn?: string }).warn).toContain('byte ceiling')
    expect(readWorkflowSessionBinding(harness, 'ses_pick', '/proj')).toEqual({
      kind: 'ok',
      binding: { cwd: '/proj', selectedWorkflowId: pick, excludedBeforeSeq: 1 },
    })
  })

  it('refuses a binding write that cannot fit instead of dropping another session', () => {
    const harness = freshHarnessDir()
    const CEILING = 4 * 1024
    // One oversized resident emission — already above the ceiling on its own.
    writeEngineStatusSnapshot(harness, {
      sessionId: 'ses_a',
      cwd: '/proj',
      turn: 1,
      payload: bulkPayload(CEILING * 2),
      maxBytes: CEILING,
    })
    const before = readFileSync(engineStatusSnapshotPath(harness), 'utf8')
    expect(updateWorkflowSessionBinding(harness, 'ses_b', '/proj', {
      selectedWorkflowId: 'wf-b',
      excludedBeforeSeq: 0,
      maxBytes: CEILING,
    })).toEqual({ kind: 'degraded', reason: 'store-over-byte-ceiling' })
    expect(readFileSync(engineStatusSnapshotPath(harness), 'utf8')).toBe(before)
    // Under the production ceiling the same write succeeds and the resident
    // session's emission survives it.
    expect(updateWorkflowSessionBinding(harness, 'ses_b', '/proj', {
      selectedWorkflowId: 'wf-b',
      excludedBeforeSeq: 0,
    })).toEqual({ kind: 'written' })
    expect(readEngineStatusSnapshot(harness, 'ses_a').kind).toBe('ok')
    expect(readWorkflowSessionBinding(harness, 'ses_b', '/proj')).toEqual({
      kind: 'ok',
      binding: { cwd: '/proj', selectedWorkflowId: 'wf-b', excludedBeforeSeq: 0 },
    })
  })
})
