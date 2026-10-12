import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore, openStore, type StoreContext } from "./store-db.js";
import {
  advanceDshScanBound, appendDshLedgerRow, appendDshWorkflowEvent, importDshHostStateRows,
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
    tailBefore: { bytes: Buffer.byteLength(tail), sha256: sha(tail) },
    tailAfter: { bytes: 0, sha256: sha("") },
    archive: { chunk: "chunk-000001.jsonl", offset: 0, bytes: Buffer.byteLength(`${archived}\n`), sha256: sha(`${archived}\n`) },
  }));
  await expect(importDshHostStateFiles({ context, operator: "fixture", operationId: "missing-history-index" }))
    .rejects.toMatchObject({ code: "store.upgrade-dsh-source-refused", message: expect.stringContaining("identity index absent") });
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

test("a landed journal imports the tail and keeps the journal; an undecidable one refuses only the tail", async () => {
  const { context, workflow } = await fixture("journal");
  const historyDir = join(workflow, "agent-flow-history");
  mkdirSync(historyDir, { recursive: true });
  const archived = '{"eventId":"wfe1:session:old"}';
  writeFileSync(join(historyDir, "chunk-000001.jsonl"), `${archived}\n`);
  const tail = '{"eventId":"wfc1:session:new"}\n';
  const journalPath = join(workflow, "agent-flow-compaction.json");
  writeFileSync(join(workflow, "agent-flow.jsonl"), tail);
  writeFileSync(join(workflow, "agent-flow-ids.jsonl"), `${JSON.stringify({ id: "wfe1:session:old", d: sha(archived).slice(0, 32) })}\n`);
  writeFileSync(journalPath, JSON.stringify({
    version: 1,
    tailBefore: { bytes: 99, sha256: sha("other") },
    tailAfter: { bytes: Buffer.byteLength(tail), sha256: sha(tail) },
    archive: { chunk: "chunk-000001.jsonl", offset: 0, bytes: Buffer.byteLength(`${archived}\n`), sha256: sha(`${archived}\n`) },
  }));
  const landed = await importDshHostStateFiles({ context, operator: "fixture", operationId: "landed" });
  expect(landed.imported.ledgerRows).toBe(1);
  expect(landed.findings).toContainEqual(expect.objectContaining({ kind: "journal", decision: "landed" }));
  expect(readFileSync(journalPath, "utf8")).toContain("tailAfter");

  writeFileSync(journalPath, JSON.stringify({
    version: 1,
    tailBefore: { bytes: 1, sha256: sha("x") },
    tailAfter: { bytes: 2, sha256: sha("y") },
    archive: { chunk: "chunk-000001.jsonl", offset: 0, bytes: 1, sha256: sha("z") },
  }));
  const undecidable = await importDshHostStateFiles({ context, operator: "fixture", operationId: "undecidable", acknowledgedSkips: ["dsh-ledger:wf-journal"] });
  expect(undecidable.findings).toContainEqual(
    expect.objectContaining({ kind: "dropped-by-ack", selector: "dsh-ledger:wf-journal", droppedFacts: "tail rows" }),
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

test("the typed writer refuses a stale store epoch before writing anything", async () => {
  const { context } = await fixture("stale-epoch");
  const handle = await openStore(context, "write");
  try {
    handle.db.prepare("update store_meta set authority_epoch = authority_epoch + 1 where id=1").run();
    expect(() => importDshHostStateRows(
      { db: handle.db, storeId: handle.storeId, epoch: handle.epoch },
      {
        workflows: [{ workflowId: "wf-stale", identities: [{ eventId: "ev", digest: "d", acceptedAt: "2026-01-01T00:00:00.000Z" }], tailSourceDigest: null, ledgerRows: [], scanBounds: [] }],
        bindings: [], emissions: [],
      },
      "2026-01-01T00:00:00.000Z",
    )).toThrow(/store\.stale-epoch/);
    expect(handle.db.prepare("select count(*) as n from dsh_accepted_identities").get()).toEqual({ n: 0 });
  } finally { handle.close(); }
});
