import { StoreError, withDshWriteTransaction, withExecutionReadGuard, type DshSelectedGeneration, type DshWriteTransaction, type StoreContext, type StoreDb } from "./store-db.js";
export type { DshSelectedGeneration } from "./store-db.js";

export type DshSessionBinding = {
  sessionId: string;
  cwd: string;
  selectedWorkflowId: string | null;
  executionBinding: string | null;
  excludedBeforeSeq: number;
  updatedAt: string;
};

export type DshSessionBindingUpdate = {
  selectedWorkflowId?: string;
  executionBinding?: string | null;
  excludedBeforeSeq: number;
};

export type DshWriteResult = { kind: "written" } | { kind: "degraded"; reason: string };
export type DshWorkflowEventInput = {
  workflowId: string;
  eventId: string;
  digest: string;
  lineJson: string;
  source: { sessionId: string; streamId: string; seq: number };
  selectedGeneration?: DshSelectedGeneration;
};


function now(): string {
  return new Date().toISOString();
}

function insertion(tx: DshWriteTransaction, workflowId: string, lineJson: string, eventId?: string): void {
  tx.db.prepare(
    "insert into dsh_ledger_events(workflow_id, event_id, event_json, recorded_at) values (?, ?, ?, ?)",
  ).run(workflowId, eventId ?? null, lineJson, now());
}

export function readDshSessionBinding(
  context: StoreContext,
  sessionId: string,
  cwd: string,
): { kind: "ok"; binding?: DshSessionBinding } | { kind: "unavailable"; reason: string } {
  try {
    return withExecutionReadGuard(context, (db) => {
      const row = db.prepare(
        "select session_id, cwd, selected_workflow_id, execution_binding, excluded_before_seq, updated_at " +
          "from dsh_session_bindings where session_id = ? and cwd = ?",
      ).get(sessionId, cwd) as {
        session_id?: string;
        cwd?: string;
        selected_workflow_id?: string | null;
        execution_binding?: string | null;
        excluded_before_seq?: number;
        updated_at?: string;
      } | undefined;
      if (!row) {
        const otherCwd = db.prepare(
          "select 1 from dsh_session_bindings where session_id = ? limit 1",
        ).get(sessionId);
        return otherCwd ? { kind: "unavailable", reason: "cwd-mismatch" } : { kind: "ok" };
      }
      return {
        kind: "ok",
        binding: {
          sessionId: row.session_id!, cwd: row.cwd!, selectedWorkflowId: row.selected_workflow_id ?? null,
          executionBinding: row.execution_binding ?? null, excludedBeforeSeq: row.excluded_before_seq!, updatedAt: row.updated_at!,
        },
      };
    });
  } catch (error) {
    return {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function writeDshSessionBinding(
  context: StoreContext,
  sessionId: string,
  cwd: string,
  update: DshSessionBindingUpdate,
  selectedGeneration?: DshSelectedGeneration,
): DshWriteResult {
  try {
    withDshWriteTransaction(context, (tx) => {
      const current = tx.db.prepare(
        "select selected_workflow_id, execution_binding from dsh_session_bindings where session_id = ? and cwd = ?",
      ).get(sessionId, cwd) as {
        selected_workflow_id?: string | null;
        execution_binding?: string | null;
      } | undefined;
      if (!current) {
        const otherCwd = tx.db.prepare(
          "select 1 from dsh_session_bindings where session_id = ? and cwd <> ? limit 1",
        ).get(sessionId, cwd);
        if (otherCwd) throw new Error("cwd-mismatch");
      }
      tx.db.prepare(
        "insert into dsh_session_bindings(session_id, cwd, selected_workflow_id, execution_binding, excluded_before_seq, updated_at) " +
          "values (?, ?, ?, ?, ?, ?) on conflict(session_id, cwd) do update set " +
          "selected_workflow_id = excluded.selected_workflow_id, execution_binding = excluded.execution_binding, " +
          "excluded_before_seq = max(dsh_session_bindings.excluded_before_seq, excluded.excluded_before_seq), updated_at = excluded.updated_at",
      ).run(
        sessionId,
        cwd,
        update.selectedWorkflowId ?? current?.selected_workflow_id ?? null,
        update.executionBinding === undefined ? current?.execution_binding ?? null : update.executionBinding,
        update.excludedBeforeSeq,
        now(),
      );
      tx.markChanged();
    }, selectedGeneration);
    return { kind: "written" };
  } catch (error) {
    return { kind: "degraded", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function recordDshStatusEmission(
  context: StoreContext,
  sessionId: string,
  cwd: string,
  turn: number,
  payloadJson: string,
  selectedGeneration?: DshSelectedGeneration,
): DshWriteResult {
  try {
    withDshWriteTransaction(context, (tx) => {
      tx.db.prepare(
        "insert into dsh_status_emissions(session_id, cwd, turn, emitted_at, payload_json) values (?, ?, ?, ?, ?) " +
          "on conflict(session_id, cwd) do update set turn = excluded.turn, emitted_at = excluded.emitted_at, payload_json = excluded.payload_json",
      ).run(sessionId, cwd, turn, now(), payloadJson);
      tx.markChanged();
    }, selectedGeneration);
    return { kind: "written" };
  } catch (error) {
    return { kind: "degraded", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function appendDshLedgerRow(
  context: StoreContext,
  workflowId: string,
  lineJson: string,
  eventId?: string,
  selectedGeneration?: DshSelectedGeneration,
): DshWriteResult {
  try {
    withDshWriteTransaction(context, (tx) => {
      insertion(tx, workflowId, lineJson, eventId);
      tx.markChanged();
    }, selectedGeneration);
    return { kind: "written" };
  } catch (error) {
    return { kind: "degraded", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function appendDshWorkflowEvent(
  context: StoreContext,
  input: DshWorkflowEventInput,
): { kind: "accepted" } | { kind: "replayed" } | { kind: "refused"; reason: string } {
  try {
    return withDshWriteTransaction(context, (tx) => {
      const prior = tx.db.prepare(
        "select digest from dsh_accepted_identities where workflow_id = ? and event_id = ?",
      ).get(input.workflowId, input.eventId) as { digest?: string } | undefined;
      if (prior) {
        if (prior.digest !== input.digest) {
          return { kind: "refused" as const, reason: "workflow event identity was already accepted with a different digest; the accepted fact is preserved, and this core exposes no supported conflict-recovery operation." };
        }
        if (advanceBound(tx.db, input.workflowId, input.source.sessionId, input.source.seq + 1, input.source.streamId)) tx.markChanged();
        return { kind: "replayed" as const };
      }
      tx.db.prepare(
        "insert into dsh_accepted_identities(workflow_id, event_id, digest, accepted_at) values (?, ?, ?, ?)",
      ).run(input.workflowId, input.eventId, input.digest, now());
      insertion(tx, input.workflowId, input.lineJson, input.eventId);
      advanceBound(tx.db, input.workflowId, input.source.sessionId, input.source.seq + 1, input.source.streamId);
      tx.markChanged();
      return { kind: "accepted" as const };
    }, input.selectedGeneration);
  } catch (error) {
    return { kind: "refused", reason: error instanceof Error ? error.message : String(error) };
  }
}


export function readDshLedgerWindow(context: StoreContext, workflowId: string, limit: number): string[] | null {
  if (!Number.isFinite(limit)) return null;
  const boundedLimit = Math.max(0, Math.floor(limit));
  try {
    return withExecutionReadGuard(context, (db) =>
      (db.prepare(
        "select event_json from dsh_ledger_events where workflow_id = ? order by seq_rowid desc limit ?",
      ).all(workflowId, boundedLimit) as Array<{ event_json: string }>).map((row) => row.event_json),
    );
  } catch {
    return null;
  }
}

export function readDshScanBound(
  context: StoreContext,
  workflowId: string,
  sessionId: string,
): { next: number; stream?: string } | undefined {
  try {
    return withExecutionReadGuard(context, (db) => {
      const row = db.prepare(
        "select next, stream from dsh_scan_bounds where workflow_id = ? and session_id = ?",
      ).get(workflowId, sessionId) as { next?: number; stream?: string | null } | undefined;
      return row ? { next: row.next!, ...(row.stream === null ? {} : { stream: row.stream }) } : undefined;
    });
  } catch {
    return undefined;
  }
}
function advanceBound(db: StoreDb, workflowId: string, sessionId: string, next: number, stream: string | null): boolean {
  if (!Number.isSafeInteger(next) || next < 1) {
    throw new StoreError("store.corrupt", "The dsh scan bound must be a positive safe integer.");
  }
  const prior = db.prepare(
    "select next, stream from dsh_scan_bounds where workflow_id = ? and session_id = ?",
  ).get(workflowId, sessionId) as { next?: number; stream?: string | null } | undefined;
  const value = prior && prior.stream === stream ? Math.max(prior.next!, next) : next;
  if (prior && prior.next === value && prior.stream === stream) return false;
  db.prepare(
    "insert into dsh_scan_bounds(workflow_id, session_id, next, stream) values (?, ?, ?, ?) " +
      "on conflict(workflow_id, session_id) do update set next = excluded.next, stream = excluded.stream",
  ).run(workflowId, sessionId, value, stream);
  return true;
}

export function advanceDshScanBound(
  context: StoreContext,
  workflowId: string,
  sessionId: string,
  next: number,
  stream: string | null,
  selectedGeneration?: DshSelectedGeneration,
): boolean {
  try {
    withDshWriteTransaction(context, (tx) => {
      if (advanceBound(tx.db, workflowId, sessionId, next, stream)) tx.markChanged();
    }, selectedGeneration);
    return true;
  } catch {
    return false;
  }
}

export type DshStatusEmission = {
  sessionId: string;
  cwd: string;
  turn: number;
  emittedAt: string;
  payloadJson: string;
};

export function readDshStatusEmission(
  context: StoreContext,
  sessionId: string,
  cwd: string,
): DshStatusEmission | undefined {
  try {
    return withExecutionReadGuard(context, (db) => {
      const row = db.prepare(
        "select session_id, cwd, turn, emitted_at, payload_json from dsh_status_emissions where session_id = ? and cwd = ?",
      ).get(sessionId, cwd) as {
        session_id?: string;
        cwd?: string;
        turn?: number;
        emitted_at?: string;
        payload_json?: string;
      } | undefined;
      return row
        ? { sessionId: row.session_id!, cwd: row.cwd!, turn: row.turn!, emittedAt: row.emitted_at!, payloadJson: row.payload_json! }
        : undefined;
    });
  } catch {
    return undefined;
  }
}

