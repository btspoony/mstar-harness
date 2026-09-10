/**
 * Durable engine-status snapshot store — the edge-safe catalog source that a
 * web-only reader (panel/endpoint) can serve WITHOUT re-running the in-process
 * resolution that produces the step catalog.
 *
 * WHY a snapshot: the composed catalog payload is only available at the
 * digest-gated `agent/pre-step` emission; a later reader (a different fiber,
 * or the host endpoint answering a browser request) cannot rebuild it — it
 * would re-resolve `{HARNESS_DIR}`, re-scan status/compass/residual, and could
 * answer with state that never reached the model. Persisting the EXACT emitted
 * payload at the emission site makes the served value a record of what the
 * model actually saw, keyed by the session that saw it.
 *
 * File: `{HARNESS_DIR}/snapshots/engine-status.json`
 *
 * ```json
 * {
 *   "sv": 1,
 *   "entries": { "<session id>": [ { "rv": 1, "cwd": "/proj", "at": "…", "turn": 3, "payload": { … } } ] }
 * }
 * ```
 *
 * `sv` is the envelope schema version and `rv` the per-entry record version:
 * a reader that does not recognize EITHER must answer "unavailable" rather
 * than parse a shape it does not understand — and (write rule below) a writer
 * must refuse rather than replace one.
 *
 * Durability discipline (same as the agent-flow ledger):
 * - every write runs under the per-directory inter-process write lock
 *   ({@link withWorkflowDirLock} — atomic `mkdir` lockdir, the package's
 *   single lock primitive);
 * - the file itself is replaced by `writeFileSync(<writer-unique>.tmp)` +
 *   `renameSync` (atomic replace — concurrent readers never observe a torn
 *   file, and the failure cleanup can only ever remove its own temp file);
 * - retention is enforced on EVERY write: newest
 *   {@link ENGINE_STATUS_SNAPSHOT_MAX_PER_SESSION} entries per session,
 *   nothing older than {@link ENGINE_STATUS_SNAPSHOT_MAX_AGE_MS}, and the whole
 *   envelope under {@link ENGINE_STATUS_SNAPSHOT_MAX_BYTES}.
 *
 * READ RULE (HARD): `sv !== 1`, an unknown shape, an unreadable file, or an
 * absent file all yield the explicit {@link EngineStatusUnavailable} result.
 * A best-effort parse is never returned — a reader must not present guessed
 * state as the model's state.
 *
 * WRITE RULE (HARD): the same rule governs the writer. An existing envelope
 * whose `sv` is unknown, whose JSON is torn, or that cannot be read is NOT
 * replaceable: the write refuses with the explicit `degraded` reason and
 * leaves the bytes untouched. Every session's snapshots live in that one file,
 * so "start from an empty envelope" would silently destroy the snapshots of
 * every other session sharing this `{HARNESS_DIR}` — a store the writer does
 * not understand is never the writer's to overwrite (a version flap between
 * two plugin builds, or a hand-truncated file, must not become data loss).
 *
 * BOUNDS: retention is per-session ({@link ENGINE_STATUS_SNAPSHOT_MAX_PER_SESSION}
 * + {@link ENGINE_STATUS_SNAPSHOT_MAX_AGE_MS}) AND global
 * ({@link ENGINE_STATUS_SNAPSHOT_MAX_BYTES}): a store above the byte ceiling
 * sheds its least-recently-written session buckets — oldest first, never the
 * writing session — and the write path reports the oversize condition ONCE per
 * store so the host can log the one warning the containment contract promises
 * instead of a warning per turn.
 *
 * KEYING (HARD): both session maps are prototype-less (`Object.create(null)`),
 * and the read path gates on `Object.hasOwn`. The session id is caller-chosen
 * on the host's `session.create` (a branded string with no shape validation),
 * so an id equal to an `Object.prototype` member (`__proto__`, `constructor`,
 * `toString`, …) must be an ordinary key: on a plain object literal it would
 * instead read an inherited member (a non-array → `TypeError`) or hit the
 * `__proto__` setter (reported `written` while persisting nothing).
 *
 * @module @mstar-harness/dsh/engine-status-store
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withWorkflowDirLock } from './gates/agent-flow.ts'

/** Envelope schema version carried by the snapshot file (`sv`). */
export const ENGINE_STATUS_SNAPSHOT_VERSION = 1
/** Per-entry record version carried by every stored entry (`rv`). */
export const ENGINE_STATUS_SNAPSHOT_ENTRY_VERSION = 1
/** Retention: newest entries kept per session (older ones are pruned on write). */
export const ENGINE_STATUS_SNAPSHOT_MAX_PER_SESSION = 50
/** Retention: maximum entry age (30 days) — older entries are pruned on write. */
export const ENGINE_STATUS_SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/**
 * Retention: global byte ceiling for one store — the bound the per-session
 * numbers above cannot express, since every session in a workspace shares this
 * one file. Calibrated on the measured emission payload (≈19 KB per entry,
 * ≈0.9 MB per session at the 50-entry cap) to ≈16 MB, i.e. ≈40 sessions before
 * the oldest buckets are evicted; the writing session is never the one evicted.
 */
export const ENGINE_STATUS_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024
/**
 * Lock-acquisition budget (ms) for the advisory snapshot write. The write runs
 * synchronously on the per-turn `agent/pre-step` emission path, so it may never
 * inherit the ledger's 30 s deadline: contention (or a stale lockdir left by a
 * killed host) must degrade the advisory write quickly instead of stalling the
 * agent step — and, in the same process, the `/api` gateway that serves the
 * panel.
 */
export const ENGINE_STATUS_SNAPSHOT_LOCK_TIMEOUT_MS = 250
/** Snapshot file location relative to `{HARNESS_DIR}`. */
export const ENGINE_STATUS_SNAPSHOT_RELATIVE_PATH = 'snapshots/engine-status.json'

/**
 * One stored emission: the payload the model saw, plus the identity needed to
 * validate a later reader's claim (`cwd` is the session workspace the payload
 * was resolved for).
 */
export interface EngineStatusSnapshotEntry {
  /** Record version — a reader must see {@link ENGINE_STATUS_SNAPSHOT_ENTRY_VERSION}. */
  readonly rv: number
  /** The session workspace the payload was resolved for (validation anchor). */
  readonly cwd: string
  /** ISO timestamp of the emission. */
  readonly at: string
  /** The agent turn the payload was emitted for. */
  readonly turn: number
  /** The exact catalog payload object handed to the step messages. */
  readonly payload: Record<string, unknown>
}

/** Why a snapshot read could not produce the stored entry (every path explicit). */
export type EngineStatusSnapshotUnavailableReason =
  | 'no-harness-dir'
  | 'absent'
  | 'unreadable'
  | 'invalid-json'
  | 'envelope-schema'
  | 'no-session-entry'
  | 'entry-schema'

/** The explicit "no answer" result — never a best-effort parse. */
export interface EngineStatusUnavailable {
  readonly kind: 'unavailable'
  readonly reason: EngineStatusSnapshotUnavailableReason
}

/** Read outcome: the stored entry, or the explicit unavailable state. */
export type EngineStatusSnapshotRead =
  | { readonly kind: 'ok'; readonly entry: EngineStatusSnapshotEntry }
  | EngineStatusUnavailable

/** Write outcome: written, or the degraded reason (never throws for I/O faults). */
export type EngineStatusSnapshotWrite =
  | {
    readonly kind: 'written'
    readonly path: string
    readonly entries: number
    /** Session buckets shed to stay under the global byte ceiling (0 when none). */
    readonly evicted: number
    /**
     * Present ONLY on the first oversize write for this store in this process —
     * the caller logs it. One warning per store, never one per turn.
     */
    readonly warn?: string
  }
  | { readonly kind: 'degraded'; readonly reason: string }

/** One write request — the emission site's payload plus its session identity. */
export interface EngineStatusSnapshotWriteInput {
  /** The session whose catalog row this payload is (`session.header.id`). */
  readonly sessionId: string
  /** The session workspace the payload was resolved for (`session.header.cwd`). */
  readonly cwd: string
  /** The agent turn the row was emitted for. */
  readonly turn: number
  /** The exact payload object handed to the step messages. */
  readonly payload: object
  /** Emission timestamp (test seam; production uses `new Date()`). */
  readonly now?: Date
  /** Global byte ceiling override (test seam; production uses the constant). */
  readonly maxBytes?: number
}

/** Absolute snapshot file path for one `{HARNESS_DIR}`. */
export function engineStatusSnapshotPath(harnessDir: string): string {
  return join(harnessDir, ENGINE_STATUS_SNAPSHOT_RELATIVE_PATH)
}

/** The explicit unavailable result (single constructor — one shape everywhere). */
export function engineStatusUnavailable(
  reason: EngineStatusSnapshotUnavailableReason,
): EngineStatusUnavailable {
  return { kind: 'unavailable', reason }
}

/** Structural test for a plain JSON object (never an array, never null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Interpret one unknown array element as a stored entry, or undefined. */
function asEntry(value: unknown): EngineStatusSnapshotEntry | undefined {
  if (!isPlainObject(value)) return undefined
  if (value.rv !== ENGINE_STATUS_SNAPSHOT_ENTRY_VERSION) return undefined
  const cwd = nonEmptyString(value.cwd)
  const at = nonEmptyString(value.at)
  if (cwd === undefined || at === undefined) return undefined
  if (typeof value.turn !== 'number' || !Number.isFinite(value.turn)) return undefined
  if (!isPlainObject(value.payload)) return undefined
  return { rv: value.rv as number, cwd, at, turn: value.turn, payload: value.payload }
}

/** Age of one entry in ms, or undefined when its `at` is not a usable timestamp. */
function entryAge(at: string, nowMs: number): number | undefined {
  const parsed = Date.parse(at)
  if (!Number.isFinite(parsed)) return undefined
  return nowMs - parsed
}

/**
 * Read the newest stored snapshot entry for one session.
 *
 * Every failure path is explicit: `{HARNESS_DIR}` unresolved (`no-harness-dir`),
 * file absent (`absent`), unreadable (`unreadable`), not JSON (`invalid-json`),
 * wrong envelope shape/`sv` (`envelope-schema`), no entries for the session
 * (`no-session-entry`), or an unreadable entry record (`entry-schema`).
 * @param harnessDir - the resolved `{HARNESS_DIR}` (null when none resolved).
 * @param sessionId - the session whose snapshot is requested.
 * @returns the newest stored entry, or the explicit unavailable state.
 */
export function readEngineStatusSnapshot(
  harnessDir: string | null,
  sessionId: string,
): EngineStatusSnapshotRead {
  if (harnessDir === null || harnessDir === '') return engineStatusUnavailable('no-harness-dir')
  if (sessionId === '') return engineStatusUnavailable('no-session-entry')
  let raw: string
  try {
    raw = readFileSync(engineStatusSnapshotPath(harnessDir), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return engineStatusUnavailable(code === 'ENOENT' ? 'absent' : 'unreadable')
  }
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return engineStatusUnavailable('invalid-json')
  }
  if (!isPlainObject(doc) || doc.sv !== ENGINE_STATUS_SNAPSHOT_VERSION) {
    return engineStatusUnavailable('envelope-schema')
  }
  const entries = doc.entries
  if (!isPlainObject(entries)) return engineStatusUnavailable('envelope-schema')
  // OWN key only: the session id is caller-chosen on the host's `session.create`,
  // so `entries['constructor']` must never resolve an inherited member.
  if (!Object.hasOwn(entries, sessionId)) return engineStatusUnavailable('no-session-entry')
  const bucket = entries[sessionId]
  if (!Array.isArray(bucket) || bucket.length === 0) return engineStatusUnavailable('no-session-entry')
  const entry = asEntry(bucket[bucket.length - 1])
  if (entry === undefined) return engineStatusUnavailable('entry-schema')
  return { kind: 'ok', entry }
}

/** The in-memory shape of one persisted envelope. */
interface SnapshotDoc {
  sv: number
  entries: Record<string, EngineStatusSnapshotEntry[]>
}

/**
 * A prototype-less session map. Session ids are caller-chosen (`session.create`
 * brand-casts whatever the caller sent), so an id equal to an `Object.prototype`
 * member must behave exactly like any other key — on a plain object literal
 * `entries['__proto__']` would reach the setter (and `'constructor'` an
 * inherited function) instead of the bucket.
 */
function sessionMap(): Record<string, EngineStatusSnapshotEntry[]> {
  return Object.create(null) as Record<string, EngineStatusSnapshotEntry[]>
}

/**
 * The read-modify-write precondition: a usable envelope, or the explicit reason
 * the write refuses. An existing file the writer cannot understand is NEVER
 * treated as an empty envelope — this file holds every session's snapshots.
 */
type WriteLoad =
  | { readonly kind: 'ok'; readonly doc: SnapshotDoc }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * Load the existing envelope for a read-modify-write.
 *
 * Absent → a fresh envelope (the normal first write). Present but unreadable,
 * torn, a non-object, or carrying an `sv` this build does not know → `refused`
 * (the caller degrades with that reason and touches nothing). The read rule and
 * the write rule are the same rule: what the reader must not parse is what the
 * writer must not overwrite.
 */
function loadForWrite(harnessDir: string): WriteLoad {
  let raw: string
  try {
    raw = readFileSync(engineStatusSnapshotPath(harnessDir), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'ok', doc: { sv: ENGINE_STATUS_SNAPSHOT_VERSION, entries: sessionMap() } }
    }
    return { kind: 'refused', reason: 'store-unreadable' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'refused', reason: 'store-invalid-json' }
  }
  if (!isPlainObject(parsed) || parsed.sv !== ENGINE_STATUS_SNAPSHOT_VERSION || !isPlainObject(parsed.entries)) {
    return { kind: 'refused', reason: 'store-envelope-schema' }
  }
  const entries = sessionMap()
  for (const [key, value] of Object.entries(parsed.entries)) {
    if (!Array.isArray(value)) continue
    const kept: EngineStatusSnapshotEntry[] = []
    for (const candidate of value) {
      const entry = asEntry(candidate)
      if (entry !== undefined) kept.push(entry)
    }
    if (kept.length > 0) entries[key] = kept
  }
  return { kind: 'ok', doc: { sv: ENGINE_STATUS_SNAPSHOT_VERSION, entries } }
}

/**
 * Retention filter: drop an entry whose `at` is not a usable timestamp (it can
 * never be aged or ordered) and one older than
 * {@link ENGINE_STATUS_SNAPSHOT_MAX_AGE_MS}; then keep the newest
 * {@link ENGINE_STATUS_SNAPSHOT_MAX_PER_SESSION} of what remains.
 */
function pruneBucket(
  bucket: readonly EngineStatusSnapshotEntry[],
  nowMs: number,
): EngineStatusSnapshotEntry[] {
  const fresh: EngineStatusSnapshotEntry[] = []
  for (const entry of bucket) {
    const age = entryAge(entry.at, nowMs)
    if (age === undefined || age > ENGINE_STATUS_SNAPSHOT_MAX_AGE_MS) continue
    fresh.push(entry)
  }
  if (fresh.length <= ENGINE_STATUS_SNAPSHOT_MAX_PER_SESSION) return fresh
  return fresh.slice(fresh.length - ENGINE_STATUS_SNAPSHOT_MAX_PER_SESSION)
}

/** Emission time of a bucket's newest entry (0 when no entry carries one). */
function bucketRecency(bucket: readonly EngineStatusSnapshotEntry[]): number {
  let newest = 0
  for (const entry of bucket) {
    const parsed = Date.parse(entry.at)
    if (Number.isFinite(parsed) && parsed > newest) newest = parsed
  }
  return newest
}

/**
 * Enforce the GLOBAL bound: shed whole session buckets, least-recently-written
 * first, until the serialized envelope fits `maxBytes`. The writing session is
 * never evicted (its bucket is the write's whole point) — when it alone exceeds
 * the ceiling the store is written as-is and only the oversize signal is raised.
 * @param pruned - the per-session-pruned map (mutated).
 * @param keep - the session the write belongs to (never evicted).
 * @param maxBytes - the byte ceiling for the serialized envelope.
 * @param sizeOf - serialized size of a candidate map.
 * @returns how many buckets were shed.
 */
function enforceGlobalBound(
  pruned: Record<string, EngineStatusSnapshotEntry[]>,
  keep: string,
  maxBytes: number,
  sizeOf: (entries: Record<string, EngineStatusSnapshotEntry[]>) => number,
): number {
  if (sizeOf(pruned) <= maxBytes) return 0
  const candidates = Object.keys(pruned)
    .filter((key) => key !== keep)
    .map((key) => ({ key, recency: bucketRecency(pruned[key] as EngineStatusSnapshotEntry[]) }))
    .sort((left, right) => left.recency - right.recency)
  let evicted = 0
  for (const candidate of candidates) {
    if (sizeOf(pruned) <= maxBytes) break
    // `delete` on a prototype-less map: an ordinary key removal, never a
    // prototype interaction (same reason the map is created without one).
    delete pruned[candidate.key]
    evicted += 1
  }
  return evicted
}

/** Stores that already raised their one oversize warning in this process. */
const oversizeWarned = new Set<string>()

/**
 * Persist one emission: append the entry for `sessionId`, prune (age + per
 * session cap + the global byte ceiling), and atomically replace the file — the
 * whole read-modify-write under the directory write lock.
 *
 * Contained by design: a lock timeout, a missing/unwritable directory, a failed
 * replace, or an existing store this build does not understand returns
 * `{kind:'degraded', reason}` (the advisory emission path must never abort the
 * step it observes, and must never destroy what it cannot read). The in-memory
 * payload is unaffected either way.
 * @param harnessDir - the resolved `{HARNESS_DIR}` (null when none resolved).
 * @param input - the emission's session identity + payload.
 * @returns written (with the entry count, the evicted-bucket count and — once
 *   per store — the oversize warning) or the degraded reason.
 */
export function writeEngineStatusSnapshot(
  harnessDir: string | null,
  input: EngineStatusSnapshotWriteInput,
): EngineStatusSnapshotWrite {
  if (harnessDir === null || harnessDir === '') return { kind: 'degraded', reason: 'no-harness-dir' }
  if (input.sessionId === '') return { kind: 'degraded', reason: 'no-session-id' }
  if (input.cwd === '') return { kind: 'degraded', reason: 'no-session-cwd' }
  if (!Number.isFinite(input.turn)) return { kind: 'degraded', reason: 'invalid-turn' }
  if (!isPlainObject(input.payload)) return { kind: 'degraded', reason: 'payload-not-object' }
  const at = (input.now ?? new Date()).toISOString()
  if (!Number.isFinite(Date.parse(at))) return { kind: 'degraded', reason: 'invalid-timestamp' }
  const dir = dirname(engineStatusSnapshotPath(harnessDir))
  const file = engineStatusSnapshotPath(harnessDir)
  // Writer-unique temp name: the failure cleanup below removes EXACTLY the file
  // this call created. A shared `${file}.tmp` would let one writer's error path
  // delete a concurrent writer's live temp file (its `renameSync` then fails
  // with ENOENT and that snapshot is silently dropped).
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    // The lockdir lives INSIDE the snapshot dir (same placement rule as the
    // ledger's), so the directory must exist before the atomic `mkdir` lock
    // acquisition — otherwise the missing parent surfaces as ENOENT, not as
    // lock contention.
    mkdirSync(dir, { recursive: true })
    return withWorkflowDirLock(dir, () => {
      const loaded = loadForWrite(harnessDir)
      // A store this build does not understand is not the writer's to replace:
      // refusing keeps every other session's snapshots (and the bytes the newer
      // build wrote) intact, and the reader answers `unavailable` for it anyway.
      if (loaded.kind === 'refused') return { kind: 'degraded' as const, reason: loaded.reason }
      const doc = loaded.doc
      const nowMs = Date.parse(at)
      const bucket = pruneBucket(doc.entries[input.sessionId] ?? [], nowMs)
      bucket.push({
        rv: ENGINE_STATUS_SNAPSHOT_ENTRY_VERSION,
        cwd: input.cwd,
        at,
        turn: input.turn,
        payload: input.payload as Record<string, unknown>,
      })
      doc.entries[input.sessionId] = pruneBucket(bucket, nowMs)
      const pruned = sessionMap()
      for (const [key, value] of Object.entries(doc.entries)) {
        const kept = pruneBucket(value, nowMs)
        if (kept.length === 0) continue
        pruned[key] = kept
      }
      const maxBytes = input.maxBytes ?? ENGINE_STATUS_SNAPSHOT_MAX_BYTES
      const serialized = (entries: Record<string, EngineStatusSnapshotEntry[]>): string =>
        JSON.stringify({ sv: ENGINE_STATUS_SNAPSHOT_VERSION, entries })
      const evicted = enforceGlobalBound(pruned, input.sessionId, maxBytes, (entries) =>
        Buffer.byteLength(serialized(entries), 'utf8'))
      const payload = serialized(pruned)
      const oversized = Buffer.byteLength(payload, 'utf8') > maxBytes
      let total = 0
      for (const kept of Object.values(pruned)) total += kept.length
      writeFileSync(tmp, payload)
      renameSync(tmp, file)
      // One warning per oversize store, never one per turn: the latch is
      // per-store and monotonic for this process — an already-warned store
      // never warns again, so an eviction loop cannot turn the containment
      // warning into a per-turn log line.
      let warn: string | undefined
      if (oversized && !oversizeWarned.has(file)) {
        oversizeWarned.add(file)
        warn =
          `engine-status snapshot store ${file} is above its ${maxBytes}-byte ceiling ` +
          `(kept ${total} entries, shed ${evicted} oldest session bucket(s) this write); ` +
          'recovery: delete the file — it is prunable plugin-owned state and readers answer unavailable for it'
      }
      return {
        kind: 'written' as const,
        path: file,
        entries: total,
        evicted,
        ...(warn === undefined ? {} : { warn }),
      }
    }, { timeoutMs: ENGINE_STATUS_SNAPSHOT_LOCK_TIMEOUT_MS })
  } catch (error) {
    // Remove ONLY this call's temp file: the lock may have failed before the
    // directory existed, and the name above is unique to this writer.
    try {
      rmSync(tmp, { force: true })
    } catch {
      // best-effort cleanup only
    }
    return { kind: 'degraded', reason: (error as Error)?.message ?? 'write-failed' }
  }
}
