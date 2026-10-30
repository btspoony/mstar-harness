/**
 * execution-ledgers.ts — the retained, file-native **workflow notes ledger**
 * (phase2b-execution-contract §5 "F1 — notes", S3).
 *
 * The ledger is `<control root>/workflows/<id>/notes.jsonl` — the same file the
 * v1 migration already emits (`migrate.ts` `NOTES_LEDGER_FILE`, one
 * `{kind:"note",ts,text}` line per legacy row note). It is a plain append-only
 * process log, **not** an accepted-operation ledger: bytes stay files with
 * provenance and append order (no DB copy of a note), a record id is caller
 * metadata rather than a dedup key, and this module never converts a note into a
 * DB event and never rewrites history to add metadata.
 *
 * ## What this module owns
 *
 * - `appendWorkflowNote` — the ONE append path. It is active-route only: the
 *   caller must hand in an `ExecutionSessionRef` that C1's
 *   `assertExecutionSessionCurrent` still accepts, and the note's provenance
 *   must be that bound session's own scope. Identity is never inferred from a
 *   model-supplied field, a cached selection or the note body: the record's
 *   `workflowId`/`sessionId` are checked against the session the engine is
 *   already authorizing, never used as its source.
 * - `normalizeWorkflowNotesCoverage` — a pure projection of the retained bytes
 *   into the inspectable facts a coverage producer needs: the canonical path,
 *   the file hash, the ordered historical lines with their
 *   `(source-file-sha256, line-index)` identity, the ordered records with their
 *   line hashes, the unaccepted tail and the counts. It never reads or writes
 *   anything.
 *
 * ## One framed append — no lock, no read (contract §4.3)
 *
 * `appendWorkflowNote` proves the control root exists, resolves (and, when
 * genuinely absent and already authorized, materializes) the retained workflow
 * body dir, then takes C1's synchronous current-session assertion immediately
 * before a **single `O_APPEND` write** of the complete framed record. The opened
 * descriptor must still name the canonical leaf immediately before writing and
 * again after fsync, before a success receipt is issued. An ordinary append
 * takes no file lock, no maintenance exclusion, no whole-file read, no dedup
 * decision, no tail repair and no truncation. A later external rotation
 * can still move an already-written inode after the final observation; this is
 * not a rotation lock. **Every** frame carries a leading LF, including the one
 * that creates the leaf, so its line survives when a peer writes a partial
 * record after open and before this write. A stale epoch, a revoked session or
 * a foreign caller refuses before any byte is written, and append success means
 * the frame is fsynced.
 *
 * ## Leaf trust
 *
 * The retained leaf is opened with `O_NOFOLLOW` and verified with `fstat`: it
 * must be a regular file. A symlinked leaf, a non-file, a symlinked body dir and
 * a missing control root refuse instead of being followed or materialized.
 *
 * ## Ceiling and compaction (the one maintenance step)
 *
 * A ledger only grows between compactions, so `WORKFLOW_NOTES_LEDGER_MAX_BYTES`
 * is enforced by the append that would reach it: when the frame can leave the
 * ledger at or past the ceiling, the frame and the compaction it triggers run as
 * ONE critical section under the store's own `BEGIN IMMEDIATE` write lock
 * (`withWorkflowNotesMaintenanceLock`, never a lock file), so no peer frame can
 * land between a compaction's read and its rename. Compaction keeps the newest
 * complete lines that fit `WORKFLOW_NOTES_LEDGER_READ_BYTES`, always keeps the
 * triggering note whole, and writes a `workflow-notes-compaction` row as the
 * FINAL line disclosing the dropped prefix. It is the only writer that rewrites
 * retained bytes, and it rewrites them atomically: a same-directory temporary
 * file, fsync, rename over the leaf, then the directory fsynced.
 *
 * ## Reader and failure semantics (S3)
 *
 * Repeated ids and repeated submissions append repeated records — the log makes
 * no replay or conflict promise. A short append leaves exactly the bytes that
 * landed and reports the failure; it never removes or repairs a peer's bytes.
 * Readers tolerate blank, unrecognized and truncated records and continue to
 * later valid records, so a partial record never blocks a later append and a
 * record boundary always survives an earlier partial record.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  type Stats,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonicalTarget, isNonEmptyString, isPlainObject, sha256Bytes } from "./coordination-write.js";
import { assertExecutionSessionCurrent } from "./execution-session.js";
import { withExecutionTransaction, type ExecutionContext, type ExecutionSessionRef } from "./execution-store.js";
import { NOTES_LEDGER_FILE } from "./migrate.js";
import { assertSafePathComponent, resolveWorkflowDir } from "./path.js";
import { storeDbPath, type StoreContext } from "./store-db.js";

/* ------------------------------------------------------------------------ *
 * Public shapes (§5)
 * ------------------------------------------------------------------------ */

/**
 * One new-format ledger record (§5). `id` is the caller's record identity —
 * metadata carried for correlation, deliberately NOT a dedup key: the same id
 * may be appended again. `workflowId`/`sessionId` are the provenance the engine
 * preserves; the note text carries no authority of any kind.
 */
export type WorkflowNote = Readonly<{
  version: 1;
  id: string;
  workflowId: string;
  sessionId: string;
  kind: "note";
  ts: string;
  text: string;
}>;

/**
 * The retained ledger ceiling. An append that leaves the ledger above this size
 * compacts it in the same maintenance transaction, so an actively written
 * ledger costs a bounded amount of disk instead of growing with its age.
 */
export const WORKFLOW_NOTES_LEDGER_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The coverage read window: a reader reads at most this many bytes of the
 * ledger's tail and discloses the window it saw, so inspection cost is bounded
 * regardless of the ledger's age. Compaction keeps the newest complete lines
 * inside this window where it can.
 */
export const WORKFLOW_NOTES_LEDGER_READ_BYTES = 1024 * 1024;

/** The `kind` of the disclosure row compaction writes; the constant owns it. */
export const WORKFLOW_NOTES_COMPACTION_MARKER_KIND = "workflow-notes-compaction";

/** The append receipt: the record id this append wrote. */
export type WorkflowNoteAppendReceipt = Readonly<{ id: string }>;

/**
 * The disclosure row one compaction writes as the ledger's FINAL line, so even a
 * windowed tail read learns that history it cannot see was dropped. It carries
 * no note `id`/`sessionId`: the retained line log is content, this row is the
 * count of content that is gone. `dropped` and `prefixSha256` describe only the
 * prefix THIS compaction removed — a later compaction replaces the row.
 */
export type WorkflowNotesCompactionMarker = Readonly<{
  version: 1;
  kind: typeof WORKFLOW_NOTES_COMPACTION_MARKER_KIND;
  ts: string;
  workflowId: string;
  dropped: Readonly<{ bytes: number; lines: number; records: number; historical: number; unrecognized: number }>;
  /** sha256 of every dropped byte, in file order. */
  prefixSha256: string;
}>;

/** The byte window a coverage reader actually read out of one ledger file. */
export type WorkflowNotesReadWindow = Readonly<{
  /** Offset of the window's first byte in the file. */
  offset: number;
  /** The whole file's size: what the window is a slice of. */
  totalBytes: number;
  /** Whether the file is larger than the window, so the head is undisclosed. */
  truncated: boolean;
}>;

type WorkflowNoteRequest = Omit<WorkflowNote, "ts"> & Readonly<{ ts?: string }>;

/** Stable refusal codes of the notes ledger. */
export const EXECUTION_LEDGER_ERROR_CODES = [
  "execution-ledgers.record-invalid",
  "execution-ledgers.scope-mismatch",
  "execution-ledgers.target-untrusted",
  "execution-ledgers.target-replaced",
  "execution-ledgers.append-short",
] as const;

export type ExecutionLedgerErrorCode = (typeof EXECUTION_LEDGER_ERROR_CODES)[number];

/** Typed refusal with an actionable, stable code. */
export class ExecutionLedgerError extends Error {
  readonly code: ExecutionLedgerErrorCode;

  constructor(code: ExecutionLedgerErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "ExecutionLedgerError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------------ *
 * Canonical location
 * ------------------------------------------------------------------------ */

/**
 * The canonical control harness root that owns `context`'s store — resolved
 * from the store's own path (never from a caller-supplied root) and
 * canonicalized, exactly as `execution-minimal-import.ts`/`execution-store.ts`
 * resolve theirs, so every recorded path and every comparison is one spelling.
 */
function controlRootOf(context: StoreContext): string {
  return canonicalTarget(dirname(storeDbPath(context)));
}

/** One safe workflow-id path component, refused with this module's own code. */
function assertWorkflowId(workflowId: string, what = "workflow id"): void {
  try {
    assertSafePathComponent(workflowId, what);
  } catch (error) {
    throw new ExecutionLedgerError("execution-ledgers.record-invalid", (error as Error).message);
  }
}

/**
 * The canonical retained ledger path of one workflow: the configured
 * `{WORKFLOW_DIR}` (`.mstarc` overrides honored — the same resolver
 * `execution-store.ts` uses) plus `<workflowId>/notes.jsonl`. Pure path
 * resolution: nothing is created, and the leaf need not exist.
 */
export function workflowNotesLedgerPath(context: StoreContext, workflowId: string): string {
  assertWorkflowId(workflowId);
  const root = controlRootOf(context);
  return join(resolveWorkflowDir(root, { harnessDir: root }), workflowId, NOTES_LEDGER_FILE);
}

/* ------------------------------------------------------------------------ *
 * Record codec
 * ------------------------------------------------------------------------ */

const NOTE_KEYS = ["version", "id", "workflowId", "sessionId", "kind", "ts", "text"] as const;
const NOTE_KEY_ORDER = [...NOTE_KEYS].sort();

/** Parse the exact new-format record shape; anything else is `null`. */
function parseWorkflowNote(value: unknown): WorkflowNote | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== NOTE_KEY_ORDER.length || keys.some((key, index) => key !== NOTE_KEY_ORDER[index])) return null;
  if (value.version !== 1 || value.kind !== "note") return null;
  const { id, workflowId, sessionId, ts, text } = value;
  if (!isNonEmptyString(id) || !isNonEmptyString(workflowId) || !isNonEmptyString(sessionId) || !isNonEmptyString(ts)) {
    return null;
  }
  if (typeof text !== "string") return null;
  return { version: 1, id, workflowId, sessionId, kind: "note", ts, text };
}

/** Serialize a new ledger record in a stable key order, without a final LF. */
function canonicalNoteLine(note: WorkflowNote & { ts: string }): string {
  return JSON.stringify({
    version: 1,
    id: note.id,
    workflowId: note.workflowId,
    sessionId: note.sessionId,
    kind: "note",
    ts: note.ts,
    text: note.text,
  });
}

const MARKER_KEYS = ["version", "kind", "ts", "workflowId", "dropped", "prefixSha256"] as const;
const MARKER_KEY_ORDER = [...MARKER_KEYS].sort();
const DROPPED_KEYS = ["bytes", "lines", "records", "historical", "unrecognized"] as const;
const DROPPED_KEY_ORDER = [...DROPPED_KEYS].sort();

/** Parse the exact compaction-marker shape; anything else is `null`. */
function parseCompactionMarker(value: unknown): WorkflowNotesCompactionMarker | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== MARKER_KEY_ORDER.length || keys.some((key, index) => key !== MARKER_KEY_ORDER[index])) return null;
  if (value.version !== 1 || value.kind !== WORKFLOW_NOTES_COMPACTION_MARKER_KIND) return null;
  const { ts, workflowId, dropped, prefixSha256 } = value;
  if (!isNonEmptyString(ts) || !isNonEmptyString(workflowId) || !isNonEmptyString(prefixSha256)) return null;
  if (!isPlainObject(dropped)) return null;
  const droppedKeys = Object.keys(dropped).sort();
  if (droppedKeys.length !== DROPPED_KEY_ORDER.length || droppedKeys.some((key, index) => key !== DROPPED_KEY_ORDER[index])) {
    return null;
  }
  const counts = dropped as Record<string, unknown>;
  if (!DROPPED_KEYS.every((key) => typeof counts[key] === "number" && Number.isSafeInteger(counts[key]))) return null;
  return {
    version: 1,
    kind: WORKFLOW_NOTES_COMPACTION_MARKER_KIND,
    ts,
    workflowId,
    dropped: {
      bytes: counts.bytes as number,
      lines: counts.lines as number,
      records: counts.records as number,
      historical: counts.historical as number,
      unrecognized: counts.unrecognized as number,
    },
    prefixSha256,
  };
}

/** Serialize the marker in its declared field order, without a final LF. */
function canonicalMarkerLine(marker: WorkflowNotesCompactionMarker): string {
  return JSON.stringify({
    version: 1,
    kind: WORKFLOW_NOTES_COMPACTION_MARKER_KIND,
    ts: marker.ts,
    workflowId: marker.workflowId,
    dropped: {
      bytes: marker.dropped.bytes,
      lines: marker.dropped.lines,
      records: marker.dropped.records,
      historical: marker.dropped.historical,
      unrecognized: marker.dropped.unrecognized,
    },
    prefixSha256: marker.prefixSha256,
  });
}

/* ------------------------------------------------------------------------ *
 * Ledger scan — bytes only, never a whole-file rewrite
 * ------------------------------------------------------------------------ */

type LedgerLine =
  | Readonly<{ format: "legacy-note"; record: Readonly<{ kind: "note"; ts: string; text: string }> }>
  | Readonly<{ format: "versioned-note-v1"; record: WorkflowNote }>
  | Readonly<{ format: "compaction-marker"; marker: WorkflowNotesCompactionMarker }>
  | Readonly<{ format: "blank" }>
  | Readonly<{ format: "unrecognized" }>;

const UNRECOGNIZED_LINE: LedgerLine = { format: "unrecognized" };

/**
 * Classify one LF-terminated line. An empty line is `blank` — the framing byte
 * this writer puts before a record when the leaf already existed, and an
 * artifact no reader should report as a corrupt record. A v1
 * `{kind:"note",ts,text}` line is the historical format the migration emitted; a
 * `version:1` record is this module's format; everything else (including a
 * `version` field that is not a valid record) is unrecognized — reported, never
 * guessed.
 */
function parseLedgerLine(bytes: Buffer): LedgerLine {
  if (bytes.length === 0) return { format: "blank" };
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return UNRECOGNIZED_LINE;
  }
  const note = parseWorkflowNote(value);
  if (note !== null) return { format: "versioned-note-v1", record: note };
  // A compaction marker is a disclosure, never content: the reader reports it
  // as `compaction`, so it is neither a record nor an unrecognized line.
  const marker = parseCompactionMarker(value);
  if (marker !== null) return { format: "compaction-marker", marker };
  if (
    isPlainObject(value) &&
    value.version === undefined &&
    value.kind === "note" &&
    typeof value.ts === "string" &&
    typeof value.text === "string"
  ) {
    return { format: "legacy-note", record: { kind: "note", ts: value.ts, text: value.text } };
  }
  return UNRECOGNIZED_LINE;
}

type LedgerScanLine = Readonly<{ index: number; bytes: Buffer; line: LedgerLine }>;

type LedgerScan = Readonly<{
  lines: readonly LedgerScanLine[];
  /** Bytes after the last LF — a partial record a reader must skip, if any. */
  tail: Buffer;
}>;

/**
 * Scan retained bytes without decoding them as one string: lines are split on
 * the LF byte (one native scan, no per-byte loop), and any trailing partial line
 * is kept aside as the tail. Nothing is hashed, normalized, rewritten or dropped
 * here — hashing belongs to the coverage projection, which is the only consumer
 * that needs it.
 */
function scanLedger(bytes: Buffer): LedgerScan {
  const lines: LedgerScanLine[] = [];
  let start = 0;
  let end = bytes.indexOf(0x0a, start);
  while (end !== -1) {
    const lineBytes = bytes.subarray(start, end);
    lines.push({ index: lines.length, bytes: lineBytes, line: parseLedgerLine(lineBytes) });
    start = end + 1;
    end = bytes.indexOf(0x0a, start);
  }
  return { lines, tail: bytes.subarray(start) };
}

/* ------------------------------------------------------------------------ *
 * Durable byte-level commit
 * ------------------------------------------------------------------------ */

/**
 * Open one leaf without ever following a symbolic link; a link refuses. The
 * `O_NOFOLLOW` flag comes from `fs.constants` (the repo's one source for open
 * flags); where a platform does not provide it, the `fstat` verification of the
 * same descriptor remains the boundary.
 */
function openWithoutFollowing(path: string, flags: number, mode?: number): number {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  try {
    return mode === undefined ? openSync(path, flags | noFollow) : openSync(path, flags | noFollow, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ExecutionLedgerError(
        "execution-ledgers.target-untrusted",
        `${path} is a symbolic link; a retained ledger leaf is opened directly and never followed.`,
      );
    }
    throw error;
  }
}

/** Fsync one directory's own entry (used only when this append created a file). */
function fsyncDirectory(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Append one complete framed record in a SINGLE `O_APPEND` write. Nothing is
 * read first: there is no whole-file admission, no dedup decision, no peer-tail
 * repair and no truncation. A short append is reported as a failure and leaves
 * exactly the bytes that landed, so a later record is still reachable.
 *
 * Every frame — including one that creates the leaf — carries one leading LF.
 * The leaf is not private between this call's open and its write: a peer can
 * create it, or extend it with a partial record, in that window, so a boundary
 * decided from the open alone would fuse this record to an unterminated line and
 * hide an acknowledged note from every reader. The leading LF is unconditional
 * for the same reason on a leaf this call created. A boundary written into a
 * leaf that already ended with LF, or into a freshly created empty leaf, is an
 * empty line, which readers skip.
 */
function assertLedgerPathIdentity(path: string, opened: Stats, phase: "before append" | "before success receipt"): void {
  let current: Stats;
  try {
    current = lstatSync(path);
  } catch {
    throw new ExecutionLedgerError(
      "execution-ledgers.target-replaced",
      `${path} changed ${phase}; no success receipt was issued.`,
    );
  }
  if (current.dev !== opened.dev || current.ino !== opened.ino) {
    throw new ExecutionLedgerError(
      "execution-ledgers.target-replaced",
      `${path} now names a different file than the opened ledger ${phase}; no success receipt was issued.`,
    );
  }
}

function commitLedgerFrame(path: string, frame: Buffer): void {
  let fd: number;
  let opened: Stats;
  let created = false;
  try {
    fd = openWithoutFollowing(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o644);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    fd = openWithoutFollowing(path, fsConstants.O_WRONLY | fsConstants.O_APPEND);
  }
  try {
    opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new ExecutionLedgerError(
        "execution-ledgers.target-untrusted",
        `${path} is not a regular file; nothing was written.`,
      );
    }
    assertLedgerPathIdentity(path, opened, "before append");
    const line = Buffer.concat([Buffer.from("\n", "utf8"), frame]);
    const written = writeSync(fd, line, 0, line.length, null);
    if (written !== line.length) {
      throw new ExecutionLedgerError(
        "execution-ledgers.append-short",
        `only ${written} of ${line.length} bytes of the framed note reached ${path}; the partial bytes stay in place ` +
          `and are never repaired or truncated in a peer's name. Retry the append with a new record id.`,
      );
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (created) fsyncDirectory(dirname(path));
  assertLedgerPathIdentity(path, opened, "before success receipt");
}

/* ------------------------------------------------------------------------ *
 * Compaction — the size ceiling, under the store's own write lock
 * ------------------------------------------------------------------------ */

/** One physical line of the retained ledger: its byte span and whether it ended with LF. */
type LedgerSpan = Readonly<{ start: number; end: number; terminated: boolean }>;

/** The physical lines of one byte buffer, in file order; a trailing partial record is its own span. */
function ledgerSpans(bytes: Buffer): LedgerSpan[] {
  const spans: LedgerSpan[] = [];
  let start = 0;
  let end = bytes.indexOf(0x0a, start);
  while (end !== -1) {
    spans.push({ start, end, terminated: true });
    start = end + 1;
    end = bytes.indexOf(0x0a, start);
  }
  if (start < bytes.length) spans.push({ start, end: bytes.length, terminated: false });
  return spans;
}

/**
 * The most bytes one marker line can occupy for a ledger of `totalBytes`: every
 * `dropped` counter is bounded by the ledger's own size, so the digit count of
 * that number bounds each one, and the two framing LFs are the writer's own.
 */
function markerReserveBytes(totalBytes: number, workflowId: string): number {
  const reserve = Buffer.byteLength(
    canonicalMarkerLine({
      version: 1,
      kind: WORKFLOW_NOTES_COMPACTION_MARKER_KIND,
      ts: new Date(0).toISOString(),
      workflowId,
      dropped: { bytes: 0, lines: 0, records: 0, historical: 0, unrecognized: 0 },
      prefixSha256: "0".repeat(64),
    }),
    "utf8",
  );
  return reserve + 5 * String(totalBytes).length + 2;
}

/**
 * Write one ledger's next bytes to a same-directory temporary file and fsync it,
 * returning that path. The retained ledger is untouched: the caller publishes the
 * temporary file over the leaf only after checking the bytes it classified are
 * still what the leaf holds.
 */
function writeLedgerTempFile(path: string, content: Buffer): string {
  const temp = join(dirname(path), `${basename(path)}.compaction-${randomUUID()}.tmp`);
  try {
    const fd = openWithoutFollowing(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o644);
    try {
      let written = 0;
      while (written < content.length) {
        const step = writeSync(fd, content, written, content.length - written, null);
        if (step <= 0) {
          throw new ExecutionLedgerError(
            "execution-ledgers.append-short",
            `the compacted ledger for ${path} could not be written in full; the retained bytes are unchanged and ` +
              `the temporary file was removed. Retry the append with a new record id.`,
          );
        }
        written += step;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return temp;
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // the temporary file is already gone
    }
    throw error;
  }
}

/**
 * Whether the ledger still holds exactly the bytes this compaction classified:
 * `totalBytes` unchanged. An ordinary append is lock-free and only lengthens the
 * leaf, so a changed size means the compacted prefix no longer describes what is
 * there and the rewrite must be abandoned instead of deleting a peer's frame.
 */
function ledgerSnapshotUnchanged(path: string, totalBytes: number): boolean {
  try {
    return lstatSync(path).size === totalBytes;
  } catch {
    return false;
  }
}

/**
 * Compact one over-ceiling ledger: keep the newest complete lines that fit the
 * read window, always keep the triggering note whole, and write the disclosure
 * marker as the FINAL row so a windowed tail read still sees it. `dropped` and
 * `prefixSha256` describe the bytes THIS compaction removed; every earlier
 * marker is metadata and is dropped too, so exactly one marker survives and it
 * is the last row.
 *
 * The rewrite is published only when the leaf still holds the snapshot this
 * function classified: an ordinary append is lock-free and may lengthen the
 * ledger between the read and the rename, and renaming over that frame would
 * delete it. A changed snapshot abandons the compaction; the ledger stays over
 * its ceiling and the next append past it retries.
 *
 * A single note larger than the window is the recorded exception to the target
 * size: it is retained whole, and the tail read discloses the cut instead of the
 * writer silently shortening the note.
 */
function compactWorkflowNotesLedger(path: string, workflowId: string): void {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const totalBytes = bytes.length;
  if (totalBytes <= WORKFLOW_NOTES_LEDGER_MAX_BYTES) return;
  const spans = ledgerSpans(bytes);
  const lineOf = (span: LedgerSpan): LedgerLine => parseLedgerLine(bytes.subarray(span.start, span.end));
  // A marker is never content: it is dropped wherever it sits, so a marker an
  // earlier compaction left behind an interior line cannot survive alongside
  // the one this pass writes.
  const content = spans.filter((span) => lineOf(span).format !== "compaction-marker");
  const budget = WORKFLOW_NOTES_LEDGER_READ_BYTES - markerReserveBytes(totalBytes, workflowId);
  const spanBytes = (span: LedgerSpan): number =>
    (span.terminated ? span.end + 1 : span.end) - span.start;
  let firstKept = content.length;
  let keptBytes = 0;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const size = spanBytes(content[index]!);
    // The triggering note is always retained whole; older lines only while they fit.
    if (index !== content.length - 1 && keptBytes + size > budget) break;
    keptBytes += size;
    firstKept = index;
  }
  const kept = content.slice(firstKept);
  const keptStarts = new Set(kept.map((span) => span.start));
  let lines = 0;
  let records = 0;
  let historical = 0;
  let unrecognized = 0;
  const removed: Buffer[] = [];
  for (const span of spans) {
    if (keptStarts.has(span.start)) continue;
    const line = lineOf(span);
    if (line.format === "compaction-marker") continue;
    lines += 1;
    if (line.format === "versioned-note-v1") records += 1;
    else if (line.format === "legacy-note") historical += 1;
    else if (line.format === "unrecognized") unrecognized += 1;
    removed.push(bytes.subarray(span.start, span.terminated ? span.end + 1 : span.end));
  }
  const dropped = Buffer.concat(removed);
  const marker: WorkflowNotesCompactionMarker = {
    version: 1,
    kind: WORKFLOW_NOTES_COMPACTION_MARKER_KIND,
    ts: new Date().toISOString(),
    workflowId,
    dropped: { bytes: dropped.length, lines, records, historical, unrecognized },
    prefixSha256: sha256Bytes(dropped),
  };
  const temp = writeLedgerTempFile(
    path,
    Buffer.concat([
      ...kept.map((span) => bytes.subarray(span.start, span.terminated ? span.end + 1 : span.end)),
      Buffer.from("\n", "utf8"),
      Buffer.from(canonicalMarkerLine(marker), "utf8"),
      Buffer.from("\n", "utf8"),
    ]),
  );
  if (!ledgerSnapshotUnchanged(path, totalBytes)) {
    // A peer frame landed after this snapshot; renaming over it would delete
    // that frame. The append that lengthened the ledger is the next trigger.
    try {
      unlinkSync(temp);
    } catch {
      // the temporary file is already gone
    }
    return;
  }
  renameSync(temp, path);
  fsyncDirectory(dirname(path));
}

/**
 * Serialize one append with the compaction it may trigger, through the store's
 * existing `BEGIN IMMEDIATE` transaction — the engine's one write lock, taken
 * here instead of a lock file. Two concurrent appends therefore cannot both
 * decide to compact from the same stale size, and no frame can land between a
 * compaction's read and its rename.
 */
function withWorkflowNotesMaintenanceLock<T>(context: StoreContext, body: () => T): Promise<T> {
  return withExecutionTransaction(context, () => body());
}

/**
 * Whether the ledger is at or past its ceiling once `appendBytes` land: the ONE
 * case in which an append is a maintenance step (it can rewrite retained bytes)
 * rather than an ordinary framed write.
 */
function ledgerAtOrOverCeiling(path: string, appendBytes: number): boolean {
  try {
    return lstatSync(path).size + appendBytes > WORKFLOW_NOTES_LEDGER_MAX_BYTES;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------ *
 * Target trust
 * ------------------------------------------------------------------------ */

/**
 * One directory this writer needs to already be a real directory: never a
 * symlink and never a non-directory. The control root is never materialized —
 * an append retains a body, it does not re-scaffold the harness.
 */
function assertRealDirectory(path: string, what: string): void {
  let info: Stats | null = null;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (info === null) {
    throw new ExecutionLedgerError(
      "execution-ledgers.target-untrusted",
      `${what} at ${path} does not exist; a retained body append never creates it.`,
    );
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ExecutionLedgerError(
      "execution-ledgers.target-untrusted",
      `${what} at ${path} is not a real directory (a symlink or a non-directory is not a retained ledger home).`,
    );
  }
}

/**
 * Resolve the retained per-workflow **body dir** before the append. It must be
 * a real directory or genuinely absent; a symlink or a non-directory refuses
 * (the write could otherwise land outside the control root).
 *
 * When it is absent, the authorized current session is proven BEFORE anything
 * is created: an authorized session may materialize its own workflow's body dir
 * (durably — the dir, then its parent entry, is fsynced), while a stale,
 * revoked, foreign or mismatched session refuses with no directory side effect
 * at all. Only the body dir is created — never a snapshot, a root register or
 * any other authority file, and never a second workflow's dir.
 */
function prepareWorkflowBodyDir(context: ExecutionContext, session: ExecutionSessionRef, dir: string): void {
  let info: Stats | null = null;
  try {
    info = lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (info !== null) {
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ExecutionLedgerError(
        "execution-ledgers.target-untrusted",
        `the retained workflow dir at ${dir} is not a real directory (a symlink or a non-directory is not a retained ledger home).`,
      );
    }
    return;
  }
  assertExecutionSessionCurrent(context, session);
  mkdirSync(dir, { recursive: true });
  fsyncDirectory(dirname(dir));
}

/* ------------------------------------------------------------------------ *
 * Append (§5)
 * ------------------------------------------------------------------------ */

/** Validate one incoming record and its provenance against the bound session. */
function assertNoteScope(session: ExecutionSessionRef, note: WorkflowNoteRequest): void {
  assertWorkflowId(session.workflowId, "execution session workflow id");
  const record = parseWorkflowNote(note.ts === undefined ? { ...note, ts: "pending" } : note);
  if (record === null) {
    throw new ExecutionLedgerError(
      "execution-ledgers.record-invalid",
      `a note is exactly {version:1,id,workflowId,sessionId,kind:"note",text} with an optional non-empty ts and string text.`,
    );
  }
  if (record.workflowId !== session.workflowId || record.sessionId !== session.sessionId) {
    throw new ExecutionLedgerError(
      "execution-ledgers.scope-mismatch",
      `the note records provenance ${JSON.stringify(record.workflowId)}/${JSON.stringify(record.sessionId)}, but the bound ` +
        `session is ${JSON.stringify(session.workflowId)}/${JSON.stringify(session.sessionId)}. Provenance is the bound ` +
        `session's own scope - it is never taken from the record; nothing was written.`,
    );
  }
}

/**
 * Append one note to the workflow's retained ledger.
 *
 * Active route only, and the whole path is: prove the control root exists →
 * resolve the retained workflow body dir (materialized only after the
 * current-session guard has authorized a genuinely absent one) → the SAME
 * synchronous current-session guard again, immediately before the byte
 * mutation → one fsynced `O_APPEND` frame. There is no file lock, no
 * maintenance exclusion, no read of retained bytes and no replay/conflict
 * decision: a stale epoch, a revoked/suspended session, a foreign caller or a
 * mismatched scope still refuses with the store's own codes (or this module's),
 * every retained byte stays in place, and a refused call leaves no directory
 * side effect behind. A repeated id appends a second record.
 */
export async function appendWorkflowNote(
  context: ExecutionContext,
  session: ExecutionSessionRef,
  note: WorkflowNoteRequest,
): Promise<WorkflowNoteAppendReceipt> {
  assertNoteScope(session, note);
  assertRealDirectory(controlRootOf(context), "the control root");
  const ledgerPath = workflowNotesLedgerPath(context, session.workflowId);
  prepareWorkflowBodyDir(context, session, dirname(ledgerPath));
  const frame = Buffer.from(`${canonicalNoteLine({ ...note, ts: note.ts ?? new Date().toISOString() })}\n`, "utf8");
  // The final synchronous identity check, immediately before the byte mutation.
  assertExecutionSessionCurrent(context, session);
  // An append that can reach the ceiling is a maintenance step: the frame and
  // the compaction it triggers are ONE critical section under the store's write
  // lock, so a peer can neither append between the size this compaction acts on
  // and its rename, nor compact from a stale size itself. An append far below
  // the ceiling triggers nothing and keeps today's single lock-free `O_APPEND`.
  if (ledgerAtOrOverCeiling(ledgerPath, frame.length)) {
    await withWorkflowNotesMaintenanceLock(context, () => {
      commitLedgerFrame(ledgerPath, frame);
      compactWorkflowNotesLedger(ledgerPath, session.workflowId);
    });
    return { id: note.id };
  }
  commitLedgerFrame(ledgerPath, frame);
  if (ledgerAtOrOverCeiling(ledgerPath, 0)) {
    // shortcut: a peer that measured the ledger below the ceiling before this
    // frame landed can leave it over the ceiling with that append uncompacted;
    // this recheck compacts it instead of waiting for the next append. The
    // compactor verifies its snapshot right before the rename and abandons the
    // rewrite when a frame lengthened the leaf, so the remaining window is the
    // stat→rename gap itself: a frame that lands exactly there is still lost,
    // and the ledger stays over its ceiling until the next over-ceiling append
    // retries. Upgrade to an unconditional maintenance lock if the ceiling must
    // hold at every instant, which costs a store write connection on every
    // ordinary append.
    await withWorkflowNotesMaintenanceLock(context, () => compactWorkflowNotesLedger(ledgerPath, session.workflowId));
  }
  return { id: note.id };
}

/* ------------------------------------------------------------------------ *
 * Coverage facts (C3 / C2 `notes-v1`)
 * ------------------------------------------------------------------------ */

/**
 * One retained historical line: its coverage identity is the retained file's
 * own byte hash plus the line index, and its line hash is over the exact line
 * bytes excluding the final LF.
 */
export type WorkflowNoteHistoricalRecord = Readonly<{
  identity: Readonly<{ sourceFileSha256: string; lineIndex: number }>;
  sha256: string;
  bytes: number;
  format: "legacy-note" | "unrecognized";
  record: Readonly<{ kind: string; ts: string; text: string }> | null;
}>;

/** One retained new-format record, in append order. */
export type WorkflowNoteRecord = Readonly<{
  id: string;
  lineIndex: number;
  sha256: string;
  bytes: number;
  record: WorkflowNote;
}>;

/**
 * The composition of a retained notes surface. `absent` (no file) and `empty`
 * (a present, zero-byte file) are distinct because they are different facts for
 * coverage: a first note against either is an ordinary append, but only the
 * absent one has no retained bytes to witness.
 */
export type WorkflowNotesFormat = "absent" | "empty" | "legacy" | "versioned" | "unrecognized" | "mixed";

/**
 * The normalized, inspectable facts of one retained notes surface: the physical
 * records a reader can see, never a claim about which ids were transactionally
 * accepted (the log makes no such promise, so a repeated id is simply a second
 * record).
 */
export type WorkflowNotesCoverageFacts = Readonly<{
  version: 1;
  protocol: "notes-v1";
  workflowId: string;
  path: string;
  format: WorkflowNotesFormat;
  bytes: number;
  fileSha256: string | null;
  historical: readonly WorkflowNoteHistoricalRecord[];
  records: readonly WorkflowNoteRecord[];
  counts: Readonly<{ historical: number; records: number; unrecognized: number }>;
  /** Bytes after the last LF — a partial record a reader must skip. */
  tail: Readonly<{ sha256: string; bytes: number }> | null;
  /**
   * The byte window this projection saw. When `truncated` is set, every hash,
   * line index and count above describes that window, never the whole file.
   */
  readWindow: WorkflowNotesReadWindow;
  /** The disclosure the ledger's last compaction wrote, or `null` if nothing was dropped. */
  compaction: WorkflowNotesCompactionMarker | null;
}>;

/**
 * Pure projection of one retained notes ledger's bytes into coverage facts.
 * Input bytes are the caller's own fresh read (the caller owns safe IO and the
 * existence/symlink/root checks); this function hashes and classifies them and
 * writes nothing. An unrecognized line or a partial tail is reported rather than
 * hidden, so a validator can refuse instead of reading corruption as absence.
 */
export function normalizeWorkflowNotesCoverage(input: {
  workflowId: string;
  path: string;
  bytes: Uint8Array | null;
  /**
   * The window these bytes were read from. Absent means the caller handed over
   * the whole file, which is what an in-memory projection of known bytes is.
   */
  readWindow?: WorkflowNotesReadWindow;
}): WorkflowNotesCoverageFacts {
  if (input.bytes === null) {
    return {
      version: 1,
      protocol: "notes-v1",
      workflowId: input.workflowId,
      path: input.path,
      format: "absent",
      bytes: 0,
      fileSha256: null,
      historical: [],
      records: [],
      counts: { historical: 0, records: 0, unrecognized: 0 },
      tail: null,
      readWindow: input.readWindow ?? { offset: 0, totalBytes: 0, truncated: false },
      compaction: null,
    };
  }
  const buffer = Buffer.isBuffer(input.bytes)
    ? input.bytes
    : Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  const scan = scanLedger(buffer);
  const fileSha256 = sha256Bytes(buffer);
  const historical: WorkflowNoteHistoricalRecord[] = [];
  const records: WorkflowNoteRecord[] = [];
  let legacy = 0;
  let versioned = 0;
  let unrecognized = 0;
  let compaction: WorkflowNotesCompactionMarker | null = null;
  for (const entry of scan.lines) {
    const digest = sha256Bytes(entry.bytes);
    if (entry.line.format === "compaction-marker") {
      // The last disclosure a reader can see wins: a later compaction replaced
      // its predecessor, and its facts describe only the prefix it removed.
      compaction = entry.line.marker;
      continue;
    }
    if (entry.line.format === "legacy-note") {
      legacy += 1;
      historical.push({
        identity: { sourceFileSha256: fileSha256, lineIndex: entry.index },
        sha256: digest,
        bytes: entry.bytes.length,
        format: "legacy-note",
        record: entry.line.record,
      });
      continue;
    }
    if (entry.line.format === "unrecognized") {
      unrecognized += 1;
      historical.push({
        identity: { sourceFileSha256: fileSha256, lineIndex: entry.index },
        sha256: digest,
        bytes: entry.bytes.length,
        format: "unrecognized",
        record: null,
      });
      continue;
    }
    if (entry.line.format === "blank") {
      // The writer's own framing byte: a reader skips it, never counts it.
      continue;
    }
    versioned += 1;
    records.push({
      id: entry.line.record.id,
      lineIndex: entry.index,
      sha256: digest,
      bytes: entry.bytes.length,
      record: entry.line.record,
    });
  }
  let format: WorkflowNotesFormat;
  if (legacy === 0 && versioned === 0 && unrecognized === 0) format = "empty";
  else if (versioned === 0 && unrecognized === 0) format = "legacy";
  else if (legacy === 0 && unrecognized === 0) format = "versioned";
  else if (legacy === 0 && versioned === 0) format = "unrecognized";
  else format = "mixed";
  return {
    version: 1,
    protocol: "notes-v1",
    workflowId: input.workflowId,
    path: input.path,
    format,
    bytes: buffer.length,
    fileSha256,
    historical,
    records,
    counts: { historical: historical.length, records: records.length, unrecognized },
    tail: scan.tail.length === 0 ? null : { sha256: sha256Bytes(scan.tail), bytes: scan.tail.length },
    readWindow: input.readWindow ?? { offset: 0, totalBytes: buffer.length, truncated: false },
    compaction,
  };
}
