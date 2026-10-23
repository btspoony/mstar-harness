import { afterAll, describe, expect, test } from "bun:test";
import { readDeclaredNodeFloor } from "./core.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptTerminalWorkflow, readExecutionState, type ExecutionContext } from "./execution-store.js";
import type { ActivationAttestation } from "./store-activation.js";
import { initializeStore, openStore, type StoreContext } from "./store-db.js";
import { queryDashboard, withStoreRead } from "./store-read.js";

/** Injected current runtime for a `node` consumer: at/above the declared floor. */
const atOrAboveRuntime = (() => {
  const floor = readDeclaredNodeFloor() ?? "0.0.0";
  return `${Number.parseInt(floor.split(".")[0]!, 10) + 1}.0.0`;
})();
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
  const authority = await readExecutionState(context);
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
  const receiptDb = await openStore(context, "write");
  try {
    const storeRow = receiptDb.db.prepare("select store_id from store_meta where id = 1").get();
    const storeIdValue = typeof storeRow === "object" && storeRow !== null && "store_id" in storeRow
      ? storeRow.store_id
      : undefined;
    if (typeof storeIdValue !== "string") throw new Error("fixture: missing store id");
    const insertReceipt = receiptDb.db.prepare(
      "insert into execution_operations(epoch, operation_id, request_hash, store_id, workflow_id, plan_id, result_json, committed_at) " +
        "values (?, ?, ?, ?, ?, null, '{}', ?)",
    );
    insertReceipt.run(authority.epoch, "prior-addressed-receipt", "fixture-hash", storeIdValue, "wf-stranded", "2026-10-01T00:30:00.000Z");
    insertReceipt.run(authority.epoch, "prior-sibling-receipt", "fixture-hash", storeIdValue, "wf-sibling", "2026-10-01T00:30:00.000Z");
  } finally { receiptDb.close(); }
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
  test("records adoption, prunes prior receipts, and replays the retained terminal receipt", async () => {
    const { context, caller } = await strandedTerminal();
    const execution = { harnessDir: context.harnessDir, caller };
    const request = { workflowId: "wf-stranded", expectedRevision: 1, reason: "close the imported terminal record", operationId: "adopt-op-1" };
    const prior = await openStore(context, "read");
    try {
      expect(prior.db.prepare("select workflow_id, operation_id from execution_operations order by operation_id").all()).toEqual([
        { workflow_id: "wf-stranded", operation_id: "prior-addressed-receipt" },
        { workflow_id: "wf-sibling", operation_id: "prior-sibling-receipt" },
      ]);
    } finally { prior.close(); }
    const applied = await adoptTerminalWorkflow(execution, request);
    expect(applied.replayed).toBe(false);
    expect(applied.data.terminalUnregistered).toBeUndefined();
    expect(applied.data.terminalAdoptions).toEqual([{
      id: "wf-stranded", status: "stopped", revision: 2, token: expect.any(String),
      lifecycle_adopted_at: expect.any(String), adopt_reason: request.reason,
      actor_session_id: caller.sessionId, operation_id: request.operationId,
    }]);
    const db = await openStore(context, "read");
    try {
      expect((db.db.prepare("select count(*) as n from execution_registry where workflow_id = ?").get("wf-stranded") as { n: number }).n).toBe(0);
      expect(db.db.prepare("select revision, json_extract(state_json, '$.status') as status, json_extract(state_json, '$.stop_reason') as stop_reason from execution_workflows where workflow_id = ?").get("wf-stranded")).toEqual({
        revision: 2, status: "stopped", stop_reason: "fixture terminal stop",
      });
      expect(db.db.prepare("select workflow_id, operation_id from execution_operations order by operation_id").all()).toEqual([
        { workflow_id: "wf-stranded", operation_id: request.operationId },
        { workflow_id: "wf-sibling", operation_id: "prior-sibling-receipt" },
      ]);
    } finally { db.close(); }
    // The explicit revision is stale after commit, but the retained receipt is
    // consulted first and returns the exact committed result.
    const retry = await adoptTerminalWorkflow(execution, request);
    expect(retry.replayed).toBe(true);
    expect(retry.data).toEqual(applied.data);
    const changedOperation = await refusalOf(() => adoptTerminalWorkflow(execution, {
      workflowId: request.workflowId, reason: request.reason, operationId: "adopt-op-different",
    }));
    expect(changedOperation.code).toBe("execution.adoption-refused");
    expect(changedOperation.message).toContain("already has a terminal-adoption record");
    expect((await readExecutionState(context)).data.terminalAdoptions).toEqual(applied.data.terminalAdoptions);
    const dashboard = await withStoreRead(context, queryDashboard("workflows"));
    expect(dashboard.data.terminalUnregistered).toBeUndefined();
    // The dashboard projection carries the adoption facts, not the CAS token.
    expect(dashboard.data.terminalAdoptions).toEqual(
      applied.data.terminalAdoptions?.map(({ token: _token, ...entry }) => entry),
    );
  });

  test("leaves an already-terminal header's own status and ended_at exactly untouched", async () => {
    // Exact equality on the pre-adoption values, not presence: an adoption that
    // unconditionally stamped `ended_at` (or forced `stopped`) would still pass a
    // `toMatchObject` check, so both values are captured before the call and
    // compared unchanged after it. `completed` is the fixture that catches an
    // unconditional rewrite to `stopped`.
    for (const terminal of ["stopped", "completed"] as const) {
      const { context, caller } = await strandedTerminal();
      const writer = await openStore(context, "write");
      try {
        writer.db.prepare("update execution_workflows set state_json = ? where workflow_id = ?")
          .run(JSON.stringify({
            id: "wf-stranded", schema_version: 1, type: "plan", status: terminal,
            started_at: "2026-10-01T00:00:00.000Z", ended_at: "2026-10-01T01:00:00.000Z",
            updated_at: "2026-10-01T01:00:00.000Z", stop_reason: "fixture terminal stop",
          }), "wf-stranded");
      } finally { writer.close(); }
      const recorded = async () => {
        const db = await openStore(context, "read");
        try {
          return db.db.prepare(
            "select json_extract(state_json, '$.status') as status, json_extract(state_json, '$.ended_at') as ended_at, " +
              "json_extract(state_json, '$.updated_at') as updated_at from execution_workflows where workflow_id = ?",
          ).get("wf-stranded");
        } finally { db.close(); }
      };
      const before = await recorded();
      expect(before).toEqual({
        status: terminal, ended_at: "2026-10-01T01:00:00.000Z", updated_at: "2026-10-01T01:00:00.000Z",
      });
      const applied = await adoptTerminalWorkflow({ harnessDir: context.harnessDir, caller }, {
        workflowId: "wf-stranded", expectedRevision: 1, reason: `adopt the ${terminal} record`, operationId: `adopt-terminal-${terminal}`,
      });
      expect(applied.replayed).toBe(false);
      expect(applied.data.terminalAdoptions).toEqual([{
        id: "wf-stranded", status: terminal, revision: 2, token: expect.any(String),
        lifecycle_adopted_at: expect.any(String), adopt_reason: `adopt the ${terminal} record`,
        actor_session_id: caller.sessionId, operation_id: `adopt-terminal-${terminal}`,
      }]);
      expect(await recorded()).toEqual(before);
    }
  });

  test("an adopted never-closed header carries the adoption instant in both ended_at and updated_at", async () => {
    // The adoption is the header's last recorded lifecycle change, so the close
    // instant and the snapshot's own `updated_at` must BOTH be the adoption
    // instant. A stale `updated_at` is the plain case; the second fixture adds
    // an `ended_at` a non-terminal snapshot may carry (the validator only
    // requires it to be present and non-empty), which an imported orphan can
    // hold from before later recorded activity.
    for (const stale of [
      { updated_at: "2026-10-01T01:00:00.000Z" },
      { updated_at: "2026-10-01T01:00:00.000Z", ended_at: "2026-10-01T00:30:00.000Z" },
    ]) {
      const { context, caller } = await strandedTerminal();
      const writer = await openStore(context, "write");
      try {
        writer.db.prepare("update execution_workflows set state_json = ?, updated_at = ? where workflow_id = ?")
          .run(JSON.stringify({
            id: "wf-stranded", schema_version: 1, type: "plan", status: "running",
            started_at: "2026-10-01T00:00:00.000Z", ...stale,
          }), stale.updated_at, "wf-stranded");
      } finally { writer.close(); }
      const before = new Date().toISOString();
      await adoptTerminalWorkflow({ harnessDir: context.harnessDir, caller }, {
        workflowId: "wf-stranded", expectedRevision: 1, reason: "adopt a never-closed header", operationId: "adopt-fresh-timestamps",
      });
      const after = new Date().toISOString();
      const db = await openStore(context, "read");
      try {
        const row = db.db.prepare(
          "select json_extract(state_json, '$.status') as status, json_extract(state_json, '$.ended_at') as ended_at, " +
            "json_extract(state_json, '$.updated_at') as updated_at from execution_workflows where workflow_id = ?",
        ).get("wf-stranded") as { status: string; ended_at: string; updated_at: string };
        expect(row.status).toBe("stopped");
        expect(row.ended_at).toBe(row.updated_at);
        // Bounded by the wall-clock window of the call, so "fresh" means this
        // adoption and not merely "not the stale fixture value".
        expect(row.ended_at >= before && row.ended_at <= after).toBe(true);
      } finally { db.close(); }
    }
  });

  test("refuses stale CAS, registered rows, and unattested active-session rows", async () => {
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
    // Registry membership, not the header's own status, is what makes this
    // unreachable-by-any-other-route row adoptable: it terminalizes in the
    // SAME transaction, so the retirement of the "no supported exit exists"
    // refusal is asserted as the committed effect it now has.
    const adopted = await adoptTerminalWorkflow({ harnessDir: nonterminal.context.harnessDir, caller: nonterminal.caller }, {
      workflowId: nonterminal.caller.workflowId, expectedRevision: 1, reason: "running", operationId: "adopt-running",
    });
    expect(adopted.data.terminalAdoptions).toEqual([{
      id: "wf-stranded", status: "stopped", revision: 2, token: expect.any(String),
      lifecycle_adopted_at: expect.any(String), adopt_reason: "running",
      actor_session_id: nonterminal.caller.sessionId, operation_id: "adopt-running",
    }]);
    const settled = await openStore(nonterminal.context, "read");
    try {
      expect(settled.db.prepare(
        "select revision, json_extract(state_json, '$.status') as status, json_extract(state_json, '$.ended_at') as ended_at from execution_workflows where workflow_id = ?",
      ).get("wf-stranded")).toMatchObject({ revision: 2, status: "stopped", ended_at: expect.any(String) });
    } finally { settled.close(); }
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
        runtime: "node", runtimeVersion: atOrAboveRuntime, version: "0.0.0-synthetic-b", current: true, disposition: "reloaded",
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
      id: "wf-stranded", status: "stopped", revision: 2, token: expect.any(String),
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

  test("settles a stopped header that carries no recorded stop reason", async () => {
    const stranded = await strandedWithHolder("active-holder");
    // The header's terminal reason is absent exactly as the engine's own
    // lifecycle writer leaves it: the adoption eligibility must not depend on
    // a field nothing writes, or a normally stopped workflow could never
    // settle its ACTIVE holder without a hand-edited row.
    const writer = await openStore(stranded.context, "write");
    try {
      writer.db.prepare("update execution_workflows set state_json = ? where workflow_id = ?")
        .run(JSON.stringify({
          id: "wf-stranded", schema_version: 1, type: "plan", status: "stopped",
          started_at: "2026-10-01T00:00:00.000Z", ended_at: "2026-10-01T01:00:00.000Z",
          updated_at: "2026-10-01T01:00:00.000Z",
        }), "wf-stranded");
      expect(writer.db.prepare(
        "select json_extract(state_json, '$.stop_reason') as stop_reason, json_extract(state_json, '$.reason') as reason from execution_workflows where workflow_id = ?",
      ).get("wf-stranded")).toEqual({ stop_reason: null, reason: null });
    } finally { writer.close(); }
    const applied = await adopt(stranded, { attestation: attestation(["active-holder"]) });
    expect(applied.replayed).toBe(false);
    expect(applied.data.terminalAdoptions).toEqual([{
      id: "wf-stranded", status: "stopped", revision: 2, token: expect.any(String),
      lifecycle_adopted_at: expect.any(String), adopt_reason: "settle the stranded holder",
      actor_session_id: stranded.caller.sessionId, operation_id: "adopt-settle-1",
    }]);
    const db = await openStore(stranded.context, "read");
    try {
      expect(db.db.prepare("select state, revision from execution_sessions where workflow_id = ? and session_id = ?").get("wf-stranded", "active-holder"))
        .toEqual({ state: "revoked", revision: 2 });
    } finally { db.close(); }
  });

  test("terminalizes and settles an unregistered header that never closed, under the same attestation", async () => {
    const stranded = await strandedWithHolder("active-holder");
    const writer = await openStore(stranded.context, "write");
    try {
      writer.db.prepare("update execution_workflows set state_json = ? where workflow_id = ?")
        .run(JSON.stringify({
          id: "wf-stranded", schema_version: 1, type: "plan", status: "paused",
          started_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T01:00:00.000Z",
        }), "wf-stranded");
    } finally { writer.close(); }
    // A header that never closed still needs its holder's stop evidence; the
    // settlement and the terminalization are ONE transaction, so the committed
    // state never pairs an adoption record with a still-running header.
    const applied = await adopt(stranded, { attestation: attestation(["active-holder"]) });
    expect(applied.replayed).toBe(false);
    expect(applied.recovery).toMatchObject({
      outcome: "applied",
      applied: ["execution_sessions(wf-stranded, coordinator, active-holder) revoked"],
    });
    expect(applied.data.terminalAdoptions).toEqual([{
      id: "wf-stranded", status: "stopped", revision: 2, token: expect.any(String),
      lifecycle_adopted_at: expect.any(String), adopt_reason: "settle the stranded holder",
      actor_session_id: stranded.caller.sessionId, operation_id: "adopt-settle-1",
    }]);
    const db = await openStore(stranded.context, "read");
    try {
      expect(db.db.prepare("select state, revision from execution_sessions where workflow_id = ? and session_id = ?").get("wf-stranded", "active-holder"))
        .toEqual({ state: "revoked", revision: 2 });
      expect(db.db.prepare("select json_extract(state_json, '$.status') as status from execution_workflows where workflow_id = ?").get("wf-stranded"))
        .toEqual({ status: "stopped" });
      // The whole store holds no half-terminal header: an adoption record is
      // never committed beside a status that is not terminal, which is the
      // invariant that makes the previous transaction's terminalization load-bearing.
      expect(db.db.prepare(
        "select workflow_id, json_extract(state_json, '$.status') as status from execution_workflows " +
          "where json_extract(state_json, '$.lifecycle_adopted_at') is not null " +
          "and json_extract(state_json, '$.status') not in ('completed','stopped','failed')",
      ).all()).toEqual([]);
    } finally { db.close(); }
  });

  test("post-prune same-id adoption retries replay the retained terminal receipt", async () => {
    const stranded = await strandedWithHolder("active-holder");
    const proof = attestation(["active-holder"]);
    const applied = await adopt(stranded, { attestation: proof });
    expect(applied.replayed).toBe(false);
    const persisted = await openStore(stranded.context, "read");
    try {
      const selected = persisted.db.prepare("select result_json from execution_operations where operation_id = ?").get("adopt-settle-1");
      if (
        typeof selected !== "object" || selected === null || !("result_json" in selected) ||
        typeof selected.result_json !== "string"
      ) throw new Error("the adoption receipt row is missing result_json");
      const parsed: unknown = JSON.parse(selected.result_json);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        throw new Error("the adoption receipt envelope is not an object");
      const envelope = parsed as Record<string, unknown>;
      expect(Object.keys(envelope).sort()).toEqual(["epoch", "operationRecovery", "slim", "storeId", "token"]);
      expect(envelope).toEqual({
        slim: true,
        token: applied.token,
        storeId: applied.storeId,
        epoch: applied.epoch,
        operationRecovery: applied.recovery,
      });
    } finally { persisted.close(); }
    const retry = await adopt(stranded, { attestation: proof });
    expect(retry.replayed).toBe(true);
    expect(retry.data).toEqual(applied.data);
    expect(retry.recovery).toEqual(applied.recovery);
    expect((await readExecutionState(stranded.context)).data.terminalAdoptions).toHaveLength(1);
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
      // Join-built canary: identical runtime value, no credential-shaped
      // literal in source for secret scanners to flag.
      attestation: attestationVariant({ token: ["fixture", "credential-value"].join("-") }),
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
    const retry = await adopt(unneeded, { attestation: attestation([]) });
    expect(retry.replayed).toBe(true);
    expect(retry.data).toEqual(supplied.data);
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
