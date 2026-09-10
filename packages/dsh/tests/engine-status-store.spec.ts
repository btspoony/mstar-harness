/**
 * Store spec for the durable engine-status snapshot
 * (`src/engine-status-store.ts`).
 *
 * Covered: envelope schema (`sv` / `rv`), session keying (including ids that
 * name `Object.prototype` members), the prune boundary (per-session cap + 30-day
 * age, both enforced on write), the unknown-`sv` and torn-file paths on BOTH
 * sides (the reader answers the explicit unavailable state and the writer
 * REFUSES rather than replacing a store it cannot parse), lock contention (the
 * short bounded timeout degrades instead of stalling the per-turn path), and
 * the atomic replace (writer-unique temp file + rename, no left-over temp).
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
  ENGINE_STATUS_SNAPSHOT_MAX_PER_SESSION,
  ENGINE_STATUS_SNAPSHOT_RELATIVE_PATH,
  ENGINE_STATUS_SNAPSHOT_VERSION,
  engineStatusSnapshotPath,
  readEngineStatusSnapshot,
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
    expect(existsSync(`${engineStatusSnapshotPath(harness)}.tmp`)).toBe(false)
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
