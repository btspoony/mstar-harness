import { expect, test } from "bun:test";
import {
  EXECUTION_HOST_HISTORY_TYPES,
  exportExecutionHostHistory,
  readExecutionHostHistory,
  type ExecutionHostHistory,
  type ExecutionHostHistoryView,
} from "../src/execution-history";

/* ------------------------------------------------------------------ fixtures */

function customEntry(id: string, customType: string, data: unknown): Readonly<Record<string, unknown>> {
  return { id, type: "custom", customType, data };
}

/** The decoded view of one record, with the "must have decoded" assertion local to tests. */
function viewOf(history: ExecutionHostHistory, index: number): ExecutionHostHistoryView {
  const view = history.records[index]?.view;
  if (view === null || view === undefined) throw new Error(`record ${index} has no decoded view`);
  return view;
}

/** The current-generation phase-2 binding payload: a real session identity plus a legacy session path. */
const BIND_PAYLOAD = {
  version: 1,
  kind: "bind",
  hostSessionId: "sess-a",
  workflowId: "wf-1",
  coordinatorSessionPath: "/old/elsewhere/coord.json",
  coordinatorSessionId: "envelope-1",
  harnessRoot: "/harness",
} as const;

/* ------------------------------------------------------------- the inventory */

test("the hidden inventory is exactly the five contract types, in contract order", () => {
  expect([...EXECUTION_HOST_HISTORY_TYPES]).toEqual([
    "mstar:phase2",
    "mstar:phase2-continuation",
    "mstar:phase2-checkpoint",
    "mstar:phase2-launch-reservation",
    "mstar:model-handoff",
  ]);
});

test("each frozen literal survives classification and export unchanged", () => {
  const entries = [
    customEntry("t1", "mstar:phase2", { version: 1, kind: "reminder", hostSessionId: "s", observationKey: "o" }),
    customEntry("t2", "mstar:phase2-continuation", { sessionId: "s" }),
    customEntry("t3", "mstar:phase2-checkpoint", { sessionId: "s" }),
    customEntry("t4", "mstar:phase2-launch-reservation", { sessionId: "s", operationId: "l" }),
    customEntry("t5", "mstar:model-handoff", { version: 1, binding: { sessionId: "s" }, state: "pending" }),
  ];
  const history = readExecutionHostHistory(entries);
  expect(history.records.map((record) => record.type)).toEqual([...EXECUTION_HOST_HISTORY_TYPES]);
  expect(history.diagnostics).toEqual([]);

  const text = exportExecutionHostHistory(history);
  for (const type of EXECUTION_HOST_HISTORY_TYPES) expect(text).toContain(`"type":"${type}"`);
});

/* ----------------------------------------------------- order and identity --- */

test("recognized entries keep native order and identity; unrelated entries stay unrelated", () => {
  const entries = [
    customEntry("e1", "mstar:phase2", BIND_PAYLOAD),
    { id: "e2", type: "model_change", model: "openai/gpt" },
    customEntry("e3", "mstar:phase2-checkpoint", { sessionId: "sess-a", observationKey: "obs-7" }),
    customEntry("e4", "mstar:notice", { title: "a visible notice is not a hidden type" }),
    { id: "e5", type: "message", role: "user", text: "hello" },
    customEntry("e6", "mstar:model-handoff", {
      version: 1,
      binding: { sessionId: "sess-a", workflowId: "wf-1" },
      state: "cancelled",
      action: "handoff",
      operationId: "op-9",
    }),
  ];

  const history = readExecutionHostHistory(entries);
  expect(history.records.map((record) => [record.index, record.entryId, record.type])).toEqual([
    [0, "e1", "mstar:phase2"],
    [2, "e3", "mstar:phase2-checkpoint"],
    [5, "e6", "mstar:model-handoff"],
  ]);
  expect(history.diagnostics).toEqual([]);
  expect(exportExecutionHostHistory(history)).not.toContain("mstar:notice");
  expect(exportExecutionHostHistory(history)).not.toContain("hello");
});

test("export replay preserves order, identity and payloads byte-for-byte", () => {
  const entries = [
    customEntry("e1", "mstar:phase2", BIND_PAYLOAD),
    customEntry("e2", "mstar:model-handoff", {
      version: 1,
      binding: { sessionId: "sess-a", workflowId: "wf-1" },
      state: "cancelled",
      action: "handoff",
      operationId: "op-9",
      baselineModelChangeId: "mc-1",
      observedModel: null,
      reason: null,
    }),
  ];
  const history = readExecutionHostHistory(entries);
  const text = exportExecutionHostHistory(history);
  expect(text.endsWith("\n")).toBe(true);
  expect(text).toContain('"document":"execution-host-history"');

  const replayed = JSON.parse(text) as ExecutionHostHistory;
  expect(exportExecutionHostHistory(replayed)).toBe(text);
  expect(replayed.records.map((record) => [record.index, record.entryId, record.type])).toEqual([
    [0, "e1", "mstar:phase2"],
    [1, "e2", "mstar:model-handoff"],
  ]);
  expect(replayed.records[0]!.payload).toEqual(BIND_PAYLOAD);
  expect(replayed.records[0]!.payloadHash).toBe(history.records[0]!.payloadHash);
  expect(viewOf(replayed, 1).declaredState).toBe("cancelled");
  expect(viewOf(replayed, 1).cancelled).toBe(true);
});

test("a stale coordinator path is provenance only and never becomes a session identity", () => {
  const history = readExecutionHostHistory([customEntry("e1", "mstar:phase2", BIND_PAYLOAD)]);
  const record = history.records[0]!;

  // The session identity is the payload's own declared native id — never the
  // envelope id and never anything derived from the recorded path.
  expect(record.sessionId).toBe("sess-a");
  expect(viewOf(history, 0).provenance).toEqual([
    { field: "coordinatorSessionPath", path: "/old/elsewhere/coord.json" },
  ]);

  // Nothing on the record or its view is a binding or an authority shape.
  for (const forbidden of ["binding", "session", "authority"]) {
    expect(Object.keys(record.view!)).not.toContain(forbidden);
    expect(Object.keys(record)).not.toContain(forbidden);
  }
  expect(history.document).toBe("execution-host-history");

  // Reading needs no "current session" argument, so the same ledger cannot be
  // read into two different authorities.
  expect(exportExecutionHostHistory(readExecutionHostHistory([customEntry("e1", "mstar:phase2", BIND_PAYLOAD)]))).toBe(
    exportExecutionHostHistory(history),
  );
});

/* ------------------------------------------------ generations and identity --- */

test("legacy and current payload generations decode without renaming or rewriting", () => {
  const legacyData = { sessionId: "sess-legacy", generation: 4, note: "old continuation record" };
  const currentData = {
    version: 1,
    kind: "checkpoint",
    hostSessionId: "sess-cur",
    workflowId: "wf-2",
    reason: "before-wait",
    decision: "wait",
    note: "n",
    observationKey: "obs-2",
  };
  const entries = [
    customEntry("l1", "mstar:phase2-continuation", legacyData),
    customEntry("c1", "mstar:phase2", currentData),
  ];
  const history = readExecutionHostHistory(entries);

  expect(history.diagnostics).toEqual([]);
  expect(history.records.map((record) => record.type)).toEqual(["mstar:phase2-continuation", "mstar:phase2"]);
  expect(viewOf(history, 0).generation).toBe(0);
  expect(viewOf(history, 1).generation).toBe(1);
  expect(history.records[0]!.payload).toEqual(legacyData);
  expect(history.records[1]!.payload).toEqual(currentData);
  // The legacy payload's own generation counter stays verbatim in the evidence.
  expect(history.records[0]!.payload).toMatchObject({ generation: 4 });
  expect(exportExecutionHostHistory(history)).toContain('"type":"mstar:phase2-continuation"');
});

test("checkpoint, launch and handoff identity, dedup, cancellation and one-shot state are preserved", () => {
  const history = readExecutionHostHistory([
    customEntry("k1", "mstar:phase2", { version: 1, kind: "checkpoint", hostSessionId: "s", observationKey: "obs-7" }),
    customEntry("k2", "mstar:phase2-launch-reservation", { sessionId: "s", operationId: "launch-3", launchId: "L-3" }),
    customEntry("k3", "mstar:model-handoff", {
      version: 1,
      binding: { sessionId: "s" },
      state: "cancelled",
      action: "handoff",
      operationId: "handoff-9",
    }),
    customEntry("k4", "mstar:model-handoff", {
      version: 1,
      binding: { sessionId: "s" },
      state: "pending",
      action: "arm",
      operationId: "handoff-10",
      baselineModelChangeId: "mc-2",
    }),
  ]);

  expect(history.diagnostics).toEqual([]);
  expect(viewOf(history, 0).checkpointId).toBe("obs-7");
  expect(viewOf(history, 0).dedupKey).toBe("obs-7");
  expect(viewOf(history, 1).operationId).toBe("launch-3");
  expect(viewOf(history, 1).dedupKey).toBe("launch-3");
  expect(history.records[1]!.payload).toMatchObject({ launchId: "L-3" });
  expect(exportExecutionHostHistory(history)).toContain('"launchId":"L-3"');
  expect(viewOf(history, 2).declaredState).toBe("cancelled");
  expect(viewOf(history, 2).cancelled).toBe(true);
  expect(viewOf(history, 2).dedupKey).toBe("handoff-9");
  expect(viewOf(history, 3).declaredState).toBe("pending");
  expect(viewOf(history, 3).declaredAction).toBe("arm");
  expect(viewOf(history, 3).cancelled).toBe(false);
  expect(history.records[3]!.payload).toMatchObject({ baselineModelChangeId: "mc-2" });
});

/* --------------------------------------------------- malformed diagnostics --- */

test("malformed recognized entries are diagnosed and retained, never guessed", () => {
  const cases: ReadonlyArray<
    Readonly<{ entry: Readonly<Record<string, unknown>>; code: string; sessionId: string | null }>
  > = [
    {
      entry: customEntry("m1", "mstar:phase2", "phase2"),
      code: "payload-not-object",
      sessionId: null,
    },
    {
      entry: customEntry("m2", "mstar:phase2", { version: 1, kind: "bind" }),
      code: "session-identity-missing",
      sessionId: null,
    },
    {
      entry: customEntry("m3", "mstar:phase2", { version: 1, kind: "resume", hostSessionId: "s" }),
      code: "payload-kind-invalid",
      sessionId: "s",
    },
    {
      entry: customEntry("m4", "mstar:model-handoff", { version: 1, binding: { sessionId: "s" }, state: "armed" }),
      code: "payload-state-invalid",
      sessionId: "s",
    },
    {
      entry: customEntry("m5", "mstar:phase2", { version: 2.5, kind: "bind", hostSessionId: "s" }),
      code: "payload-version-invalid",
      sessionId: "s",
    },
    {
      entry: customEntry("", "mstar:phase2", { version: 1, kind: "bind", hostSessionId: "s" }),
      code: "entry-id-missing",
      sessionId: "s",
    },
    {
      entry: customEntry("m7", "mstar:phase2", { version: 1, kind: "bind", hostSessionId: "s", extra: undefined }),
      code: "payload-unsupported",
      sessionId: null,
    },
    {
      entry: { id: "m8", type: "message", customType: "mstar:phase2", data: { version: 1, kind: "bind", hostSessionId: "s" } },
      code: "entry-shape",
      sessionId: "s",
    },
  ];

  for (const { entry, code, sessionId } of cases) {
    const history = readExecutionHostHistory([entry]);
    expect(history.records).toHaveLength(1);
    expect(history.records[0]!.view).toBeNull();
    expect(history.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([code]);
    expect(history.diagnostics[0]!.index).toBe(0);
    expect(history.diagnostics[0]!.type).toBe(entry.customType);
    // The record's session identity is only ever the payload's own declared id —
    // and a payload that was never admitted yields none at all.
    expect(history.records[0]!.sessionId).toBe(sessionId);
    // The evidence survives either as the exact payload or as an explicit
    // canonical refusal — never as a silently dropped record.
    if (code === "payload-unsupported") {
      expect(history.records[0]!.payloadHash).toBeNull();
      expect(history.records[0]!.payload).toBeNull();
    } else {
      expect(history.records[0]!.payload).toEqual(entry.data);
      expect(history.records[0]!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    }
    // Export stays total and keeps the diagnosis readable.
    expect(exportExecutionHostHistory(history)).toContain(`"code":"${code}"`);
  }
});

test("a recognized entry without a declared identity is never attributed by adjacency", () => {
  const history = readExecutionHostHistory([
    customEntry("n1", "mstar:phase2-checkpoint", { observationKey: "obs-1" }),
    customEntry("n2", "mstar:phase2", { version: 1, kind: "bind", hostSessionId: "sess-a", workflowId: "wf-1" }),
  ]);

  expect(history.records[0]!.sessionId).toBeNull();
  expect(history.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["session-identity-missing"]);
  expect(history.records[1]!.sessionId).toBe("sess-a");
});

/* ------------------------------------------------------------ canonical form */

test("payload digests and exports are independent of payload key order", () => {
  const ordered = readExecutionHostHistory([customEntry("c1", "mstar:phase2", BIND_PAYLOAD)]);
  const shuffled = readExecutionHostHistory([
    customEntry("c1", "mstar:phase2", {
      harnessRoot: "/harness",
      coordinatorSessionId: "envelope-1",
      coordinatorSessionPath: "/old/elsewhere/coord.json",
      workflowId: "wf-1",
      hostSessionId: "sess-a",
      kind: "bind",
      version: 1,
    }),
  ]);

  expect(ordered.records[0]!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  expect(shuffled.records[0]!.payloadHash).toBe(ordered.records[0]!.payloadHash);
  expect(exportExecutionHostHistory(shuffled)).toBe(exportExecutionHostHistory(ordered));
});
