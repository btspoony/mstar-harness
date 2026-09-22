import { expect, test } from "bun:test";
import {
  EXECUTION_HOST_HISTORY_TYPES,
  ExecutionHostHistoryExportRefusal,
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

/** One single-entry read, for the guard-mirror tables. */
function readOne(type: string, data: unknown): ExecutionHostHistory {
  return readExecutionHostHistory([customEntry("g1", type, data)]);
}

/** The refusal one export raised, or `null` when it exported. */
function refusalOf(history: ExecutionHostHistory): unknown {
  try {
    exportExecutionHostHistory(history);
    return null;
  } catch (error) {
    return error;
  }
}

/** A current-generation phase-2 binding payload: a real session identity plus a legacy session path. */
const BIND_PAYLOAD = {
  version: 1,
  kind: "bind",
  hostSessionId: "sess-a",
  workflowId: "wf-1",
  coordinatorSessionPath: "/old/elsewhere/coord.json",
  coordinatorSessionId: "envelope-1",
  harnessRoot: "/harness",
} as const;

const CHECKPOINT_PAYLOAD = {
  version: 1,
  kind: "checkpoint",
  hostSessionId: "sess-a",
  workflowId: "wf-1",
  reason: "before-wait",
  decision: "wait",
  note: "n",
  observationKey: "obs-7",
} as const;

const HANDOFF_PAYLOAD = {
  version: 1,
  binding: { sessionId: "sess-a", workflowId: "wf-1" },
  state: "cancelled",
  action: "handoff",
  operationId: "op-9",
  baselineModelChangeId: "mc-1",
  observedModel: null,
  reason: null,
} as const;

const PENDING_HANDOFF_PAYLOAD = { ...HANDOFF_PAYLOAD, state: "pending", action: "arm", operationId: "op-10" } as const;

/**
 * The active producer's v2 phase-2 binding payload: the envelope fields plus the
 * `executionBinding` shape it declares. The shape is reported verbatim — never
 * resolved against a store, a workflow or a session.
 */
const V2_BIND_PAYLOAD = {
  version: 2,
  kind: "bind",
  hostSessionId: "sess-v2",
  workflowId: "wf-2",
  executionBinding: {
    version: 1,
    harnessRoot: "/harness",
    session: {
      storeId: "store-a",
      sessionId: "sess-a",
      workflowId: "wf-2",
      role: "plan-pm",
      planId: "plan-1",
      epoch: 3,
    },
  },
} as const;

/** A v2 bind that names a foreign store, another session and a far-future epoch. */
const FOREIGN_V2_BIND_PAYLOAD = {
  ...V2_BIND_PAYLOAD,
  hostSessionId: "sess-v2b",
  executionBinding: {
    version: 1,
    harnessRoot: "/other/harness",
    session: {
      storeId: "store-elsewhere",
      sessionId: "sess-other",
      workflowId: "wf-9",
      role: "coordinator",
      planId: null,
      epoch: 987654321,
    },
  },
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

test("every frozen literal is recognized; only the produced generation is decoded", () => {
  const history = readExecutionHostHistory([
    customEntry("t1", "mstar:phase2", {
      version: 1,
      kind: "reminder",
      hostSessionId: "s",
      workflowId: "w",
      observationKey: "o",
    }),
    customEntry("t2", "mstar:phase2-continuation", { sessionId: "s" }),
    customEntry("t3", "mstar:phase2-checkpoint", { sessionId: "s", observationKey: "o" }),
    customEntry("t4", "mstar:phase2-launch-reservation", { sessionId: "s", operationId: "l", launchId: "L-3" }),
    customEntry("t5", "mstar:model-handoff", PENDING_HANDOFF_PAYLOAD),
  ]);

  expect(history.records.map((record) => record.type)).toEqual([...EXECUTION_HOST_HISTORY_TYPES]);
  // No producer or historical schema exists for the three producer-less names,
  // so their payloads are retained raw and diagnosed instead of guessed.
  expect(history.diagnostics.map((diagnostic) => [diagnostic.index, diagnostic.code])).toEqual([
    [1, "payload-generation-unverified"],
    [2, "payload-generation-unverified"],
    [3, "payload-generation-unverified"],
  ]);
  for (const index of [1, 2, 3]) {
    expect(history.records[index]!.view).toBeNull();
    expect(history.records[index]!.sessionId).toBeNull();
    expect(history.records[index]!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  }

  const text = exportExecutionHostHistory(history);
  for (const type of EXECUTION_HOST_HISTORY_TYPES) expect(text).toContain(`"type":"${type}"`);
  // A declared launch id the view does not name survives verbatim in the evidence.
  expect(text).toContain('"launchId":"L-3"');
});

/* ----------------------------------------------------- order and identity --- */

test("recognized entries keep native order and identity; unrelated entries stay unrelated", () => {
  const entries = [
    customEntry("e1", "mstar:phase2", BIND_PAYLOAD),
    { id: "e2", type: "model_change", model: "openai/gpt" },
    customEntry("e3", "mstar:phase2-checkpoint", { sessionId: "sess-a", observationKey: "obs-7" }),
    customEntry("e4", "mstar:notice", { title: "a visible notice is not a hidden type" }),
    { id: "e5", type: "message", role: "user", text: "hello" },
    customEntry("e6", "mstar:model-handoff", HANDOFF_PAYLOAD),
  ];

  const history = readExecutionHostHistory(entries);
  expect(history.records.map((record) => [record.index, record.entryId, record.type])).toEqual([
    [0, "e1", "mstar:phase2"],
    [2, "e3", "mstar:phase2-checkpoint"],
    [5, "e6", "mstar:model-handoff"],
  ]);
  expect(history.diagnostics.map((diagnostic) => [diagnostic.index, diagnostic.code])).toEqual([
    [2, "payload-generation-unverified"],
  ]);
  expect(history.records[0]!.sessionId).toBe("sess-a");
  expect(history.records[2]!.sessionId).toBe("sess-a");
  expect(history.records[1]!.sessionId).toBeNull();

  const text = exportExecutionHostHistory(history);
  expect(text).not.toContain("mstar:notice");
  expect(text).not.toContain("hello");
});

test("export replay preserves order, identity and payloads byte-for-byte", () => {
  const history = readExecutionHostHistory([
    customEntry("e1", "mstar:phase2", BIND_PAYLOAD),
    customEntry("e2", "mstar:model-handoff", HANDOFF_PAYLOAD),
  ]);
  const text = exportExecutionHostHistory(history);
  expect(text.endsWith("\n")).toBe(true);
  expect(text).toContain('"document":"execution-host-history"');
  expect(history.diagnostics).toEqual([]);

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

test("an unverified generation keeps raw evidence and is never decoded by guesswork", () => {
  const legacy = { sessionId: "sess-legacy", generation: 4, note: "old continuation record" };
  // Generation 2 is verified for `kind: "bind"` alone, so a v2 payload of any
  // other kind stays an unverified generation and is never decoded by guesswork.
  const future = {
    version: 2,
    kind: "checkpoint",
    hostSessionId: "sess-future",
    workflowId: "wf-2",
    coordinatorSessionPath: "/p",
    coordinatorSessionId: "e",
    harnessRoot: "/h",
  };
  const history = readExecutionHostHistory([
    customEntry("l1", "mstar:phase2-continuation", legacy),
    customEntry("l2", "mstar:phase2", future),
  ]);

  expect(history.diagnostics.map((diagnostic) => [diagnostic.index, diagnostic.code])).toEqual([
    [0, "payload-generation-unverified"],
    [1, "payload-generation-unverified"],
  ]);
  const retained: ReadonlyArray<Readonly<{ index: number; data: unknown }>> = [
    { index: 0, data: legacy },
    { index: 1, data: future },
  ];
  for (const { index, data } of retained) {
    expect(history.records[index]!.view).toBeNull();
    expect(history.records[index]!.sessionId).toBeNull();
    expect(history.records[index]!.payload).toEqual(data);
    expect(history.records[index]!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  }
  // The unverified generation is never named as one the reader decoded.
  expect(history.records[0]!.payload).toMatchObject({ sessionId: "sess-legacy", generation: 4 });
  expect(exportExecutionHostHistory(history)).toContain('"version":2');
});

/* --------------------------------------------- the v2 phase-2 bind generation --- */

test("a v2 bind decodes under generation 2 with its declared binding shape and a digest", () => {
  const history = readExecutionHostHistory([
    customEntry("v1", "mstar:phase2", V2_BIND_PAYLOAD),
    customEntry("v2", "mstar:phase2", FOREIGN_V2_BIND_PAYLOAD),
  ]);
  expect(history.diagnostics).toEqual([]);

  const record = history.records[0]!;
  expect(record.sessionId).toBe("sess-v2");
  expect(record.payload).toEqual(V2_BIND_PAYLOAD);
  expect(record.payloadHash).toMatch(/^[0-9a-f]{64}$/);

  const view = viewOf(history, 0);
  expect(view.generation).toBe(2);
  expect(view.declaredKind).toBe("bind");
  expect(view.workflowId).toBe("wf-2");
  expect(view.executionBinding).toEqual({
    harnessRoot: "/harness",
    storeId: "store-a",
    epoch: 3,
    sessionId: "sess-a",
    role: "plan-pm",
    planId: "plan-1",
  });
  // Exactly the declared shape: no credential, token, path or session-file field.
  expect(Object.keys(view.executionBinding!).sort()).toEqual(["epoch", "harnessRoot", "planId", "role", "sessionId", "storeId"]);
  // A v2 record names no envelope path, so its view carries no provenance.
  expect(view.provenance).toEqual([]);

  // The reference is a lookup, never authority: a foreign store, another session
  // and a far-future epoch are reported verbatim, compared against nothing.
  const foreign = viewOf(history, 1);
  expect(history.records[1]!.sessionId).toBe("sess-v2b");
  expect(foreign.generation).toBe(2);
  expect(foreign.executionBinding).toEqual({
    harnessRoot: "/other/harness",
    storeId: "store-elsewhere",
    epoch: 987654321,
    sessionId: "sess-other",
    role: "coordinator",
    planId: null,
  });
});

test("a v2 bind with a malformed executionBinding is refused and its payload kept in full", () => {
  const good = V2_BIND_PAYLOAD.executionBinding;
  const cases: readonly unknown[] = [
    // No reference at all.
    { version: 2, kind: "bind", hostSessionId: "sess-v2", workflowId: "wf-2" },
    { ...V2_BIND_PAYLOAD, executionBinding: "none" },
    { ...V2_BIND_PAYLOAD, executionBinding: null },
    // A reference at the wrong generation, or with an unusable root.
    { ...V2_BIND_PAYLOAD, executionBinding: { ...good, version: 2 } },
    { ...V2_BIND_PAYLOAD, executionBinding: { ...good, harnessRoot: "" } },
    { ...V2_BIND_PAYLOAD, executionBinding: { ...good, session: "sess-a" } },
    // Empty identity fields, an unknown role, a non-null plan id on a coordinator
    // and a non-positive or fractional epoch.
    { ...V2_BIND_PAYLOAD, executionBinding: { ...good, session: { ...good.session, storeId: "" } } },
    { ...V2_BIND_PAYLOAD, executionBinding: { ...good, session: { ...good.session, sessionId: "" } } },
    { ...V2_BIND_PAYLOAD, executionBinding: { ...good, session: { ...good.session, workflowId: "" } } },
    { ...V2_BIND_PAYLOAD, executionBinding: { ...good, session: { ...good.session, role: "dev" } } },
    { ...V2_BIND_PAYLOAD, executionBinding: { ...good, session: { ...good.session, planId: 3 } } },
    { ...V2_BIND_PAYLOAD, executionBinding: { ...good, session: { ...good.session, epoch: 0 } } },
    { ...V2_BIND_PAYLOAD, executionBinding: { ...good, session: { ...good.session, epoch: -3 } } },
    { ...V2_BIND_PAYLOAD, executionBinding: { ...good, session: { ...good.session, epoch: 1.5 } } },
    { ...V2_BIND_PAYLOAD, executionBinding: { ...good, session: { ...good.session, epoch: "3" } } },
  ];

  for (const data of cases) {
    const history = readOne("mstar:phase2", data);
    const record = history.records[0]!;
    expect(history.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["payload-record-invalid"]);
    expect(record.view).toBeNull();
    expect(record.sessionId).toBeNull();
    // The refusal keeps the payload in full, digest included — nothing is dropped
    // or rewritten, and no binding is invented from it.
    expect(record.payload).toEqual(data);
    expect(record.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(exportExecutionHostHistory(history)).toContain('"code":"payload-record-invalid"');
  }
});

test("a v1 bind keeps decoding exactly as today, with no binding and generation 1", () => {
  const history = readExecutionHostHistory([customEntry("w1", "mstar:phase2", BIND_PAYLOAD)]);
  const record = history.records[0]!;

  expect(history.diagnostics).toEqual([]);
  expect(record.sessionId).toBe("sess-a");
  expect(record.payload).toEqual(BIND_PAYLOAD);
  expect(record.payloadHash).toMatch(/^[0-9a-f]{64}$/);

  const view = viewOf(history, 0);
  expect(view.generation).toBe(1);
  expect(view.declaredKind).toBe("bind");
  expect(view.executionBinding).toBeNull();
  // The legacy envelope's path is still retained as provenance, verbatim.
  expect(view.provenance).toEqual([{ field: "coordinatorSessionPath", path: "/old/elsewhere/coord.json" }]);
  // The v2 generation adds the one nullable field; nothing else appears beside it.
  for (const forbidden of ["binding", "authority", "credential", "token"]) {
    expect(Object.keys(view)).not.toContain(forbidden);
  }
});

test("checkpoint identity, dedup, cancellation and one-shot handoff state are preserved", () => {
  const history = readExecutionHostHistory([
    customEntry("k1", "mstar:phase2", CHECKPOINT_PAYLOAD),
    customEntry("k2", "mstar:phase2", { version: 1, kind: "user-turn", hostSessionId: "sess-a", workflowId: "wf-1" }),
    customEntry("k3", "mstar:model-handoff", HANDOFF_PAYLOAD),
    customEntry("k4", "mstar:model-handoff", PENDING_HANDOFF_PAYLOAD),
  ]);

  expect(history.diagnostics).toEqual([]);
  expect(viewOf(history, 0).generation).toBe(1);
  expect(viewOf(history, 0).workflowId).toBe("wf-1");
  expect(viewOf(history, 0).checkpointId).toBe("obs-7");
  expect(viewOf(history, 0).dedupKey).toBe("obs-7");
  expect(viewOf(history, 1).declaredKind).toBe("user-turn");
  expect(viewOf(history, 1).dedupKey).toBeNull();
  expect(viewOf(history, 2).declaredState).toBe("cancelled");
  expect(viewOf(history, 2).declaredAction).toBe("handoff");
  expect(viewOf(history, 2).cancelled).toBe(true);
  expect(viewOf(history, 2).dedupKey).toBe("op-9");
  expect(viewOf(history, 3).declaredState).toBe("pending");
  expect(viewOf(history, 3).declaredAction).toBe("arm");
  expect(viewOf(history, 3).cancelled).toBe(false);
  expect(history.records[3]!.payload).toMatchObject({ baselineModelChangeId: "mc-1" });
});

/* ----------------------------------------------------- guard mirror tables --- */

test("the phase-2 restore guard is mirrored: a record the producer rejects gets no view", () => {
  const cases: ReadonlyArray<Readonly<{ data: Record<string, unknown>; code: string }>> = [
    { data: { version: 1, kind: "bind", hostSessionId: "s" }, code: "payload-record-invalid" },
    { data: { version: 1, kind: "bind", hostSessionId: "s", workflowId: "w" }, code: "payload-record-invalid" },
    { data: { ...BIND_PAYLOAD, coordinatorSessionId: "" }, code: "payload-record-invalid" },
    { data: { ...CHECKPOINT_PAYLOAD, reason: "sometimes" }, code: "payload-record-invalid" },
    { data: { ...CHECKPOINT_PAYLOAD, decision: "maybe" }, code: "payload-record-invalid" },
    { data: { ...CHECKPOINT_PAYLOAD, note: 7 }, code: "payload-record-invalid" },
    { data: { ...CHECKPOINT_PAYLOAD, observationKey: "" }, code: "payload-record-invalid" },
    { data: { version: 1, kind: "reminder", hostSessionId: "s", workflowId: "w" }, code: "payload-record-invalid" },
    { data: { ...BIND_PAYLOAD, kind: "resume" }, code: "payload-kind-invalid" },
  ];

  for (const { data, code } of cases) {
    const history = readOne("mstar:phase2", data);
    expect(history.records).toHaveLength(1);
    expect(history.records[0]!.view).toBeNull();
    expect(history.records[0]!.sessionId).toBeNull();
    expect(history.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([code]);
    expect(history.records[0]!.payload).toEqual(data);
    expect(exportExecutionHostHistory(history)).toContain(`"code":"${code}"`);
  }
});

test("the model-handoff restore guard is mirrored: a record the producer rejects gets no view", () => {
  const cases: ReadonlyArray<Readonly<{ data: Record<string, unknown>; code: string }>> = [
    { data: { ...HANDOFF_PAYLOAD, binding: { sessionId: "s" } }, code: "payload-record-invalid" },
    { data: { ...HANDOFF_PAYLOAD, binding: "none" }, code: "payload-record-invalid" },
    { data: { ...HANDOFF_PAYLOAD, binding: { sessionId: "", workflowId: "w" } }, code: "payload-record-invalid" },
    { data: { ...HANDOFF_PAYLOAD, state: "armed" }, code: "payload-state-invalid" },
    { data: { ...HANDOFF_PAYLOAD, action: "switch" }, code: "payload-action-invalid" },
    { data: { ...HANDOFF_PAYLOAD, operationId: 7 }, code: "payload-record-invalid" },
    { data: { ...HANDOFF_PAYLOAD, observedModel: 7 }, code: "payload-record-invalid" },
    { data: { ...HANDOFF_PAYLOAD, reason: 7 }, code: "payload-record-invalid" },
  ];

  for (const { data, code } of cases) {
    const history = readOne("mstar:model-handoff", data);
    expect(history.records).toHaveLength(1);
    expect(history.records[0]!.view).toBeNull();
    expect(history.records[0]!.sessionId).toBeNull();
    expect(history.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([code]);
    expect(history.records[0]!.payload).toEqual(data);
  }
});

/* --------------------------------------------------- malformed diagnostics --- */

test("malformed recognized entries are diagnosed and retained, never guessed", () => {
  const entries: ReadonlyArray<Readonly<{ entry: Readonly<Record<string, unknown>>; code: string }>> = [
    { entry: customEntry("m1", "mstar:phase2", "phase2"), code: "payload-not-object" },
    { entry: customEntry("", "mstar:phase2", BIND_PAYLOAD), code: "entry-id-missing" },
    { entry: { id: "m3", type: "message", customType: "mstar:phase2", data: BIND_PAYLOAD }, code: "entry-shape" },
    { entry: customEntry("m4", "mstar:phase2", { ...BIND_PAYLOAD, extra: undefined }), code: "payload-unsupported" },
  ];

  for (const { entry, code } of entries) {
    const history = readExecutionHostHistory([entry]);
    expect(history.records).toHaveLength(1);
    expect(history.records[0]!.view).toBeNull();
    expect(history.records[0]!.sessionId).toBeNull();
    expect(history.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([code]);
    expect(history.diagnostics[0]!.type).toBe(entry.customType);
    // Raw evidence is retained in full, whatever the diagnosis.
    expect(history.records[0]!.payload).toEqual(entry.data);
    if (code === "payload-unsupported") expect(history.records[0]!.payloadHash).toBeNull();
    else expect(history.records[0]!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  }
});

test("a payload the canonical form rejects is kept raw and the export refuses", () => {
  const data = { ...BIND_PAYLOAD, extra: undefined };
  const history = readExecutionHostHistory([customEntry("r1", "mstar:phase2", data)]);
  const record = history.records[0]!;

  // The very same value is retained — not a copy, not a null, and no digest is
  // fabricated for a payload the canonical form refused.
  expect(record.payload).toBe(data);
  expect(record.payloadHash).toBeNull();
  expect(record.view).toBeNull();
  expect(history.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["payload-unsupported"]);
  expect(history.diagnostics[0]!.message).toContain("canonical");

  const refusal = refusalOf(history);
  expect(refusal).toBeInstanceOf(ExecutionHostHistoryExportRefusal);
  if (!(refusal instanceof ExecutionHostHistoryExportRefusal)) throw new Error("the export did not refuse");
  expect(refusal.entryIds).toEqual(["r1"]);
  expect(refusal.message).toContain("r1");
});

test("an undecoded entry is never attributed to a session by adjacency", () => {
  const history = readExecutionHostHistory([
    customEntry("n1", "mstar:phase2-launch-reservation", { hostSessionId: "sess-a", operationId: "launch-3" }),
    customEntry("n2", "mstar:phase2", BIND_PAYLOAD),
  ]);

  expect(history.records[0]!.sessionId).toBeNull();
  expect(history.records[0]!.payload).toMatchObject({ hostSessionId: "sess-a" });
  expect(history.diagnostics.map((diagnostic) => [diagnostic.index, diagnostic.code])).toEqual([
    [0, "payload-generation-unverified"],
  ]);
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

  expect(ordered.diagnostics).toEqual([]);
  expect(ordered.records[0]!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  expect(shuffled.records[0]!.payloadHash).toBe(ordered.records[0]!.payloadHash);
  expect(exportExecutionHostHistory(shuffled)).toBe(exportExecutionHostHistory(ordered));
});
