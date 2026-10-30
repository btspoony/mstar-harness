/**
 * execution-ledgers.test.ts (command family) — the bounded coverage READ of the
 * retained workflow-notes ledger.
 *
 * `workflow-note.coverage` never loads the whole ledger: it reads at most the
 * engine's exported read window from the tail, drops the first partial line the
 * window starts in, and discloses the window it actually saw. These cases drive
 * that descriptor directly, so the bound and its disclosure are asserted on real
 * bytes rather than inferred from a projected fact.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_NOTES_LEDGER_READ_BYTES } from "@mstar-harness/engine";
import { readLedgerBytes } from "./execution-ledgers.js";
import { normalizeWorkflowNotesCoverage } from "@mstar-harness/engine";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchFile(name: string, bytes: Buffer | string): string {
  const root = mkdtempSync(join(tmpdir(), "execution-ledgers-read-window-"));
  roots.push(root);
  const file = join(root, name);
  writeFileSync(file, bytes);
  return file;
}

/** One retained record line of the module's own format. */
function noteLine(index: number, text: string): string {
  return `${JSON.stringify({
    version: 1,
    id: `note-${index}`,
    workflowId: "wf-notes-window",
    sessionId: "coordinator-notes",
    kind: "note",
    ts: "2026-10-08T00:00:00.000Z",
    text,
  })}\n`;
}

/** One record line padded to an exact byte length (LF included). */
function exactLengthNoteLine(index: number, bytes: number): string {
  const line = noteLine(index, "");
  return noteLine(index, "y".repeat(bytes - Buffer.byteLength(line)));
}

/** The disclosure row a compaction leaves as the ledger's final line. */
function markerLine(droppedBytes: number, droppedLines: number, digest: string): string {
  return `${JSON.stringify({
    version: 1,
    kind: "workflow-notes-compaction",
    ts: "2026-10-08T00:00:00.000Z",
    workflowId: "wf-notes-window",
    dropped: { bytes: droppedBytes, lines: droppedLines, records: droppedLines, historical: 0, unrecognized: 0 },
    prefixSha256: digest,
  })}\n`;
}

describe("execution-ledgers (command family): the coverage read window", () => {
  test("reads at most the exported read window from the tail and discloses the truncation", () => {
    // A ledger three read windows long, so the tail window genuinely starts
    // inside the file rather than at its first byte.
    const line = noteLine(0, "y".repeat(1024));
    const ledger = line.repeat(Math.ceil((WORKFLOW_NOTES_LEDGER_READ_BYTES * 3) / Buffer.byteLength(line)));
    const file = scratchFile("oversize.jsonl", ledger);

    const read = readLedgerBytes(file);
    expect(read.bytes).not.toBeNull();
    const readBytes = read.bytes!;
    expect(readBytes.length).toBeLessThanOrEqual(WORKFLOW_NOTES_LEDGER_READ_BYTES);
    expect(read.readWindow).toMatchObject({
      totalBytes: Buffer.byteLength(ledger),
      truncated: true,
    });
    expect(read.readWindow.offset).toBeGreaterThan(0);
    // The disclosed window starts on a whole record, never on a partial line,
    // and its offset names the first byte it actually returned.
    expect(Buffer.from(readBytes).toString("utf8").startsWith('{"version":1,"id":"note-0"')).toBe(true);
    expect(read.readWindow.offset + readBytes.length).toBe(read.readWindow.totalBytes);

    const facts = normalizeWorkflowNotesCoverage({
      workflowId: "wf-notes-window",
      path: file,
      bytes: readBytes,
      readWindow: read.readWindow,
    });
    expect(facts.readWindow).toEqual(read.readWindow);
    expect(facts.bytes).toBe(readBytes.length);
    // Every line of the window is a whole record: the truncation cost the head,
    // never a record boundary.
    expect(facts.counts.unrecognized).toBe(0);
    expect(facts.tail).toBeNull();
  });

  test("a ledger inside the read window is disclosed untruncated from offset zero", () => {
    const ledger = noteLine(0, "small") + noteLine(1, "also small");
    const file = scratchFile("small.jsonl", ledger);
    const read = readLedgerBytes(file);
    expect(read.readWindow).toEqual({ offset: 0, totalBytes: Buffer.byteLength(ledger), truncated: false });
    expect(Buffer.from(read.bytes!).toString("utf8")).toBe(ledger);
  });

  test("an absent ledger reads as no bytes with an empty window", () => {
    const root = mkdtempSync(join(tmpdir(), "execution-ledgers-read-window-"));
    roots.push(root);
    expect(readLedgerBytes(join(root, "missing.jsonl"))).toEqual({
      bytes: null,
      readWindow: { offset: 0, totalBytes: 0, truncated: false },
    });
  });

  test("a compacted ledger's tail window still reports the marker and the dropped facts", () => {
    const retained = noteLine(0, "z".repeat(2048));
    const digest = "a".repeat(64);
    const marker = markerLine(8192, 4, digest);
    const ledger = `${retained}\n${marker}`;
    const file = scratchFile("compacted.jsonl", ledger);

    const read = readLedgerBytes(file);
    const facts = normalizeWorkflowNotesCoverage({
      workflowId: "wf-notes-window",
      path: file,
      bytes: read.bytes!,
      readWindow: read.readWindow,
    });
    expect(facts.compaction).toMatchObject({
      kind: "workflow-notes-compaction",
      dropped: { bytes: 8192, lines: 4, records: 4, historical: 0, unrecognized: 0 },
      prefixSha256: digest,
    });
    // The disclosure row is never counted as content.
    expect(facts.counts).toEqual({ historical: 0, records: 1, unrecognized: 0 });
    expect(facts.readWindow.truncated).toBe(false);
  });

  test("a tail window that starts exactly on a record keeps that whole record", () => {
    // Every line is exactly one power-of-two length, so the read window (also a
    // power of two) starts precisely on a record boundary: the byte before the
    // window is the LF that ends the previous record.
    const lineBytes = 4096;
    const line = exactLengthNoteLine(0, lineBytes);
    const count = Math.ceil(WORKFLOW_NOTES_LEDGER_READ_BYTES / lineBytes) + 2;
    const ledger = line.repeat(count);
    const file = scratchFile("aligned.jsonl", ledger);
    const totalBytes = count * lineBytes;
    const windowOffset = totalBytes - WORKFLOW_NOTES_LEDGER_READ_BYTES;

    const read = readLedgerBytes(file);
    // Nothing was trimmed: the window already began on a record.
    expect(read.readWindow).toEqual({ offset: windowOffset, totalBytes, truncated: true });
    expect(read.bytes!.length).toBe(WORKFLOW_NOTES_LEDGER_READ_BYTES);
    expect(Buffer.from(read.bytes!).toString("utf8").startsWith('{"version":1,"id":"note-0"')).toBe(true);

    const facts = normalizeWorkflowNotesCoverage({
      workflowId: "wf-notes-window",
      path: file,
      bytes: read.bytes!,
      readWindow: read.readWindow,
    });
    // Every record inside the window is counted; the aligned start costs none.
    expect(facts.counts).toEqual({
      historical: 0,
      records: WORKFLOW_NOTES_LEDGER_READ_BYTES / lineBytes,
      unrecognized: 0,
    });
    expect(facts.tail).toBeNull();
  });

  test("a single record that exactly fills the window is not dropped", () => {
    // A whole-line filler, then one complete record of exactly the read window:
    // the window starts on that record and holds nothing else.
    const filler = exactLengthNoteLine(0, 1024).repeat(3);
    const only = exactLengthNoteLine(1, WORKFLOW_NOTES_LEDGER_READ_BYTES);
    const file = scratchFile("single-record-window.jsonl", filler + only);

    const read = readLedgerBytes(file);
    expect(read.readWindow).toEqual({
      offset: Buffer.byteLength(filler),
      totalBytes: Buffer.byteLength(filler) + WORKFLOW_NOTES_LEDGER_READ_BYTES,
      truncated: true,
    });
    const facts = normalizeWorkflowNotesCoverage({
      workflowId: "wf-notes-window",
      path: file,
      bytes: read.bytes!,
      readWindow: read.readWindow,
    });
    // The one record the window holds entirely survives in the counts.
    expect(facts.counts).toEqual({ historical: 0, records: 1, unrecognized: 0 });
    expect(facts.records.map((entry) => entry.id)).toEqual(["note-1"]);
  });
});
