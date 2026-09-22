/**
 * Execution host inventory — the §4.2 bounded evidence wrapper
 * (`packages/omp/src/execution-host-inventory.ts`).
 *
 * What these cases are about: ONE carrying session's own hidden history becomes
 * ONE canonical document bound to ONE workflow, with the exact H1 export digest,
 * so C3 can align an explicitly named session set against one document per named
 * session and recompute both facts instead of trusting a summary. The wrapper
 * decides nothing about quiescing, coverage or authority — the operator's own
 * `ActivationAttestation` stays the stop/adoption boundary, and the wrapper never
 * manufactures one.
 *
 * Fixture discipline: the ledger entries are the producer's own shapes — a
 * `mstar:phase2` record as the extension writes it, plus an unrelated custom
 * entry and a hidden type with no producer — and every expectation is derived
 * from H1's own reader/exporter rather than re-implemented here, so a drift in
 * either the reader or this wrapper is visible.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  EXECUTION_HOST_HISTORY_TYPES,
  exportExecutionHostHistory,
  readExecutionHostHistory,
} from "../src/execution-history";
import {
  HOST_INVENTORY_HOST,
  HOST_INVENTORY_PROTOCOL,
  HOST_INVENTORY_VERSION,
  buildExecutionHostInventory,
  exportExecutionHostInventory,
  historyExportDigest,
  inventoryDigest,
} from "../src/execution-host-inventory";

const WORKFLOW_ID = "wf-inventory";
const HOST_SESSION_ID = "native-session-inventory";
const OTHER_WORKFLOW_ID = "wf-elsewhere";

/** The §3.1 binding value an active bind record persists. */
const EXECUTION_BINDING = {
  version: 1,
  harnessRoot: "/repo/main/.mstar",
  session: {
    storeId: "3f2a1b0c-1111-4222-8333-444455556666",
    epoch: 7,
    workflowId: WORKFLOW_ID,
    role: "coordinator",
    sessionId: HOST_SESSION_ID,
    planId: null,
  },
} as const;

function phase2Bind(workflowId: string = WORKFLOW_ID): Record<string, unknown> {
  return { type: "custom", id: "entry-bind", customType: "mstar:phase2", data: { version: 2, kind: "bind", workflowId, hostSessionId: HOST_SESSION_ID, executionBinding: EXECUTION_BINDING } };
}

function checkpoint(workflowId: string): Record<string, unknown> {
  return {
    type: "custom",
    id: "entry-checkpoint",
    customType: "mstar:phase2",
    data: {
      version: 1,
      kind: "checkpoint",
      hostSessionId: HOST_SESSION_ID,
      workflowId,
      reason: "capacity-changed",
      decision: "wait",
      note: "one plan primary is still pending",
      observationKey: "obs-1",
    },
  };
}

/** A message entry and an unrelated custom type: neither belongs to this history. */
const UNRELATED = [
  { type: "message", id: "entry-message", data: "hello" },
  { type: "custom", id: "entry-other", customType: "mstar:something-else", data: { version: 1 } },
];

/** A recognized hidden type whose producer this repository does not have. */
const UNVERIFIED = { type: "custom", id: "entry-continuation", customType: "mstar:phase2-continuation", data: { version: 1, note: "no producer" } };

describe("execution host inventory — one session, one workflow, one export", () => {
  test("the document binds the session and workflow to H1's own export value", () => {
    const entries = [phase2Bind(), ...UNRELATED, checkpoint(WORKFLOW_ID)];
    const inventory = buildExecutionHostInventory({ workflowId: WORKFLOW_ID, hostSessionId: HOST_SESSION_ID, entries });

    expect(inventory.version).toBe(HOST_INVENTORY_VERSION);
    expect(inventory.protocol).toBe(HOST_INVENTORY_PROTOCOL);
    expect(inventory.host).toBe(HOST_INVENTORY_HOST);
    expect(inventory.workflowId).toBe(WORKFLOW_ID);
    expect(inventory.hostSessionId).toBe(HOST_SESSION_ID);

    // The embedded document IS H1's read of the same entries — not a second
    // summary of it, and not a filtered subset.
    expect(inventory.export.document).toEqual(readExecutionHostHistory(entries));

    // Only the five frozen hidden types are in scope; unrelated custom entries
    // are not this history's business.
    expect(inventory.export.document.records.map((record) => record.entryId)).toEqual(["entry-bind", "entry-checkpoint"]);
  });

  test("the digest names the exact H1 export bytes, and the envelope is canonical with one LF", () => {
    const inventory = buildExecutionHostInventory({
      workflowId: WORKFLOW_ID,
      hostSessionId: HOST_SESSION_ID,
      entries: [phase2Bind()],
    });

    const exportBytes = exportExecutionHostHistory(inventory.export.document);
    expect(inventory.export.sha256).toBe(createHash("sha256").update(exportBytes, "utf8").digest("hex"));
    expect(inventory.export.sha256).toBe(historyExportDigest(inventory.export.document));

    const envelope = exportExecutionHostInventory(inventory);
    expect(envelope.endsWith("\n")).toBe(true);
    expect(envelope.trimEnd().includes("\n")).toBe(false);
    expect(JSON.parse(envelope)).toEqual(inventory);
    expect(inventoryDigest(inventory)).toBe(createHash("sha256").update(envelope, "utf8").digest("hex"));
  });

  test("an undecodable hidden entry is retained with its digest and diagnosed, never guessed", () => {
    const inventory = buildExecutionHostInventory({
      workflowId: WORKFLOW_ID,
      hostSessionId: HOST_SESSION_ID,
      entries: [phase2Bind(), UNVERIFIED],
    });

    const retained = inventory.export.document.records.find((record) => record.type === "mstar:phase2-continuation");
    expect(retained?.payloadHash).not.toBeNull();
    expect(retained?.view).toBeNull();
    expect(retained?.sessionId).toBeNull();
    expect(inventory.export.document.diagnostics.map((entry) => entry.code)).toEqual(["payload-generation-unverified"]);
    // The document is still exportable: an honest diagnosis is not a refusal.
    expect(() => exportExecutionHostInventory(inventory)).not.toThrow();
  });

  test("a decoded record declaring another workflow refuses the whole document", () => {
    // History is never filtered to fit the assignment, and a mismatching
    // identity inside the source bytes is not upgraded into coverage.
    expect(() => buildExecutionHostInventory({ workflowId: WORKFLOW_ID, hostSessionId: HOST_SESSION_ID, entries: [phase2Bind(), checkpoint(OTHER_WORKFLOW_ID)] })).toThrow(
      /declares workflow/,
    );
  });

  test("a blank identity refuses instead of synthesizing one", () => {
    expect(() => buildExecutionHostInventory({ workflowId: "  ", hostSessionId: HOST_SESSION_ID, entries: [] })).toThrow(/non-empty workflow id/);
    expect(() => buildExecutionHostInventory({ workflowId: WORKFLOW_ID, hostSessionId: "", entries: [] })).toThrow(/no native session id/);
    expect(() => buildExecutionHostInventory({ workflowId: WORKFLOW_ID, hostSessionId: HOST_SESSION_ID, entries: undefined as unknown as readonly unknown[] })).toThrow(
      /own ledger entries/,
    );
  });

  test("an empty ledger is still a bounded, exportable inventory", () => {
    const inventory = buildExecutionHostInventory({ workflowId: WORKFLOW_ID, hostSessionId: HOST_SESSION_ID, entries: [] });
    expect(inventory.export.document.records).toEqual([]);
    expect(inventory.export.document.diagnostics).toEqual([]);
    expect(EXECUTION_HOST_HISTORY_TYPES.includes("mstar:phase2")).toBe(true);
  });
});
