import { afterAll, expect, spyOn, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore, openStore, storeDbPath, type StoreContext } from "./store-db.js";
import {
  advanceDshScanBound, appendDshLedgerRow, appendDshWorkflowEvent,
  readDshScanBound, recordDshStatusEmission, writeDshSessionBinding,
} from "./host-state-store.js";
import { importDshHostStateFiles } from "./host-state-import.js";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
async function fixture(name: string): Promise<{ context: StoreContext; workflow: string }> {
  const harnessDir = mkdtempSync(join(tmpdir(), `host-state-import-${name}-`));
  roots.push(harnessDir);
  const initialized = await initializeStore({ harnessDir });
  initialized.close();
  const workflow = join(harnessDir, "workflows", `wf-${name}`);
  mkdirSync(workflow, { recursive: true });
  return { context: { harnessDir }, workflow };
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("imports the full identity registry and ordered duplicate tail rows with byte-preserving provenance retry", async () => {
  const { context, workflow } = await fixture("duplicates");
  const tail = '{"eventId":"wfc1:s:c:tool","n":1}\n{"eventId":"wfc1:s:c:tool","n":1}\n';
  const ids = '{"id":"wfe1:dispatch:stream:1","d":"digest-a"}\n{"id":"wfe1:dispatch:stream:0","d":"compacted"}\n';
  writeFileSync(join(workflow, "agent-flow.jsonl"), tail);
  writeFileSync(join(workflow, "agent-flow-ids.jsonl"), ids);
  const result = await importDshHostStateFiles({ context, operator: "fixture", operationId: "first" });
  expect(result.imported.identities).toBe(2);
  expect(result.imported.ledgerRows).toBe(2);
  expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(readFileSync(join(workflow, "agent-flow.jsonl"), "utf8")).toBe(tail);
  expect(readFileSync(join(workflow, "agent-flow-ids.jsonl"), "utf8")).toBe(ids);
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select event_json, legacy_source_digest, legacy_line from dsh_ledger_events where workflow_id = ? order by seq_rowid").all("wf-duplicates")).toEqual([
      { event_json: '{"eventId":"wfc1:s:c:tool","n":1}', legacy_source_digest: sha(tail), legacy_line: 1 },
      { event_json: '{"eventId":"wfc1:s:c:tool","n":1}', legacy_source_digest: sha(tail), legacy_line: 2 },
    ]);
    expect(store.db.prepare("select event_id, digest from dsh_accepted_identities where workflow_id = ? order by event_id").all("wf-duplicates")).toEqual([
      { event_id: "wfe1:dispatch:stream:0", digest: "compacted" },
      { event_id: "wfe1:dispatch:stream:1", digest: "digest-a" },
    ]);
  } finally { store.close(); }
  const replay = await importDshHostStateFiles({ context, operator: "fixture", operationId: "second" });
  expect(replay.imported.ledgerRows).toBe(0);
});

test("native equal-byte ledger evidence does not prove legacy tail import", async () => {
  const { context, workflow } = await fixture("native-order");
  const first = '{"n":1}';
  const second = '{"n":2}';
  writeFileSync(join(workflow, "agent-flow.jsonl"), `${first}\n${second}\n`);
  appendDshLedgerRow(context, "wf-native-order", second);
  appendDshLedgerRow(context, "wf-native-order", first);
  await expect(importDshHostStateFiles({ context, operator: "fixture", operationId: "refuse" }))
    .rejects.toMatchObject({ code: "store.upgrade-dsh-source-refused", message: expect.stringContaining("ordering-unsafe") });
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select event_json, legacy_source_digest from dsh_ledger_events where workflow_id = ? order by seq_rowid").all("wf-native-order")).toEqual([
      { event_json: second, legacy_source_digest: null },
      { event_json: first, legacy_source_digest: null },
    ]);
  } finally { store.close(); }
});

test("a malformed identity index refuses by default and acknowledges only the refused source", async () => {
  const { context, workflow } = await fixture("ack");
  const bytes = '{"id":"ok","d":"x"}\nnot-json\n';
  writeFileSync(join(workflow, "agent-flow-ids.jsonl"), bytes);
  writeFileSync(join(workflow, "workflow-ledger-cursors.json"), JSON.stringify({ v: 1, cursors: { session: 5 } }));
  await expect(importDshHostStateFiles({ context, operator: "fixture", operationId: "no-ack" }))
    .rejects.toMatchObject({ code: "store.upgrade-dsh-source-refused" });
  const result = await importDshHostStateFiles({ context, operator: "fixture", operationId: "acked", acknowledgedSkips: ["dsh-ledger:wf-ack"] });
  expect(result.verdict).toBe("partially-imported");
  expect(result.imported.scanBounds).toBe(1);
  expect(result.findings.some((finding) => finding.kind === "dropped-by-ack")).toBe(true);
  expect(readFileSync(join(workflow, "agent-flow-ids.jsonl"), "utf8")).toBe(bytes);
});
test("retained identified history requires complete registry coverage and journal-before tails remain importable", async () => {
  const { context, workflow } = await fixture("history");
  const historyDir = join(workflow, "agent-flow-history");
  mkdirSync(historyDir, { recursive: true });
  const archived = '{"eventId":"wfe1:session:event","payload":{"value":1}}';
  writeFileSync(join(historyDir, "chunk-000001.jsonl"), `${archived}\n`);
  const tail = '{"eventId":"wfc1:session:tool","payload":{"value":2}}\n';
  writeFileSync(join(workflow, "agent-flow.jsonl"), tail);
  writeFileSync(join(workflow, "agent-flow-compaction.json"), JSON.stringify({
    version: 1,
    lines: 1,
    tailBefore: { bytes: Buffer.byteLength(tail), sha256: sha(tail) },
    tailAfter: { bytes: 0, sha256: sha("") },
    archive: { chunk: "chunk-000001.jsonl", offset: 0, bytes: Buffer.byteLength(`${archived}\n`), sha256: sha(`${archived}\n`) },
  }));
  await expect(importDshHostStateFiles({ context, operator: "fixture", operationId: "missing-history-index" }))
    .rejects.toMatchObject({ code: "store.upgrade-dsh-source-refused", message: expect.stringContaining("identity index is absent") });
  writeFileSync(join(workflow, "agent-flow-ids.jsonl"), `${JSON.stringify({ id: "wfe1:session:event", d: sha(archived).slice(0, 32) })}\n`);
  const result = await importDshHostStateFiles({ context, operator: "fixture", operationId: "covered-history-index" });
  expect(result.imported.identities).toBe(1);
  expect(result.imported.ledgerRows).toBe(1);
  expect(result.findings).toContainEqual(expect.objectContaining({ kind: "journal", decision: "before" }));
});

test("status import preserves session bounds and only the newest emission; scan cursors stay per-session", async () => {
  const { context, workflow } = await fixture("status");
  writeFileSync(join(workflow, "workflow-ledger-cursors.json"), JSON.stringify({ v: 2, cursors: {
    "session-a": { next: 8, stream: "stream-a" },
    "session-b": { next: 3 },
  } }));
  const snapshotPath = join(context.harnessDir, "snapshots", "engine-status.json");
  mkdirSync(join(context.harnessDir, "snapshots"), { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify({
    sv: 1,
    entries: {
      "session-a": [
        { rv: 1, cwd: "/repo", at: "2026-01-01T00:00:00.000Z", turn: 1, payload: { value: "old" } },
        { rv: 1, cwd: "/repo", at: "2026-01-02T00:00:00.000Z", turn: 2, payload: { value: "new" } },
      ],
    },
    bindings: {
      "session-a": { cwd: "/repo", selectedWorkflowId: "wf-status", executionBinding: null, excludedBeforeSeq: 12 },
    },
  }));
  const result = await importDshHostStateFiles({ context, operator: "fixture", operationId: "status" });
  expect(result.imported.scanBounds).toBe(2);
  expect(result.imported.bindings).toBe(1);
  expect(result.imported.emissions).toBe(1);
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select session_id,next,stream from dsh_scan_bounds where workflow_id = ? order by session_id").all("wf-status")).toEqual([
      { session_id: "session-a", next: 8, stream: "stream-a" },
      { session_id: "session-b", next: 3, stream: null },
    ]);
    expect(store.db.prepare("select session_id,excluded_before_seq,selected_workflow_id from dsh_session_bindings").all()).toEqual([
      { session_id: "session-a", excluded_before_seq: 12, selected_workflow_id: "wf-status" },
    ]);
    expect(store.db.prepare("select turn,payload_json from dsh_status_emissions").all()).toEqual([
      { turn: 2, payload_json: '{"value":"new"}' },
    ]);
  } finally { store.close(); }
});

test("a landed journal imports the tail and keeps the journal bytes; an undecidable one refuses only the tail", async () => {
  const { context, workflow } = await fixture("journal");
  const historyDir = join(workflow, "agent-flow-history");
  mkdirSync(historyDir, { recursive: true });
  const archived = '{"eventId":"wfe1:session:old"}';
  writeFileSync(join(historyDir, "chunk-000001.jsonl"), `${archived}\n`);
  const tail = '{"eventId":"wfc1:session:new"}\n';
  const journalPath = join(workflow, "agent-flow-compaction.json");
  writeFileSync(join(workflow, "agent-flow.jsonl"), tail);
  writeFileSync(join(workflow, "agent-flow-ids.jsonl"), `${JSON.stringify({ id: "wfe1:session:old", d: sha(archived).slice(0, 32) })}\n`);
  // A real journal: both fingerprints, a positive archive range, a line count, and a
  // strict removal (before.bytes > after.bytes); the observed tail equals tailAfter.
  const landedJournal = JSON.stringify({
    version: 1,
    lines: 1,
    tailBefore: { bytes: 64, sha256: sha("pre-compaction-tail") },
    tailAfter: { bytes: Buffer.byteLength(tail), sha256: sha(tail) },
    archive: { chunk: "chunk-000001.jsonl", offset: 0, bytes: Buffer.byteLength(`${archived}\n`), sha256: sha(`${archived}\n`) },
  });
  writeFileSync(journalPath, landedJournal);
  const landed = await importDshHostStateFiles({ context, operator: "fixture", operationId: "landed" });
  expect(landed.imported.ledgerRows).toBe(1);
  expect(landed.findings).toContainEqual(expect.objectContaining({ kind: "journal", decision: "landed" }));
  expect(readFileSync(journalPath, "utf8")).toBe(landedJournal);

  // Undecidable: valid journal shape whose tail matches neither fingerprint.
  writeFileSync(journalPath, JSON.stringify({
    version: 1,
    lines: 1,
    tailBefore: { bytes: 64, sha256: sha("x") },
    tailAfter: { bytes: 32, sha256: sha("y") },
    archive: { chunk: "chunk-000001.jsonl", offset: 0, bytes: 4, sha256: sha("z") },
  }));
  const undecidable = await importDshHostStateFiles({ context, operator: "fixture", operationId: "undecidable", acknowledgedSkips: ["dsh-ledger:wf-journal"] });
  expect(undecidable.findings).toContainEqual(
    expect.objectContaining({ kind: "dropped-by-ack", selector: "dsh-ledger:wf-journal", category: "tail" }),
  );
  const store = await openStore(context, "read");
  try {
    // The already-imported generation's rows stand; the undecidable retry wrote none.
    expect(store.db.prepare("select count(*) as n from dsh_ledger_events where workflow_id = ?").get("wf-journal")).toEqual({ n: 1 });
  } finally { store.close(); }
});

test("an identity digest conflict names the id while unconflicted identities and bounds still import", async () => {
  const { context, workflow } = await fixture("conflict");
  appendDshWorkflowEvent(context, {
    workflowId: "wf-conflict", eventId: "dup", digest: "native-digest", lineJson: '{"n":"native"}',
    source: { sessionId: "s", streamId: "stream", seq: 1 },
  });
  writeFileSync(join(workflow, "agent-flow-ids.jsonl"), '{"id":"dup","d":"legacy-digest"}\n{"id":"ev-other","d":"x"}\n');
  writeFileSync(join(workflow, "workflow-ledger-cursors.json"), JSON.stringify({ v: 1, cursors: { "session-a": 4 } }));
  await expect(importDshHostStateFiles({ context, operator: "fixture", operationId: "conflict" }))
    .rejects.toMatchObject({ code: "store.upgrade-dsh-source-refused", message: expect.stringContaining("dup") });
  const acked = await importDshHostStateFiles({ context, operator: "fixture", operationId: "conflict-ack", acknowledgedSkips: ["dsh-ledger:wf-conflict"] });
  expect(acked.imported.identities).toBe(1);
  expect(acked.imported.scanBounds).toBe(1);
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select event_id, digest from dsh_accepted_identities where workflow_id = ? order by event_id").all("wf-conflict")).toEqual([
      { event_id: "dup", digest: "native-digest" },
      { event_id: "ev-other", digest: "x" },
    ]);
  } finally { store.close(); }
  // After acknowledgement the native identity authority is unchanged: the same
  // native digest replay is still deduplicated, a different digest is still a conflict.
  expect(appendDshWorkflowEvent(context, {
    workflowId: "wf-conflict", eventId: "dup", digest: "native-digest", lineJson: '{"n":"replay"}',
    source: { sessionId: "s", streamId: "stream", seq: 2 },
  })).toMatchObject({ kind: "replayed" });
  expect(appendDshWorkflowEvent(context, {
    workflowId: "wf-conflict", eventId: "dup", digest: "another-digest", lineJson: '{"n":"other"}',
    source: { sessionId: "s", streamId: "stream", seq: 3 },
  })).toMatchObject({ kind: "refused" });
});

test("an empty readable tail after native activity imports zero rows and leaves native rows intact", async () => {
  const { context, workflow } = await fixture("empty-tail");
  appendDshLedgerRow(context, "wf-empty-tail", '{"n":"native"}');
  // A readable, genuinely empty tail (zero physical rows) is a legitimate no-op,
  // not an ordering conflict and not an already-present verdict.
  writeFileSync(join(workflow, "agent-flow.jsonl"), "");
  writeFileSync(join(workflow, "agent-flow-ids.jsonl"), '{"id":"ev","d":"d"}\n');
  const result = await importDshHostStateFiles({ context, operator: "fixture", operationId: "empty-tail" });
  expect(result.imported.ledgerRows).toBe(0);
  expect(result.imported.identities).toBe(1);
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select event_json, legacy_source_digest from dsh_ledger_events where workflow_id = ?").all("wf-empty-tail")).toEqual([
      { event_json: '{"n":"native"}', legacy_source_digest: null },
    ]);
  } finally { store.close(); }
});

test("an unreadable tail or a journal without a tail refuses by default and recovers with a scoped acknowledgement", async () => {
  // Unreadable FLOW: a symlinked tail is not a readable regular file.
  const a = await fixture("unreadable-tail");
  writeFileSync(join(a.context.harnessDir, "elsewhere.jsonl"), "{}\n");
  symlinkSync(join(a.context.harnessDir, "elsewhere.jsonl"), join(a.workflow, "agent-flow.jsonl"));
  writeFileSync(join(a.workflow, "agent-flow-ids.jsonl"), '{"id":"ev","d":"d"}\n');
  await expect(importDshHostStateFiles({ context: a.context, operator: "fixture", operationId: "unreadable-tail" }))
    .rejects.toMatchObject({ code: "store.upgrade-dsh-source-refused", message: expect.stringContaining("tail") });
  const recovered = await importDshHostStateFiles({
    context: a.context, operator: "fixture", operationId: "unreadable-tail-ack", acknowledgedSkips: ["dsh-ledger:wf-unreadable-tail"],
  });
  expect(recovered.imported.ledgerRows).toBe(0);
  expect(recovered.imported.identities).toBe(1);

  // A journal present with no tail file at all: the tail fact is undecidable, not absent.
  const b = await fixture("journal-without-tail");
  writeFileSync(join(b.workflow, "agent-flow-compaction.json"), JSON.stringify({
    version: 1, lines: 1,
    tailBefore: { bytes: 64, sha256: sha("x") }, tailAfter: { bytes: 32, sha256: sha("y") },
    archive: { chunk: "chunk-000001.jsonl", offset: 0, bytes: 4, sha256: sha("z") },
  }));
  await expect(importDshHostStateFiles({ context: b.context, operator: "fixture", operationId: "journal-without-tail" }))
    .rejects.toMatchObject({ code: "store.upgrade-dsh-source-refused", message: expect.stringContaining("journal exists without a readable display tail") });
});

test("a present null bindings map refuses the whole status envelope and recovers by acknowledgement", async () => {
  const { context } = await fixture("null-bindings");
  const snapshotPath = join(context.harnessDir, "snapshots", "engine-status.json");
  mkdirSync(join(context.harnessDir, "snapshots"), { recursive: true });
  const bytes = JSON.stringify({
    sv: 1,
    entries: { "session-a": [{ rv: 1, cwd: "/repo", at: "2026-01-01T00:00:00.000Z", turn: 1, payload: { value: 1 } }] },
    bindings: null,
  });
  writeFileSync(snapshotPath, bytes);
  await expect(importDshHostStateFiles({ context, operator: "fixture", operationId: "null-bindings" }))
    .rejects.toMatchObject({ code: "store.upgrade-dsh-source-refused", message: expect.stringContaining("dsh-status") });
  const acked = await importDshHostStateFiles({ context, operator: "fixture", operationId: "null-bindings-ack", acknowledgedSkips: ["dsh-status"] });
  expect(acked.imported.bindings).toBe(0);
  expect(acked.imported.emissions).toBe(0);
  expect(readFileSync(snapshotPath, "utf8")).toBe(bytes);
});

test("native activity merges per fact: bounds advance forward only and exclusion floors raise by max", async () => {
  const { context, workflow } = await fixture("merge");
  advanceDshScanBound(context, "wf-merge", "session-a", 3, "stream-a");
  advanceDshScanBound(context, "wf-merge", "session-b", 20, "stream-native");
  writeDshSessionBinding(context, "session-a", "/repo", { selectedWorkflowId: "wf-native", excludedBeforeSeq: 5 });
  recordDshStatusEmission(context, "session-a", "/repo", 7, '{"native":true}');
  writeFileSync(join(workflow, "workflow-ledger-cursors.json"), JSON.stringify({ v: 2, cursors: {
    "session-a": { next: 9, stream: "stream-a" },
    "session-b": { next: 9, stream: "stream-a" },
    "session-c": { next: 6, stream: "stream-a" },
  } }));
  const snapshotPath = join(context.harnessDir, "snapshots", "engine-status.json");
  mkdirSync(join(context.harnessDir, "snapshots"), { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify({
    sv: 1,
    entries: { "session-a": [{ rv: 1, cwd: "/repo", at: "2026-01-03T00:00:00.000Z", turn: 99, payload: { legacy: true } }] },
    bindings: { "session-a": { cwd: "/repo", selectedWorkflowId: "wf-legacy", excludedBeforeSeq: 12 } },
  }));
  const result = await importDshHostStateFiles({ context, operator: "fixture", operationId: "merge" });
  expect(result.merged).toEqual({ scanBoundsAdvanced: 1, bindingFloorsRaised: 1 });
  expect(result.imported.scanBounds).toBe(2);
  const store = await openStore(context, "read");
  try {
    // session-a advances forward on the same incarnation (3 -> 9); session-b's different incarnation stands; session-c imports.
    expect(store.db.prepare("select session_id, next, stream from dsh_scan_bounds where workflow_id = ? order by session_id").all("wf-merge")).toEqual([
      { session_id: "session-a", next: 9, stream: "stream-a" },
      { session_id: "session-b", next: 20, stream: "stream-native" },
      { session_id: "session-c", next: 6, stream: "stream-a" },
    ]);
    expect(store.db.prepare("select selected_workflow_id, execution_binding, excluded_before_seq from dsh_session_bindings").all()).toEqual([
      { selected_workflow_id: "wf-native", execution_binding: null, excluded_before_seq: 12 },
    ]);
    expect(store.db.prepare("select turn, payload_json from dsh_status_emissions").all()).toEqual([
      { turn: 7, payload_json: '{"native":true}' },
    ]);
  } finally { store.close(); }
  expect(readDshScanBound(context, "wf-merge", "session-a")).toEqual({ next: 9, stream: "stream-a" });
});

test("a mid-import failure rolls the whole DSH phase back and leaves the revision unchanged", async () => {
  const { context, workflow } = await fixture("rollback");
  writeFileSync(join(workflow, "agent-flow.jsonl"), '{"eventId":"wfc1:s:c:tool"}\n');
  writeFileSync(join(workflow, "agent-flow-ids.jsonl"), '{"id":"wfe1:dispatch:stream:1","d":"digest-a"}\n');
  const snapshotPath = join(context.harnessDir, "snapshots", "engine-status.json");
  mkdirSync(join(context.harnessDir, "snapshots"), { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify({
    sv: 1,
    entries: { "session-a": [{ rv: 1, cwd: "/repo", at: "2026-01-01T00:00:00.000Z", turn: 1, payload: { value: 1 } }] },
    bindings: {},
  }));
  const handle = await openStore(context, "write");
  try {
    const revision = (handle.db.prepare("select revision from store_meta where id=1").get() as { revision: number }).revision;
    handle.db.exec("create trigger fail_dsh_emission before insert on dsh_status_emissions begin select raise(abort, 'forced emission failure'); end");
  } finally { handle.close(); }
  await expect(importDshHostStateFiles({ context, operator: "fixture", operationId: "rollback" })).rejects.toThrow();
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select count(*) as n from dsh_accepted_identities").get()).toEqual({ n: 0 });
    expect(store.db.prepare("select count(*) as n from dsh_ledger_events").get()).toEqual({ n: 0 });
    expect(store.db.prepare("select count(*) as n from dsh_status_emissions").get()).toEqual({ n: 0 });
    expect(store.db.prepare("select revision from store_meta where id=1").get()).toEqual({ revision: 0 });
  } finally { store.close(); }
});

test("the actual importer rejects a store epoch change that lands before the owned transaction", async () => {
  const { context, workflow } = await fixture("race");
  writeFileSync(join(workflow, "agent-flow-ids.jsonl"), '{"id":"ev","d":"d"}\n');
  const dbPath = storeDbPath(context);
  // A competing connection advancing the epoch while the importer holds its own
  // write transaction would sit behind the write lock, so the epoch is advanced
  // immediately BEFORE the importer's owned transaction begins: the open handle
  // then reads a generation that no longer matches the captured selection.
  const bump = new DatabaseSync(dbPath);
  const original = DatabaseSync.prototype.exec;
  let bumped = false;
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: unknown) {
    if (!bumped && typeof sql === "string" && sql.trim().toLowerCase() === "begin immediate") {
      bumped = true;
      bump.exec("update store_meta set authority_epoch = authority_epoch + 1 where id = 1");
    }
    return original.call(this, sql as never);
  };
  try {
    await expect(importDshHostStateFiles({ context, operator: "fixture", operationId: "race" }))
      .rejects.toMatchObject({ code: "store.stale-epoch" });
  } finally {
    DatabaseSync.prototype.exec = original;
    bump.close();
  }
  expect(bumped).toBe(true);
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select count(*) as n from dsh_accepted_identities").get()).toEqual({ n: 0 });
    expect(store.db.prepare("select count(*) as n from store_operations where operation_id like 'race%'").get()).toEqual({ n: 0 });
    expect(store.db.prepare("select revision from store_meta where id=1").get()).toEqual({ revision: 0 });
  } finally { store.close(); }
});

test("a repeated invocation with the same operation id returns the stored report with no new writes", async () => {
  const { context, workflow } = await fixture("receipt");
  writeFileSync(join(workflow, "agent-flow.jsonl"), '{"eventId":"wfc1:s:c:tool"}\n');
  writeFileSync(join(workflow, "agent-flow-ids.jsonl"), '{"id":"ev","d":"d"}\n');
  const first = await importDshHostStateFiles({ context, operator: "fixture", operationId: "same-id" });
  expect(first.imported.ledgerRows).toBe(1);
  const replay = await importDshHostStateFiles({ context, operator: "fixture", operationId: "same-id" });
  expect(replay).toEqual(first);
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select count(*) as n from dsh_ledger_events").get()).toEqual({ n: 1 });
    expect(store.db.prepare("select count(*) as n from store_operations where operation_id = 'same-id#dsh-host-state'").get()).toEqual({ n: 1 });
    expect(store.db.prepare("select revision from store_meta where id=1").get()).toEqual({ revision: 1 });
  } finally { store.close(); }
});

test("a partial legacy provenance set for the same digest is not treated as complete", async () => {
  const { context, workflow } = await fixture("partial-provenance");
  const tail = '{"n":1}\n{"n":2}\n';
  writeFileSync(join(workflow, "agent-flow.jsonl"), tail);
  const digest = sha(tail);
  const handle = await openStore(context, "write");
  try {
    // A prior interrupted import left only line 1 for this digest: the origin set
    // is incomplete, so a retry must not report the tail already-present.
    handle.db.prepare("insert into dsh_ledger_events(workflow_id,event_id,event_json,recorded_at,legacy_source_digest,legacy_line) values(?,?,?,?,?,?)")
      .run("wf-partial-provenance", null, '{"n":1}', "2026-01-01T00:00:00.000Z", digest, 1);
  } finally { handle.close(); }
  await expect(importDshHostStateFiles({ context, operator: "fixture", operationId: "partial" }))
    .rejects.toMatchObject({ code: "store.upgrade-dsh-source-refused", message: expect.stringContaining("ordering-unsafe") });
});

test("an acknowledgement matching no refused fact is a usage failure on a clean workspace", async () => {
  const { context, workflow } = await fixture("clean-ack");
  writeFileSync(join(workflow, "agent-flow-ids.jsonl"), '{"id":"ev","d":"d"}\n');
  await expect(importDshHostStateFiles({ context, operator: "fixture", operationId: "clean", acknowledgedSkips: ["dsh-ledger:wf-clean-ack"] }))
    .rejects.toMatchObject({ code: "store.upgrade-dsh-ack-unmatched", message: expect.stringContaining("matched no refused facts") });
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select count(*) as n from dsh_accepted_identities").get()).toEqual({ n: 0 });
  } finally { store.close(); }
});

test("a partially malformed unit publishes nothing: an acknowledged bounds or status drop leaves zero rows", async () => {
  const { context, workflow } = await fixture("unit");
  // First cursor entry valid, second invalid: the whole sidecar is one unit.
  writeFileSync(join(workflow, "workflow-ledger-cursors.json"), JSON.stringify({ v: 2, cursors: {
    "session-a": { next: 5, stream: "stream-a" },
    "session-b": { next: 0 },
  } }));
  // First binding valid, then an emission bucket with an invalid entry: the
  // envelope is one unit, so neither bindings nor emissions publish.
  const snapshotPath = join(context.harnessDir, "snapshots", "engine-status.json");
  mkdirSync(join(context.harnessDir, "snapshots"), { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify({
    sv: 1,
    entries: { "session-a": [{ rv: 1, cwd: "/repo", at: "2026-01-01T00:00:00.000Z", turn: 1, payload: { value: 1 } }], "bad": [{ rv: 2 }] },
    bindings: { "session-a": { cwd: "/repo", selectedWorkflowId: "wf-unit", executionBinding: null, excludedBeforeSeq: 3 } },
  }));
  const result = await importDshHostStateFiles({
    context, operator: "fixture", operationId: "unit",
    acknowledgedSkips: ["dsh-bounds:wf-unit", "dsh-status"],
  });
  expect(result.imported.scanBounds).toBe(0);
  expect(result.imported.bindings).toBe(0);
  expect(result.imported.emissions).toBe(0);
  expect(result.findings.filter((finding) => finding.kind === "dropped-by-ack")).toHaveLength(2);
  for (const finding of result.findings.filter((entry) => entry.kind === "dropped-by-ack")) {
    expect(finding.category).toMatch(/^(bounds|status)$/);
    expect(String(finding.loss)).toContain("Loss:");
  }
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select count(*) as n from dsh_scan_bounds").get()).toEqual({ n: 0 });
    expect(store.db.prepare("select count(*) as n from dsh_session_bindings").get()).toEqual({ n: 0 });
    expect(store.db.prepare("select count(*) as n from dsh_status_emissions").get()).toEqual({ n: 0 });
  } finally { store.close(); }
});

test("an unreadable journal withholds the tail instead of importing it", async () => {
  const { context, workflow } = await fixture("unreadable-journal");
  writeFileSync(join(workflow, "agent-flow.jsonl"), '{"eventId":"wfc1:s:c:tool"}\n');
  writeFileSync(join(workflow, "agent-flow-ids.jsonl"), '{"id":"ev","d":"d"}\n');
  // A symlinked journal is not a readable regular file: the tail disposition is unresolved.
  writeFileSync(join(context.harnessDir, "elsewhere.json"), "{}");
  symlinkSync(join(context.harnessDir, "elsewhere.json"), join(workflow, "agent-flow-compaction.json"));
  await expect(importDshHostStateFiles({ context, operator: "fixture", operationId: "unreadable-journal" }))
    .rejects.toMatchObject({ code: "store.upgrade-dsh-source-refused", message: expect.stringContaining("compaction journal") });
  const acked = await importDshHostStateFiles({ context, operator: "fixture", operationId: "unreadable-journal-ack", acknowledgedSkips: ["dsh-ledger:wf-unreadable-journal"] });
  expect(acked.imported.ledgerRows).toBe(0);
  expect(acked.imported.identities).toBe(1);
});

test("a symlinked history ancestor never contributes a landed-journal proof", async () => {
  const { context, workflow } = await fixture("unsafe-history");
  const realHistory = join(context.harnessDir, "real-history");
  mkdirSync(realHistory, { recursive: true });
  const archived = '{"eventId":"wfe1:session:old"}';
  writeFileSync(join(realHistory, "chunk-000001.jsonl"), `${archived}\n`);
  symlinkSync(realHistory, join(workflow, "agent-flow-history"));
  const tail = '{"eventId":"wfc1:session:new"}\n';
  writeFileSync(join(workflow, "agent-flow.jsonl"), tail);
  writeFileSync(join(workflow, "agent-flow-compaction.json"), JSON.stringify({
    version: 1,
    lines: 1,
    tailBefore: { bytes: 64, sha256: sha("pre-compaction-tail") },
    tailAfter: { bytes: Buffer.byteLength(tail), sha256: sha(tail) },
    archive: { chunk: "chunk-000001.jsonl", offset: 0, bytes: Buffer.byteLength(`${archived}\n`), sha256: sha(`${archived}\n`) },
  }));
  const acked = await importDshHostStateFiles({
    context, operator: "fixture", operationId: "unsafe-history",
    acknowledgedSkips: ["dsh-ledger:wf-unsafe-history"],
  });
  // The tail is withheld: the unsafe ancestry means the archive range is not proof.
  expect(acked.imported.ledgerRows).toBe(0);
  expect(acked.findings).toContainEqual(expect.objectContaining({ kind: "dropped-by-ack", category: "tail" }));
});

test("a symlinked workflow directory refuses by default and imports only after the source-scoped acknowledgement", async () => {
  const { context } = await fixture("symlinked-dir");
  const real = join(context.harnessDir, "elsewhere-dir");
  mkdirSync(real, { recursive: true });
  const ids = '{"id":"wfe1:session:event","d":"digest"}\n';
  const tail = '{"eventId":"wfc1:session:tool"}\n';
  writeFileSync(join(real, "agent-flow-ids.jsonl"), ids);
  writeFileSync(join(real, "agent-flow.jsonl"), tail);
  symlinkSync(real, join(context.harnessDir, "workflows", "wf-link-dir"));

  await expect(importDshHostStateFiles({ context, operator: "fixture", operationId: "symlinked-dir" }))
    .rejects.toMatchObject({ code: "store.upgrade-dsh-source-refused", message: expect.stringContaining("dsh-ledger:wf-link-dir") });
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select count(*) as n from dsh_accepted_identities").get()).toEqual({ n: 0 });
    expect(store.db.prepare("select count(*) as n from dsh_ledger_events").get()).toEqual({ n: 0 });
    expect(store.db.prepare("select count(*) as n from dsh_scan_bounds").get()).toEqual({ n: 0 });
  } finally { store.close(); }

  const acked = await importDshHostStateFiles({
    context, operator: "fixture", operationId: "symlinked-dir-ack", acknowledgedSkips: ["dsh-ledger:wf-link-dir"],
  });
  expect(acked.verdict).toBe("partially-imported");
  expect(acked.imported.identities).toBe(0);
  expect(acked.findings).toContainEqual(
    expect.objectContaining({ kind: "dropped-by-ack", selector: "dsh-ledger:wf-link-dir", category: "workflows" }),
  );
  // The link target's bytes were never read, rewritten or followed.
  expect(readFileSync(join(real, "agent-flow-ids.jsonl"), "utf8")).toBe(ids);
  expect(readFileSync(join(real, "agent-flow.jsonl"), "utf8")).toBe(tail);
});

test("a symlinked workflows root refuses the whole legacy tree and recovers through its own acknowledgement", async () => {
  const { context } = await fixture("symlinked-root");
  const realRoot = join(context.harnessDir, "elsewhere-tree");
  mkdirSync(join(realRoot, "wf-tree"), { recursive: true });
  writeFileSync(join(realRoot, "wf-tree", "agent-flow-ids.jsonl"), '{"id":"wfe1:x","d":"d"}\n');
  rmSync(join(context.harnessDir, "workflows"), { recursive: true, force: true });
  symlinkSync(realRoot, join(context.harnessDir, "workflows"));

  await expect(importDshHostStateFiles({ context, operator: "fixture", operationId: "symlinked-root" }))
    .rejects.toMatchObject({ code: "store.upgrade-dsh-source-refused", message: expect.stringContaining("dsh-workflows") });

  const acked = await importDshHostStateFiles({
    context, operator: "fixture", operationId: "symlinked-root-ack", acknowledgedSkips: ["dsh-workflows"],
  });
  expect(acked.verdict).toBe("partially-imported");
  expect(acked.imported.identities).toBe(0);
  expect(acked.findings).toContainEqual(
    expect.objectContaining({ kind: "dropped-by-ack", selector: "dsh-workflows", category: "workflows" }),
  );
});

test("a symlinked snapshots ancestor refuses the status source and a plain document directory stays a non-source", async () => {
  const { context } = await fixture("unsafe-status");
  mkdirSync(join(context.harnessDir, "workflows", "plain-docs"), { recursive: true });
  writeFileSync(join(context.harnessDir, "workflows", "plain-docs", "README.md"), "# unrelated\n");
  const realSnapshots = join(context.harnessDir, "real-snapshots");
  mkdirSync(realSnapshots, { recursive: true });
  writeFileSync(join(realSnapshots, "engine-status.json"), JSON.stringify({ sv: 1, entries: {}, bindings: {} }));
  symlinkSync(realSnapshots, join(context.harnessDir, "snapshots"));
  await expect(importDshHostStateFiles({ context, operator: "fixture", operationId: "unsafe-status" }))
    .rejects.toMatchObject({ code: "store.upgrade-dsh-source-refused", message: expect.stringContaining("dsh-status") });
  // The document-only workflow directory is not an authority and produced no refusal.
  const acked = await importDshHostStateFiles({ context, operator: "fixture", operationId: "unsafe-status-ack", acknowledgedSkips: ["dsh-status"] });
  expect(acked.verdict).toBe("partially-imported");
});

test("a legacy source leaf swapped for a symlink at the open boundary is never followed", async () => {
  const { context, workflow } = await fixture("leaf-swap");
  const idsPath = join(workflow, "agent-flow-ids.jsonl");
  writeFileSync(idsPath, '{"id":"wfe1:session:event","d":"digest"}\n');
  writeFileSync(join(workflow, "agent-flow.jsonl"), '{"eventId":"wfc1:session:tool"}\n');
  // The bytes a race winner would substitute: a complete, different registry.
  const outside = join(context.harnessDir, "outside-registry.jsonl");
  const outsideBytes = '{"id":"wfe1:outside:event","d":"outside-digest"}\n';
  writeFileSync(outside, outsideBytes);

  // Test-only race instrumentation: whichever leaf observation comes LAST
  // (the pre-fix `lstat`, or the no-follow `open`) swaps the leaf for a link
  // to the outside registry at that instant, then restores the platform calls.
  const realLstatSync = nodeFs.lstatSync;
  const realOpenSync = nodeFs.openSync;
  let swapped = false;
  const swapAt = (path: unknown): void => {
    if (swapped || typeof path !== "string" || path !== idsPath) return;
    swapped = true;
    rmSync(idsPath);
    symlinkSync(outside, idsPath);
  };
  const lstatSpy = spyOn(nodeFs, "lstatSync").mockImplementation(((path: string) => {
    swapAt(path);
    return realLstatSync(path);
  }) as never);
  const openSpy = spyOn(nodeFs, "openSync").mockImplementation(((path: string, flags: number) => {
    swapAt(path);
    return realOpenSync(path, flags);
  }) as never);
  try {
    await expect(importDshHostStateFiles({ context, operator: "fixture", operationId: "leaf-swap" }))
      .rejects.toMatchObject({ code: "store.upgrade-dsh-source-refused", message: expect.stringContaining("dsh-ledger:wf-leaf-swap") });
  } finally {
    lstatSpy.mockRestore();
    openSpy.mockRestore();
  }
  expect(swapped).toBe(true);
  // The link was never followed: recovery through the public acknowledgement
  // imports neither the outside registry nor the withheld tail.
  const acked = await importDshHostStateFiles({
    context, operator: "fixture", operationId: "leaf-swap-ack", acknowledgedSkips: ["dsh-ledger:wf-leaf-swap"],
  });
  expect(acked.imported.identities).toBe(0);
  expect(acked.imported.ledgerRows).toBe(0);
  const store = await openStore(context, "read");
  try {
    expect(store.db.prepare("select count(*) as n from dsh_accepted_identities").get()).toEqual({ n: 0 });
    expect(store.db.prepare("select count(*) as n from dsh_ledger_events where event_json like '%outside%'").get()).toEqual({ n: 0 });
  } finally { store.close(); }
  // Byte equality alone would prove nothing: the outside bytes were never consumed at all.
  expect(readFileSync(outside, "utf8")).toBe(outsideBytes);
});

test("a tail-only crash-window row registers its recovered identity and dedups the native replay", async () => {
  const { context, workflow } = await fixture("crash-window");
  // The legacy writer committed the durable row BEFORE its identity-index entry
  // and before the cursor advance: the row is complete, the registry never
  // learned it, and the bound stays behind the row's stream position.
  const line = '{"v":1,"ts":1760000000000,"kind":"dispatch","agent":"session-a","eventId":"wfe1:dispatch:session-a:stream-a:3","source":{"sessionId":"session-a","streamId":"stream-a","seq":3}}';
  const digest = createHash("sha256").update(line).digest("hex").slice(0, 32);
  const tail = `${line}\n{"eventId":"wfc1:s:c:tool","n":1}\n{"eventId":"wfc1:s:c:tool","n":1}\n`;
  writeFileSync(join(workflow, "agent-flow.jsonl"), tail);
  writeFileSync(join(workflow, "workflow-ledger-cursors.json"), JSON.stringify({ v: 2, cursors: { "session-a": { next: 1, stream: "stream-a" } } }));
  const result = await importDshHostStateFiles({ context, operator: "fixture", operationId: "crash-window" });
  expect(result.imported.identities).toBe(1);
  expect(result.imported.ledgerRows).toBe(3);
  const store = await openStore(context, "read");
  try {
    // Only the durable native row recovered an accepted identity; the ordinary
    // duplicate-capable display rows stay unregistered display evidence.
    expect(store.db.prepare("select event_id, digest from dsh_accepted_identities where workflow_id = ?").all("wf-crash-window")).toEqual([
      { event_id: "wfe1:dispatch:session-a:stream-a:3", digest },
    ]);
    expect(store.db.prepare("select event_json from dsh_ledger_events where workflow_id = ? order by seq_rowid").all("wf-crash-window")).toEqual([
      { event_json: line },
      { event_json: '{"eventId":"wfc1:s:c:tool","n":1}' },
      { event_json: '{"eventId":"wfc1:s:c:tool","n":1}' },
    ]);
  } finally { store.close(); }

  // Real native consumer re-observation at the unadvanced bound: the same
  // identity and digest replay as a no-op that only advances the bound.
  expect(appendDshWorkflowEvent(context, {
    workflowId: "wf-crash-window", eventId: "wfe1:dispatch:session-a:stream-a:3", digest, lineJson: line,
    source: { sessionId: "session-a", streamId: "stream-a", seq: 3 },
  })).toMatchObject({ kind: "replayed" });
  expect(readDshScanBound(context, "wf-crash-window", "session-a")).toEqual({ next: 4, stream: "stream-a" });

  // Different bytes under the same identity stay a conflict; the original row
  // and its accepted identity stand.
  const tampered = createHash("sha256").update('{"tampered":true}').digest("hex").slice(0, 32);
  expect(appendDshWorkflowEvent(context, {
    workflowId: "wf-crash-window", eventId: "wfe1:dispatch:session-a:stream-a:3", digest: tampered, lineJson: '{"tampered":true}',
    source: { sessionId: "session-a", streamId: "stream-a", seq: 3 },
  })).toMatchObject({ kind: "refused" });
  const after = await openStore(context, "read");
  try {
    expect(after.db.prepare("select count(*) as n from dsh_ledger_events where workflow_id = ? and event_id = ?").get("wf-crash-window", "wfe1:dispatch:session-a:stream-a:3")).toEqual({ n: 1 });
    expect(after.db.prepare("select count(*) as n from dsh_ledger_events where event_json = ?").get('{"tampered":true}')).toEqual({ n: 0 });
    expect(after.db.prepare("select digest from dsh_accepted_identities where workflow_id = ? and event_id = ?").get("wf-crash-window", "wfe1:dispatch:session-a:stream-a:3")).toEqual({ digest });
  } finally { after.close(); }
});

test("a tail row that disagrees with the retained identity index refuses the source and never rewrites it", async () => {
  const { context, workflow } = await fixture("index-tail-disagreement");
  const indexed = '{"id":"wfe1:session:event","d":"indexed-digest"}\n';
  const line = '{"eventId":"wfe1:session:event","v":1}';
  writeFileSync(join(workflow, "agent-flow-ids.jsonl"), indexed);
  writeFileSync(join(workflow, "agent-flow.jsonl"), `${line}\n`);
  await expect(importDshHostStateFiles({ context, operator: "fixture", operationId: "index-tail-disagreement" }))
    .rejects.toMatchObject({ code: "store.upgrade-dsh-source-refused", message: expect.stringContaining("disagree for this identity") });
  // Source-preserved: the conflicting legacy bytes were never rewritten.
  expect(readFileSync(join(workflow, "agent-flow.jsonl"), "utf8")).toBe(`${line}\n`);
  expect(readFileSync(join(workflow, "agent-flow-ids.jsonl"), "utf8")).toBe(indexed);
});

test("a torn native tail line withholds the tail instead of importing an undecidable identity", async () => {
  const { context, workflow } = await fixture("torn-native-tail");
  writeFileSync(join(workflow, "agent-flow.jsonl"), '{"eventId":"wfe1:dispatch:session-a:stream-a:3","v":1,"kind":"disp');
  writeFileSync(join(workflow, "agent-flow-ids.jsonl"), '{"id":"ev","d":"d"}\n');
  await expect(importDshHostStateFiles({ context, operator: "fixture", operationId: "torn-native-tail" }))
    .rejects.toMatchObject({ code: "store.upgrade-dsh-source-refused", message: expect.stringContaining("not a parseable row") });
  const acked = await importDshHostStateFiles({
    context, operator: "fixture", operationId: "torn-native-tail-ack", acknowledgedSkips: ["dsh-ledger:wf-torn-native-tail"],
  });
  expect(acked.imported.ledgerRows).toBe(0);
  expect(acked.imported.identities).toBe(1);
});
