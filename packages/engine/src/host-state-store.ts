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
          return {
            kind: "refused" as const,
            reason: `workflow event identity ${input.eventId} was already accepted with digest ${prior.digest} at verified source session=${input.source.sessionId}, stream=${input.source.streamId}, seq=${input.source.seq}; the accepted fact is preserved. Re-read that native session's eventAt(${input.source.seq}) and resubmit the original event with the same identity and source.`,
          };
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

/** `ok` with no `emission` is a true no-row answer for this exact
 *  `(sessionId, cwd)` pair; every native refusal — absent, staged, corrupt,
 *  schema or unreadable authority — is `unavailable` with its own cause and
 *  recovery, never a fabricated absence. */
export type DshStatusEmissionRead =
  | { kind: "ok"; emission?: DshStatusEmission }
  | { kind: "unavailable"; reason: string };

export function readDshStatusEmission(
  context: StoreContext,
  sessionId: string,
  cwd: string,
): DshStatusEmissionRead {
  try {
    return withExecutionReadGuard(context, (db): DshStatusEmissionRead => {
      const row = db.prepare(
        "select session_id, cwd, turn, emitted_at, payload_json from dsh_status_emissions where session_id = ? and cwd = ?",
      ).get(sessionId, cwd) as {
        session_id?: string;
        cwd?: string;
        turn?: number;
        emitted_at?: string;
        payload_json?: string;
      } | undefined;
      if (!row) return { kind: "ok" };
      return {
        kind: "ok",
        emission: { sessionId: row.session_id!, cwd: row.cwd!, turn: row.turn!, emittedAt: row.emitted_at!, payloadJson: row.payload_json! },
      };
    });
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}
/** `workflows` is the source-tree-level category: the `dsh-workflows`
 *  selector refuses the whole legacy workflow tree (a symlinked `workflows/`
 *  root) before any per-workflow fact is evaluated. */
export type DshFactCategory = "registry" | "tail" | "identity" | "bounds" | "status" | "workflows";
/** One refused legacy fact group: the selector, the actual fact category, the
 *  displayed facts, the exact discarded scope, and the reason. */
export type DshHostStateRefusal = { selector: string; category: DshFactCategory; facts: string; discarded: string; reason: string; source: string };
export type DshHostStateRows = {
  workflows: ReadonlyArray<{
    workflowId: string;
    identities: ReadonlyArray<{ eventId: string; digest: string; acceptedAt: string }>;
    tailSourceDigest: string | null;
    ledgerRows: ReadonlyArray<{ eventId: string | null; lineJson: string; lineIndex: number; recordedAt: string }>;
    scanBounds: ReadonlyArray<{ sessionId: string; next: number; stream: string | null }>;
  }>;
  bindings: ReadonlyArray<{
    sessionId: string; cwd: string; selectedWorkflowId: string | null;
    executionBindingJson: string | null; excludedBeforeSeq: number; updatedAt: string;
  }>;
  emissions: ReadonlyArray<{ sessionId: string; cwd: string; turn: number; emittedAt: string; payloadJson: string }>;
};

export function importDshHostStateRows(
  tx: { db: StoreDb; storeId: string; epoch: number },
  rows: DshHostStateRows,
  nowIso: string,
): {
  written: { workflows: number; identities: number; ledgerRows: number; scanBounds: number; bindings: number; emissions: number };
  merged: { scanBoundsAdvanced: number; bindingFloorsRaised: number };
  refused: DshHostStateRefusal[];
  reusedOrPresent: string[];
  revisionAdvanced: boolean;
} {
  const authority = tx.db.prepare("select store_id, authority_epoch, authority_state from store_meta where id = 1").get() as
    { store_id?: string; authority_epoch?: number; authority_state?: string } | undefined;
  if (authority?.store_id !== tx.storeId || authority.authority_epoch !== tx.epoch) {
    throw new StoreError("store.stale-epoch", "The store identity or epoch changed during legacy host-state import.");
  }
  if (authority.authority_state !== "active") {
    throw new StoreError("store.not-active", `The store authority is ${authority?.authority_state ?? "missing"}; rerun store upgrade.`);
  }
  const written = { workflows: 0, identities: 0, ledgerRows: 0, scanBounds: 0, bindings: 0, emissions: 0 };
  const merged = { scanBoundsAdvanced: 0, bindingFloorsRaised: 0 };
  const refused: DshHostStateRefusal[] = [];
  const reusedOrPresent: string[] = [];
  if (!Number.isFinite(Date.parse(nowIso))) throw new StoreError("store.corrupt", "The legacy import timestamp is invalid.");
  let changed = false;
  const identity = tx.db.prepare("select digest from dsh_accepted_identities where workflow_id = ? and event_id = ?");
  const insertIdentity = tx.db.prepare("insert into dsh_accepted_identities(workflow_id,event_id,digest,accepted_at) values(?,?,?,?)");
  const workflowRows = tx.db.prepare("select count(*) as n from dsh_ledger_events where workflow_id = ?");
  const provenance = tx.db.prepare("select legacy_line from dsh_ledger_events where workflow_id = ? and legacy_source_digest = ? order by legacy_line");
  const insertLedger = tx.db.prepare("insert into dsh_ledger_events(workflow_id,event_id,event_json,recorded_at,legacy_source_digest,legacy_line) values(?,?,?,?,?,?)");
  for (const workflow of rows.workflows) {
    if (!workflow.workflowId) throw new StoreError("store.corrupt", "Imported workflow id must not be empty.");
    let workflowWritten = false;
    for (const fact of workflow.identities) {
      const prior = identity.get(workflow.workflowId, fact.eventId) as { digest: string } | undefined;
      if (prior && prior.digest !== fact.digest) { refused.push({ selector: `dsh-ledger:${workflow.workflowId}`, category: "identity", facts: fact.eventId, discarded: `the accepted identity ${fact.eventId} (native digest preserved)`, reason: "accepted identity has a different digest", source: `workflows/${workflow.workflowId}` }); continue; }
      if (!prior) { insertIdentity.run(workflow.workflowId, fact.eventId, fact.digest, fact.acceptedAt); written.identities++; changed = true; workflowWritten = true; }
      else reusedOrPresent.push(`identity:${workflow.workflowId}:${fact.eventId}`);
    }
    if (workflow.tailSourceDigest !== null && workflow.ledgerRows.length) {
      const origins = provenance.all(workflow.workflowId, workflow.tailSourceDigest) as Array<{ legacy_line: number }>;
      const expected = workflow.ledgerRows.map((row) => row.lineIndex);
      const alreadyPresent = origins.length === expected.length && origins.every((origin, index) => origin.legacy_line === expected[index]);
      const hasRows = Number((workflowRows.get(workflow.workflowId) as { n: number }).n) > 0;
      if (alreadyPresent) reusedOrPresent.push(`tail:${workflow.workflowId}:${workflow.tailSourceDigest}`);
      else if (hasRows) refused.push({ selector: `dsh-ledger:${workflow.workflowId}`, category: "tail", facts: `tail rows (${workflow.ledgerRows.length})`, discarded: `the ${workflow.ledgerRows.length} held-back display row(s) for ${workflow.workflowId}`, reason: "ordering-unsafe: native or incomplete legacy-provenance rows already exist", source: `workflows/${workflow.workflowId}` });
      else for (const row of workflow.ledgerRows) {
        insertLedger.run(workflow.workflowId, row.eventId, row.lineJson, row.recordedAt, workflow.tailSourceDigest, row.lineIndex);
        written.ledgerRows++; changed = true; workflowWritten = true;
      }
    }
    for (const bound of workflow.scanBounds) {
      const prior = tx.db.prepare("select next, stream from dsh_scan_bounds where workflow_id = ? and session_id = ?").get(workflow.workflowId, bound.sessionId) as { next: number; stream: string | null } | undefined;
      if (!prior) { tx.db.prepare("insert into dsh_scan_bounds(workflow_id,session_id,next,stream) values(?,?,?,?)").run(workflow.workflowId,bound.sessionId,bound.next,bound.stream); written.scanBounds++; changed=true; workflowWritten=true; }
      else if (prior.stream !== bound.stream) reusedOrPresent.push(`shadowed-bound:${workflow.workflowId}:${bound.sessionId}:different-incarnation`);
      else if (bound.next > prior.next) {
        tx.db.prepare("update dsh_scan_bounds set next = ? where workflow_id = ? and session_id = ? and stream is ? and next < ?").run(bound.next,workflow.workflowId,bound.sessionId,bound.stream,bound.next);
        written.scanBounds++; merged.scanBoundsAdvanced++; changed=true; workflowWritten=true;
      } else reusedOrPresent.push(`bound:${workflow.workflowId}:${bound.sessionId}:already-present`);
    }
    if (workflowWritten) written.workflows++;
  }
  for (const binding of rows.bindings) {
    const prior = tx.db.prepare("select excluded_before_seq from dsh_session_bindings where session_id = ? and cwd = ?").get(binding.sessionId,binding.cwd) as { excluded_before_seq: number } | undefined;
    if (!prior) {
      tx.db.prepare("insert into dsh_session_bindings(session_id,cwd,selected_workflow_id,execution_binding,excluded_before_seq,updated_at) values(?,?,?,?,?,?)")
        .run(binding.sessionId,binding.cwd,binding.selectedWorkflowId,binding.executionBindingJson,binding.excludedBeforeSeq,binding.updatedAt);
      written.bindings++; changed=true;
    } else if (binding.excludedBeforeSeq > prior.excluded_before_seq) {
      tx.db.prepare("update dsh_session_bindings set excluded_before_seq = ? where session_id = ? and cwd = ? and excluded_before_seq < ?")
        .run(binding.excludedBeforeSeq,binding.sessionId,binding.cwd,binding.excludedBeforeSeq);
      merged.bindingFloorsRaised++; changed=true;
    } else reusedOrPresent.push(`binding:${binding.sessionId}:${binding.cwd}:already-present`);
  }
  for (const emission of rows.emissions) {
    const prior = tx.db.prepare("select 1 from dsh_status_emissions where session_id = ? and cwd = ?").get(emission.sessionId,emission.cwd);
    if (!prior) {
      tx.db.prepare("insert into dsh_status_emissions(session_id,cwd,turn,emitted_at,payload_json) values(?,?,?,?,?)")
        .run(emission.sessionId,emission.cwd,emission.turn,emission.emittedAt,emission.payloadJson);
      written.emissions++; changed=true;
    } else reusedOrPresent.push(`emission:${emission.sessionId}:${emission.cwd}:already-present`);
  }
  return { written, merged, refused, reusedOrPresent, revisionAdvanced: changed };
}

