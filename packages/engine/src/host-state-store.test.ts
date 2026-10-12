import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDshLedgerRow, appendDshWorkflowEvent, advanceDshScanBound, readDshLedgerWindow, readDshScanBound, readDshSessionBinding, readDshStatusEmission, recordDshStatusEmission, writeDshSessionBinding } from "./host-state-store.js";
import { initializeStore, openStore, withDshWriteTransaction } from "./store-db.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-dsh-state-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

async function fresh(label: string) {
  const context = { harnessDir: mkdtempSync(join(ROOT, `${label}-`)) };
  const handle = await initializeStore(context);
  return { context, handle };
}

function count(db: { prepare(sql: string): { get(): unknown } }, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

describe("host-state store domain", () => {


  test("fails closed before store activation with exact initialization recovery", () => {
    const context = { harnessDir: mkdtempSync(join(ROOT, "pre-activation-")) };
    expect(appendDshLedgerRow(context, "wf", "{}")).toMatchObject({
      kind: "degraded",
      reason: expect.stringContaining("mstar store init"),
    });
    expect(readDshSessionBinding(context, "s", "/cwd")).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("mstar store init"),
    });
    expect(existsSync(join(context.harnessDir, "store.db"))).toBe(false);
  });
  test("reports staged authority separately from true absence", async () => {
    const { context, handle } = await fresh("staged");
    try {
      handle.db.prepare("update execution_meta set authority_state='staged' where id=1").run();
      expect(readDshSessionBinding(context, "s", "/cwd")).toMatchObject({
        kind: "unavailable",
        reason: expect.stringContaining("reviewed activation"),
      });
    } finally {
      handle.close();
    }
  });

  test("refuses nested private DSH transactions without changing revision", async () => {
    const { context, handle } = await fresh("nested");
    const revision = (handle.db.prepare("select revision from store_meta where id=1").get() as { revision: number }).revision;
    try {
      expect(() => withDshWriteTransaction(context, () =>
        withDshWriteTransaction(context, () => "nested"),
      )).toThrow("nested host-state transaction");
      expect((handle.db.prepare("select revision from store_meta where id=1").get() as { revision: number }).revision).toBe(revision);
    } finally {
      handle.close();
    }
  });
  test("preserves duplicate live rows while deduplicating verified workflow identities by digest", async () => {
    const { context, handle } = await fresh("dedup");
    const identity = { workflowId: "wf-a", eventId: "wfe1:dispatch:stream-a:1", digest: "digest-a", lineJson: "{\"eventId\":\"live\"}", source: { sessionId: "session-a", streamId: "stream-a", seq: 1 }, selectedGeneration: { storeId: handle.storeId, epoch: handle.epoch } };
    try {
      expect(appendDshLedgerRow(context, "wf-a", "{\"eventId\":\"same\"}", "live")).toEqual({ kind: "written" });
      expect(appendDshLedgerRow(context, "wf-a", "{\"eventId\":\"same\"}", "live")).toEqual({ kind: "written" });
      expect(appendDshWorkflowEvent(context, identity)).toEqual({ kind: "accepted" });
      handle.db.prepare("delete from dsh_scan_bounds where workflow_id = ? and session_id = ?").run("wf-a", "session-a");
      expect(appendDshWorkflowEvent(context, identity)).toEqual({ kind: "replayed" });
      expect(readDshScanBound(context, "wf-a", "session-a")).toEqual({ next: 2, stream: "stream-a" });
      expect(appendDshWorkflowEvent(context, { ...identity, digest: "digest-b" })).toMatchObject({ kind: "refused" });
      expect(readDshLedgerWindow(context, "wf-a", 10)).toEqual([
        identity.lineJson, "{\"eventId\":\"same\"}", "{\"eventId\":\"same\"}",
      ]);
      expect(readDshLedgerWindow(context, "wf-a", -3)).toEqual([]);
      expect(readDshLedgerWindow(context, "wf-a", 0)).toEqual([]);
      expect(readDshLedgerWindow(context, "wf-other", 10)).toEqual([]);
      expect(count(handle.db, "select count(*) as n from dsh_accepted_identities where workflow_id='wf-a'")).toBe(1);
    } finally {
      handle.close();
    }
  });
  test("bumps shared revision once per accepted mutation, including replay cursor advances only", async () => {
    const { context, handle } = await fresh("revision");
    const revision = () => (handle.db.prepare("select revision from store_meta where id=1").get() as { revision: number }).revision;
    try {
      const initial = revision();
      const event = {
        workflowId: "wf", eventId: "e1", digest: "d", lineJson: "{}",
        source: { sessionId: "s", streamId: "a", seq: 1 },
        selectedGeneration: { storeId: handle.storeId, epoch: handle.epoch },
      };
      expect(appendDshWorkflowEvent(context, event)).toEqual({ kind: "accepted" });
      expect(revision()).toBe(initial + 1);
      expect(appendDshWorkflowEvent(context, { ...event, digest: "conflict" })).toMatchObject({ kind: "refused" });
      expect(revision()).toBe(initial + 1);
      expect(appendDshWorkflowEvent(context, event)).toEqual({ kind: "replayed" });
      expect(revision()).toBe(initial + 1);
      expect(appendDshWorkflowEvent(context, { ...event, source: { ...event.source, seq: 2 } })).toEqual({ kind: "replayed" });
      expect(revision()).toBe(initial + 2);
      expect(writeDshSessionBinding(context, "s", "/cwd", { excludedBeforeSeq: 2 }, event.selectedGeneration)).toEqual({ kind: "written" });
      expect(revision()).toBe(initial + 3);
    } finally {
      handle.close();
    }
  });

  test("rejects a selected store identity replaced before the write preflight", async () => {
    const { context, handle } = await fresh("replacement");
    const selected = { storeId: handle.storeId, epoch: handle.epoch };
    try {
      handle.db.prepare("update store_meta set store_id = ?, authority_epoch = ? where id=1").run("replacement-store", selected.epoch);
      expect(advanceDshScanBound(context, "wf", "s", 2, "stream", selected)).toBe(false);
      expect(readDshScanBound(context, "wf", "s")).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  test("commits accepted identity, display event and scan bound atomically on rollback", async () => {
    const { context, handle } = await fresh("rollback");
    try {
      const revision = (handle.db.prepare("select revision from store_meta where id=1").get() as { revision: number }).revision;
      handle.db.exec("create trigger fail_dsh_event before insert on dsh_ledger_events begin select raise(abort, 'forced event failure'); end");
      const result = appendDshWorkflowEvent(context, {
        workflowId: "wf", eventId: "wfe1:dispatch:s:4", digest: "d", lineJson: "{}",
        source: { sessionId: "s", streamId: "stream", seq: 4 }, selectedGeneration: { storeId: handle.storeId, epoch: handle.epoch },
      });
      expect(result).toMatchObject({ kind: "refused" });
      expect(count(handle.db, "select count(*) as n from dsh_accepted_identities")).toBe(0);
      expect(count(handle.db, "select count(*) as n from dsh_ledger_events")).toBe(0);
      expect((handle.db.prepare("select revision from store_meta where id=1").get() as { revision: number }).revision).toBe(revision);
    } finally {
      handle.close();
    }
  });

  test("rejects stale selected epochs and advances bounds monotonically per incarnation", async () => {
    const { context, handle } = await fresh("epoch-cursor");
    try {
      handle.db.prepare("update store_meta set authority_epoch = authority_epoch + 1 where id=1").run();
      expect(appendDshWorkflowEvent(context, {
        workflowId: "wf", eventId: "wfe1:dispatch:s:4", digest: "d", lineJson: "{}",
        source: { sessionId: "s", streamId: "stream", seq: 4 }, selectedGeneration: { storeId: handle.storeId, epoch: handle.epoch },
      })).toMatchObject({ kind: "refused", reason: expect.stringContaining("store.stale-epoch") });
      expect(count(handle.db, "select count(*) as n from dsh_ledger_events")).toBe(0);
      expect(advanceDshScanBound(context, "wf", "s", 0, "incarnation-a")).toBe(false);
      expect(readDshScanBound(context, "wf", "s")).toBeUndefined();
      expect(advanceDshScanBound(context, "wf", "s", 9, "incarnation-a")).toBe(true);
      expect(advanceDshScanBound(context, "wf", "s", 3, "incarnation-a")).toBe(true);
      expect(readDshScanBound(context, "wf", "s")).toEqual({ next: 9, stream: "incarnation-a" });
      expect(advanceDshScanBound(context, "wf", "s", 2, "incarnation-b")).toBe(true);
      expect(readDshScanBound(context, "wf", "s")).toEqual({ next: 2, stream: "incarnation-b" });
      expect(advanceDshScanBound(context, "wf", "s", 8, null)).toBe(true);
      expect(readDshScanBound(context, "wf", "s")).toEqual({ next: 8 });
      expect(advanceDshScanBound(context, "wf", "s", 3, null)).toBe(true);
      expect(readDshScanBound(context, "wf", "s")).toEqual({ next: 8 });
    } finally {
      handle.close();
    }
  });

  test("isolates binding/emission rows by session and cwd and keeps the binding exclusion max", async () => {
    const { context, handle } = await fresh("binding-emission");
    try {
      expect(writeDshSessionBinding(context, "s", "/cwd", {
        selectedWorkflowId: "wf-a", executionBinding: "bind-a", excludedBeforeSeq: 9,
      })).toEqual({ kind: "written" });
      expect(writeDshSessionBinding(context, "s", "/cwd", { excludedBeforeSeq: 3 })).toEqual({ kind: "written" });
      expect(writeDshSessionBinding(context, "s", "/other", { selectedWorkflowId: "wf-c", executionBinding: null, excludedBeforeSeq: 1 })).toMatchObject({
        kind: "degraded", reason: "cwd-mismatch",
      });
      expect(writeDshSessionBinding(context, "other", "/other", { selectedWorkflowId: "wf-c", excludedBeforeSeq: 1 })).toEqual({ kind: "written" });
      expect(readDshSessionBinding(context, "s", "/cwd")).toMatchObject({ kind: "ok", binding: { selectedWorkflowId: "wf-a", executionBinding: "bind-a", excludedBeforeSeq: 9 } });
      expect(readDshSessionBinding(context, "s", "/other")).toMatchObject({ kind: "unavailable", reason: "cwd-mismatch" });
      expect(readDshSessionBinding(context, "other", "/other")).toMatchObject({ kind: "ok", binding: { selectedWorkflowId: "wf-c", excludedBeforeSeq: 1 } });
      expect(recordDshStatusEmission(context, "s", "/cwd", 1, "first")).toEqual({ kind: "written" });
      expect(recordDshStatusEmission(context, "s", "/cwd", 2, "second")).toEqual({ kind: "written" });
      expect(recordDshStatusEmission(context, "other", "/cwd", 1, "other-session")).toEqual({ kind: "written" });
      expect(readDshStatusEmission(context, "s", "/cwd")).toMatchObject({ turn: 2, payloadJson: "second" });
      expect(handle.db.prepare("select turn, payload_json from dsh_status_emissions where session_id='s' and cwd='/cwd'").get()).toEqual({ turn: 2, payload_json: "second" });
      expect(count(handle.db, "select count(*) as n from dsh_status_emissions")).toBe(2);
    } finally {
      handle.close();
    }
  });

  test("serializes competing processes at SQLite and returns accepted/replayed for one source identity", async () => {
    const { context, handle } = await fresh("concurrent");
    handle.close();
    const gate = join(context.harnessDir, "release");
    const moduleUrl = new URL("./host-state-store.ts", import.meta.url).href;
    const source = `import { existsSync } from 'node:fs'; import { appendDshWorkflowEvent } from ${JSON.stringify(moduleUrl)}; const gate=process.env.DSH_RELEASE_FILE; console.log('ready'); while (!existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); const result = appendDshWorkflowEvent({harnessDir:process.env.DSH_HARNESS_DIR}, {workflowId:'wf',eventId:'wfe1:dispatch:stream:1',digest:'same',lineJson:'{}',source:{sessionId:'s',streamId:'stream',seq:1}}); console.log(result.kind);`;
    const workers = [0, 1].map(() => spawn(process.execPath, ["-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DSH_RELEASE_FILE: gate, DSH_HARNESS_DIR: context.harnessDir },
    }));
    const readiness = workers.map(() => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    });
    const outputs = workers.map((worker, index) => new Promise<string>((resolve, reject) => {
      let output = "";
      let observedReady = false;
      worker.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
        if (!observedReady && output.includes("ready")) {
          observedReady = true;
          readiness[index]!.resolve();
        }
      });
      worker.stderr.setEncoding("utf8").on("data", (chunk: string) => output += chunk);
      worker.on("error", reject);
      worker.on("close", (code) => {
        if (!observedReady) readiness[index]!.resolve();
        if (code === 0) resolve(output.trim().split("\n").at(-1)!);
        else reject(new Error(`worker exit ${code}: ${output}`));
      });
    }));
    await Promise.all(readiness.map(({ promise }) => promise));
    writeFileSync(gate, "go");
    expect((await Promise.all(outputs)).sort()).toEqual(["accepted", "replayed"]);
    const check = await openStore(context, "read");
    try {
      expect(count(check.db, "select count(*) as n from dsh_ledger_events")).toBe(1);
      expect(count(check.db, "select count(*) as n from dsh_accepted_identities")).toBe(1);
    } finally {
      check.close();
    }
  });
});
