import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptTerminalWorkflow, initializeExecutionAuthority, readExecutionState, type ExecutionContext } from "./execution-store.js";
import type { ActivationAttestation } from "./store-activation.js";
import { initializeStore, openStore, type StoreContext } from "./store-db.js";
import { queryDashboard, withStoreRead } from "./store-read.js";
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** One isolated stranded-terminal fixture: the store, its caller and the live authority epoch. */
type StrandedFixture = {
  context: StoreContext;
  caller: ExecutionContext["caller"];
  epoch: number;
};

async function strandedTerminal(): Promise<StrandedFixture> {
  const harnessDir = mkdtempSync(join(tmpdir(), "mstar-terminal-adoption-"));
  roots.push(harnessDir);
  const context = { harnessDir };
  const store = await initializeStore(context);
  store.close();
  const authority = await initializeExecutionAuthority(context);
  const handle = await openStore(context, "write");
  try {
    handle.db.prepare(
      "insert into execution_workflows(workflow_id, revision, creator_session_id, state_json, created_at, updated_at) values (?, 1, null, ?, ?, ?)",
    ).run("wf-stranded", JSON.stringify({
      id: "wf-stranded", schema_version: 1, type: "plan", status: "stopped",
      started_at: "2026-10-01T00:00:00.000Z", ended_at: "2026-10-01T01:00:00.000Z",
      updated_at: "2026-10-01T01:00:00.000Z", stop_reason: "fixture terminal stop",
    }), "2026-10-01T00:00:00.000Z", "2026-10-01T01:00:00.000Z");
  } finally { handle.close(); }
  return { context, caller: { sessionId: "adopter-session", role: "coordinator", workflowId: "wf-stranded" }, epoch: authority.epoch };
}

/** The machine facts of one refused adoption: code plus the structured details. */
async function refusalOf(run: () => Promise<unknown>): Promise<{ message: string; code?: unknown; details?: unknown }> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) {
      return {
        message: error.message,
        ...("code" in error ? { code: error.code } : {}),
        ...("details" in error ? { details: error.details } : {}),
      };
    }
    return { message: String(error) };
  }
  throw new Error("expected the adoption to refuse");
}

/** The scoped database state and revision snapshot used by no-mutation assertions. */
async function footprint(context: StoreContext) {
  const db = await openStore(context, "read");
  try {
    return {
      headers: db.db.prepare("select workflow_id, revision, state_json, updated_at from execution_workflows order by workflow_id").all(),
      sessions: db.db.prepare("select workflow_id, role, session_id, epoch, revision, state, bound_at from execution_sessions order by workflow_id, session_id").all(),
      meta: db.db.prepare("select revision, root_updated_at from execution_meta where id = 1").get(),
      store: db.db.prepare("select revision from store_meta where id = 1").get(),
      operations: (db.db.prepare("select count(*) as n from execution_operations").get() as { n: number }).n,
    };
  } finally { db.close(); }
}

describe("terminal workflow adoption", () => {
  test("CAS-records adoption, preserves terminal state and registry absence, and replays idempotently", async () => {
    const { context, caller } = await strandedTerminal();
    const execution = { harnessDir: context.harnessDir, caller };
    const request = { workflowId: "wf-stranded", expectedRevision: 1, reason: "close the imported terminal record", operationId: "adopt-op-1" };
    const applied = await adoptTerminalWorkflow(execution, request);
    expect(applied.replayed).toBe(false);
    expect(applied.data.terminalUnregistered).toBeUndefined();
    expect(applied.data.terminalAdoptions).toEqual([{
      id: "wf-stranded", status: "stopped", revision: 2,
      lifecycle_adopted_at: expect.any(String), adopt_reason: request.reason,
      actor_session_id: caller.sessionId, operation_id: request.operationId,
    }]);
    const db = await openStore(context, "read");
    try {
      expect((db.db.prepare("select count(*) as n from execution_registry where workflow_id = ?").get("wf-stranded") as { n: number }).n).toBe(0);
      expect(db.db.prepare("select revision, json_extract(state_json, '$.status') as status, json_extract(state_json, '$.stop_reason') as stop_reason from execution_workflows where workflow_id = ?").get("wf-stranded")).toEqual({
        revision: 2, status: "stopped", stop_reason: "fixture terminal stop",
      });
      expect((db.db.prepare("select count(*) as n from execution_operations where operation_id = ?").get(request.operationId) as { n: number }).n).toBe(1);
    } finally { db.close(); }
    const replay = await adoptTerminalWorkflow(execution, request);
    expect(replay.replayed).toBe(true);
    expect(replay.data.terminalAdoptions).toEqual(applied.data.terminalAdoptions);
    expect((await readExecutionState(context)).data.terminalAdoptions).toEqual(applied.data.terminalAdoptions);
    const dashboard = await withStoreRead(context, queryDashboard("workflows"));
    expect(dashboard.data.terminalUnregistered).toBeUndefined();
    expect(dashboard.data.terminalAdoptions).toEqual(applied.data.terminalAdoptions);
  });

  test("refuses stale CAS, registered rows, active-session rows, non-terminal headers, and headers missing both reason keys", async () => {
    const stale = await strandedTerminal();
    const staleBefore = await footprint(stale.context);
    await expect(adoptTerminalWorkflow({ harnessDir: stale.context.harnessDir, caller: stale.caller }, {
      workflowId: stale.caller.workflowId, expectedRevision: 2, reason: "stale", operationId: "adopt-stale",
    })).rejects.toMatchObject({ code: "execution.header-revision-conflict" });
    await expect(footprint(stale.context)).resolves.toEqual(staleBefore);

    const registered = await strandedTerminal();
    const registry = await openStore(registered.context, "write");
    registry.db.prepare("insert into execution_registry(workflow_id, entry_json) values (?, ?)")
      .run("wf-stranded", JSON.stringify({ id: "wf-stranded", type: "plan", started_at: "2026-10-01T00:00:00.000Z", dir: "workflows/wf-stranded" }));
    registry.close();
    const registeredBefore = await footprint(registered.context);
    await expect(adoptTerminalWorkflow({ harnessDir: registered.context.harnessDir, caller: registered.caller }, {
      workflowId: registered.caller.workflowId, expectedRevision: 1, reason: "registered", operationId: "adopt-registered",
    })).rejects.toMatchObject({ code: "execution.adoption-refused" });
    await expect(footprint(registered.context)).resolves.toEqual(registeredBefore);

    const active = await strandedTerminal();
    const session = await openStore(active.context, "write");
    session.db.prepare("insert into execution_sessions(workflow_id, role, session_id, epoch, revision, state, bound_at) values (?, 'coordinator', ?, ?, 1, 'active', ?)")
      .run("wf-stranded", "active-holder", active.epoch, "2026-10-01T00:00:00.000Z");
    session.close();
    // The touched refusal now names the supported optional-attestation recovery
    // instead of the retired dead end, so the pin asserts the machine facts
    // (code plus the exact addressed holder) rather than the wording.
    const activeError = await refusalOf(() => adoptTerminalWorkflow({ harnessDir: active.context.harnessDir, caller: active.caller }, {
      workflowId: active.caller.workflowId, expectedRevision: 1, reason: "active", operationId: "adopt-active",
    }));
    expect(activeError).toMatchObject({
      code: "execution.adoption-refused",
      details: { active_holder_sessions: ["active-holder"], adoption_refusal: "active-session-proof-required" },
    });

    const nonterminal = await strandedTerminal();
    const running = await openStore(nonterminal.context, "write");
    running.db.prepare("update execution_workflows set state_json = ? where workflow_id = ?")
      .run(JSON.stringify({ id: "wf-stranded", schema_version: 1, type: "plan", status: "running", started_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T01:00:00.000Z" }), "wf-stranded");
    running.close();
    await expect(adoptTerminalWorkflow({ harnessDir: nonterminal.context.harnessDir, caller: nonterminal.caller }, {
      workflowId: nonterminal.caller.workflowId, expectedRevision: 1, reason: "running", operationId: "adopt-running",
    })).rejects.toMatchObject({
      code: "execution.adoption-refused",
    });

    const missingReason = await strandedTerminal();
    const failed = await openStore(missingReason.context, "write");
    failed.db.prepare("update execution_workflows set state_json = ? where workflow_id = ?")
      .run(JSON.stringify({ id: "wf-stranded", schema_version: 1, type: "plan", status: "failed", started_at: "2026-10-01T00:00:00.000Z", ended_at: "2026-10-01T01:00:00.000Z", updated_at: "2026-10-01T01:00:00.000Z" }), "wf-stranded");
    failed.close();
    const missingHeader = await openStore(missingReason.context, "read");
    try {
      expect(missingHeader.db.prepare(
        "select json_extract(state_json, '$.stop_reason') as stop_reason, json_extract(state_json, '$.reason') as reason from execution_workflows where workflow_id = ?",
      ).get("wf-stranded")).toEqual({ stop_reason: null, reason: null });
    } finally { missingHeader.close(); }
    await expect(adoptTerminalWorkflow({ harnessDir: missingReason.context.harnessDir, caller: missingReason.caller }, {
      workflowId: missingReason.caller.workflowId, expectedRevision: 1, reason: "failed", operationId: "adopt-failed",
    })).rejects.toMatchObject({
      code: "execution.adoption-refused",
    });
  });
});

/**
 * The settled-terminal-adoption consumer regressions: an ACTIVE current-epoch
 * coordinator row is settled only against the operator's stop attestation,
 * atomically with the adoption write, and every refusal preserves the scoped
 * database snapshot captured by the footprint helper below.
 */
describe("terminal adoption session settlement", () => {
  /** The operator stop document the engine validates: declared fields only. */
  function attestation(stoppedSessionIds: readonly string[]): ActivationAttestation {
    return {
      version: 1,
      attestedAt: "2026-10-08T00:00:00.000Z",
      operator: { actor: "recovery-operator", authorizationRef: "operator-authorization-fixture" },
      consumers: [{
        entryId: "mstar-cli", kind: "coordinator", entrypoint: "packages/cli/src/index.ts",
        runtime: "bun", runtimeVersion: "99.0.0", version: "0.0.0-test", current: true, disposition: "reloaded",
      }],
      stoppedSessions: stoppedSessionIds.map((sessionId) => ({ sessionId, host: "fixture-host", state: "stopped" as const })),
    };
  }

  /**
   * A variant of the valid document — a changed proof instant or a deliberately
   * corrupted field — for the validator and conflict refusals these tests
   * exercise. The cast is the test's document boundary: the engine revalidates
   * whatever crosses it.
   */
  function attestationVariant(changes: Record<string, unknown>): ActivationAttestation {
    return { ...attestation(["active-holder"]), ...changes } as ActivationAttestation;
  }

  async function strandedWithHolder(sessionId: string): Promise<StrandedFixture> {
    const stranded = await strandedTerminal();
    const writer = await openStore(stranded.context, "write");
    try {
      writer.db.prepare(
        "insert into execution_sessions(workflow_id, role, session_id, epoch, revision, state, bound_at) values (?, 'coordinator', ?, ?, 1, 'active', ?)",
      ).run("wf-stranded", sessionId, stranded.epoch, "2026-10-01T00:00:00.000Z");
    } finally { writer.close(); }
    return stranded;
  }

  /** The settled-adoption call: the fixture fixes workflow, reason and operation id. */
  function adopt(stranded: StrandedFixture, input: { attestation?: ActivationAttestation; expectedRevision?: number }) {
    return adoptTerminalWorkflow(
      { harnessDir: stranded.context.harnessDir, caller: stranded.caller },
      {
        workflowId: stranded.caller.workflowId,
        ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
        reason: "settle the stranded holder",
        operationId: "adopt-settle-1",
        ...(input.attestation === undefined ? {} : { attestation: input.attestation }),
      },
    );
  }

  test("settles the exact attested ACTIVE holder atomically and records the settlement provenance", async () => {
    const stranded = await strandedWithHolder("active-holder");
    const proof = attestation(["active-holder"]);
    const applied = await adopt(stranded, { attestation: proof });
    expect(applied.replayed).toBe(false);
    // The settled targets and the approving operator travel on the receipt.
    expect(applied.recovery).toMatchObject({
      outcome: "applied",
      target: { workflowId: "wf-stranded" },
      applied: ["execution_sessions(wf-stranded, coordinator, active-holder) revoked"],
      resolvedFrom: [
        { path: "attestation.operator", source: "recovery-operator (operator-authorization-fixture)" },
        { path: "attestation.attestedAt", source: "2026-10-08T00:00:00.000Z" },
      ],
      commitState: "committed",
    });
    expect(applied.data.terminalAdoptions).toEqual([{
      id: "wf-stranded", status: "stopped", revision: 2,
      lifecycle_adopted_at: expect.any(String), adopt_reason: "settle the stranded holder",
      actor_session_id: stranded.caller.sessionId, operation_id: "adopt-settle-1",
    }]);
    const db = await openStore(stranded.context, "read");
    try {
      expect(db.db.prepare("select state, revision from execution_sessions where workflow_id = ? and session_id = ?").get("wf-stranded", "active-holder"))
        .toEqual({ state: "revoked", revision: 2 });
      expect((db.db.prepare("select count(*) as n from execution_registry where workflow_id = ?").get("wf-stranded") as { n: number }).n).toBe(0);
      expect((db.db.prepare("select count(*) as n from execution_operations where operation_id = ?").get("adopt-settle-1") as { n: number }).n).toBe(1);
    } finally { db.close(); }
  });

  test("replays the identical settlement and conflicts on changed proof under the same operation id", async () => {
    const stranded = await strandedWithHolder("active-holder");
    const proof = attestation(["active-holder"]);
    const applied = await adopt(stranded, { attestation: proof });
    const replay = await adopt(stranded, { attestation: proof });
    expect(replay.replayed).toBe(true);
    expect(applied).toHaveProperty("recovery", expect.objectContaining({ outcome: "applied" }));
    expect(applied).not.toHaveProperty("operationRecovery");
    expect(replay).not.toHaveProperty("operationRecovery");
    expect({ ...replay, replayed: false }).toEqual(applied);
    const db = await openStore(stranded.context, "read");
    try {
      // A replay never revokes twice: the settled row keeps its committed revision.
      expect(db.db.prepare("select state, revision from execution_sessions where session_id = ?").get("active-holder"))
        .toEqual({ state: "revoked", revision: 2 });
      const stored = db.db.prepare("select result_json from execution_operations where operation_id = ?")
        .get("adopt-settle-1") as { result_json: string };
      const storedReceipt = z.record(z.string(), z.unknown()).parse(JSON.parse(stored.result_json));
      expect(storedReceipt).toHaveProperty("operationRecovery", expect.objectContaining({ outcome: "applied" }));
      expect(storedReceipt).not.toHaveProperty("recovery");
    } finally { db.close(); }

    const beforeChangedProof = await footprint(stranded.context);
    const changed = await refusalOf(() => adopt(stranded, {
      attestation: attestationVariant({ attestedAt: "2026-10-08T09:00:00.000Z" }),
    }));
    expect(changed).toMatchObject({ code: "execution.operation-conflict" });
    await expect(footprint(stranded.context)).resolves.toEqual(beforeChangedProof);
  });

  test("refuses a holder with no proof, an incomplete proof and stale CAS without any mutation footprint", async () => {
    const unproven = await strandedWithHolder("active-holder");
    const before = await footprint(unproven.context);
    const missingProof = await refusalOf(() => adopt(unproven, {}));
    expect(missingProof).toMatchObject({
      code: "execution.adoption-refused",
      details: { active_holder_sessions: ["active-holder"], adoption_refusal: "active-session-proof-required" },
    });
    expect(missingProof.message).toContain("active-holder");
    const staleCas = await refusalOf(() => adopt(unproven, { expectedRevision: 2, attestation: attestation(["active-holder"]) }));
    expect(staleCas).toMatchObject({ code: "execution.header-revision-conflict" });
    await expect(footprint(unproven.context)).resolves.toEqual(before);

    const wrongHolder = await strandedWithHolder("active-holder");
    const wrongBefore = await footprint(wrongHolder.context);
    const incomplete = await refusalOf(() => adopt(wrongHolder, { attestation: attestation(["foreign-session"]) }));
    expect(incomplete).toMatchObject({
      code: "execution.adoption-refused",
      details: {
        active_holder_sessions: ["active-holder"],
        unattested_sessions: ["active-holder"],
        adoption_refusal: "active-session-proof-incomplete",
      },
    });
    await expect(footprint(wrongHolder.context)).resolves.toEqual(wrongBefore);
  });

  test("refuses a malformed or credential-bearing document before any store access", async () => {
    const stranded = await strandedWithHolder("active-holder");
    const before = await footprint(stranded.context);
    const wrongVersion = await refusalOf(() => adopt(stranded, { attestation: attestationVariant({ version: 2 }) }));
    expect(wrongVersion).toMatchObject({ code: "store.attestation-invalid" });
    const credential = await refusalOf(() => adopt(stranded, {
      attestation: attestationVariant({ token: "fixture-credential-value" }),
    }));
    expect(credential).toMatchObject({ code: "store.attestation-invalid" });
    expect(JSON.stringify(credential)).not.toContain("fixture-credential-value");
    await expect(footprint(stranded.context)).resolves.toEqual(before);
  });

  test("refuses self-settlement of the invoking identity", async () => {
    const stranded = await strandedWithHolder("adopter-session");
    const before = await footprint(stranded.context);
    const refused = await refusalOf(() => adopt(stranded, { attestation: attestation(["adopter-session"]) }));
    expect(refused).toMatchObject({
      code: "execution.adoption-refused",
      details: { caller_session_id: "adopter-session", adoption_refusal: "self-settlement" },
    });
    await expect(footprint(stranded.context)).resolves.toEqual(before);
  });

  test("keeps the ordinary no-ACTIVE adoption unchanged and records a supplied-but-unneeded proof honestly", async () => {
    const ordinary = await strandedTerminal();
    const applied = await adopt(ordinary, {});
    expect(applied.replayed).toBe(false);
    expect(applied.recovery).toBeUndefined();
    const recorded = (await readExecutionState(ordinary.context)).data.terminalAdoptions ?? [];
    expect(recorded).toHaveLength(1);

    const unneeded = await strandedTerminal();
    const supplied = await adopt(unneeded, { attestation: attestation([]) });
    const unneededReplay = await adopt(unneeded, { attestation: attestation([]) });
    expect(supplied).not.toHaveProperty("operationRecovery");
    expect(unneededReplay).not.toHaveProperty("operationRecovery");
    expect({ ...unneededReplay, replayed: false }).toEqual(supplied);
    expect(supplied.replayed).toBe(false);
    // A valid document naming nothing ACTIVE is never silently dropped: the
    // receipt records that no settlement was required.
    expect(supplied.recovery).toMatchObject({
      outcome: "already-satisfied",
      applied: [],
      warnings: [{ code: "execution.adoption.nothing-to-settle" }],
    });
  });

  test("settles only the addressed workflow's rows and never a foreign workflow's ACTIVE holder", async () => {
    const stranded = await strandedWithHolder("active-holder");
    const writer = await openStore(stranded.context, "write");
    try {
      writer.db.prepare(
        "insert into execution_workflows(workflow_id, revision, creator_session_id, state_json, created_at, updated_at) values (?, 1, null, ?, ?, ?)",
      ).run("wf-foreign", JSON.stringify({
        id: "wf-foreign", schema_version: 1, type: "plan", status: "stopped",
        started_at: "2026-10-01T00:00:00.000Z", ended_at: "2026-10-01T01:00:00.000Z",
        updated_at: "2026-10-01T01:00:00.000Z", stop_reason: "fixture foreign stop",
      }), "2026-10-01T00:00:00.000Z", "2026-10-01T01:00:00.000Z");
      writer.db.prepare(
        "insert into execution_sessions(workflow_id, role, session_id, epoch, revision, state, bound_at) values (?, 'coordinator', ?, ?, 1, 'active', ?)",
      ).run("wf-foreign", "foreign-holder", stranded.epoch, "2026-10-01T00:00:00.000Z");
    } finally { writer.close(); }

    const before = await footprint(stranded.context);
    // Partial proof (the foreign holder only) refuses and settles neither row.
    const partial = await refusalOf(() => adopt(stranded, { attestation: attestation(["foreign-holder"]) }));
    expect(partial).toMatchObject({
      code: "execution.adoption-refused",
      details: { adoption_refusal: "active-session-proof-incomplete", unattested_sessions: ["active-holder"] },
    });
    await expect(footprint(stranded.context)).resolves.toEqual(before);

    const applied = await adopt(stranded, { attestation: attestation(["active-holder"]) });
    expect(applied.replayed).toBe(false);
    const db = await openStore(stranded.context, "read");
    try {
      expect(db.db.prepare("select state from execution_sessions where workflow_id = ? and session_id = ?").get("wf-stranded", "active-holder"))
        .toEqual({ state: "revoked" });
      expect(db.db.prepare("select state, revision from execution_sessions where workflow_id = ? and session_id = ?").get("wf-foreign", "foreign-holder"))
        .toEqual({ state: "active", revision: 1 });
      expect(db.db.prepare("select revision from execution_workflows where workflow_id = ?").get("wf-foreign"))
        .toEqual({ revision: 1 });
    } finally { db.close(); }
  });
});
