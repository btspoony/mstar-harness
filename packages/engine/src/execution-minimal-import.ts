import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { readSessionEnvelope, type CoordinationSession } from "./coordination.js";
import { isNonEmptyString, isPlainObject } from "./coordination-write.js";
import { withStatusWriteLock } from "./lease.js";
import { rowPlanId, validatePlanRow, validateStatusV2, validateWorkflowEntry, type StatusV2Doc, type WorkflowEntry } from "./status.js";
import { validateWorkflowSnapshot, WORKFLOW_SNAPSHOT_FILE, type WorkflowSnapshot } from "./workflow.js";
import { ExecutionError, assertOperationId, suppliedCatalogPin, withExecutionTransaction } from "./execution-store.js";
import { canonicalPath, isPathWithin } from "./store-activation.js";
import { projectLegacySnapshot, writeImportedExecutionWorkflow, type ImportedPlan, type ImportedSessionBinding } from "./execution-import-rows.js";
import { initializeStore, storeDbPath, upgradeStore, type StoreContext } from "./store-db.js";

export type MinimalImportResult = {
  verdict: "upgraded";
  imported: number;
  skipped: Array<{ path: string; reason: string }>;
  dispositions: string[];
  sourceDigest: string;
};
export type MinimalStoreUpgradeResult = MinimalImportResult & { schemaVersion: number; authorityState: "active" };

type Binding = ImportedSessionBinding;
type Plan = ImportedPlan;
type Source = { entry: WorkflowEntry | null; id: string; dir: string; snapshot: WorkflowSnapshot; coordinator: Binding | null; plans: Plan[] };

const UNPARSEABLE_JSON = Symbol("unparseable-json");
const SYNTHESIZED_DATE = "1970-01-01";

function conflict(message: string): never {
  throw new ExecutionError("execution.migration-conflict", message);
}

function rootOf(context: StoreContext): string {
  return canonicalPath(dirname(storeDbPath(context)));
}

function binding(value: unknown): Binding | null {
  if (!isPlainObject(value)) return null;
  if (!isNonEmptyString(value.session_id) || !isNonEmptyString(value.session_file) || !isAbsolute(value.session_file) || !isNonEmptyString(value.bound_at)) return null;
  return { session_id: value.session_id, session_file: value.session_file, bound_at: value.bound_at };
}

function readSourceBytes(path: string, label: string): Buffer {
  let info;
  try { info = lstatSync(path); } catch { conflict(`${label} is missing at ${path}; restore the file or remove its registration, then rerun store upgrade.`); }
  if (info.isSymbolicLink() || !info.isFile()) conflict(`${label} at ${path} is not a regular file; replace it with an in-root file or remove its registration, then rerun store upgrade.`);
  try { return readFileSync(path); }
  catch (error) {
    conflict(`${label} at ${path} is unreadable (${error instanceof Error ? error.message : String(error)}); restore read access or remove the registration, then rerun store upgrade.`);
  }
}

function readRegularJson(path: string, label: string): unknown | typeof UNPARSEABLE_JSON {
  const bytes = readSourceBytes(path, label);
  try { return JSON.parse(bytes.toString("utf8")); } catch { return UNPARSEABLE_JSON; }
}

function verifyBinding(value: Binding, source: { root: string; dir: string; workflowId: string }): CoordinationSession {
  const sessionsDir = join(source.dir, "sessions");
  const path = canonicalPath(value.session_file);
  if (!isPathWithin(canonicalPath(sessionsDir), path) || path === canonicalPath(sessionsDir)) {
    conflict(`coordinator binding ${value.session_id} points outside ${sessionsDir}; move its envelope into that workflow's sessions directory or remove the binding, then rerun store upgrade.`);
  }
  let envelope: CoordinationSession;
  try { envelope = readSessionEnvelope(path); }
  catch { conflict(`coordinator session envelope ${path} is malformed; repair the envelope or remove its coordinator binding, then rerun store upgrade.`); }
  if (envelope.workflow_id !== source.workflowId || envelope.session_id !== value.session_id || envelope.role !== "coordinator" ||
      canonicalPath(envelope.harness_root) !== canonicalPath(source.root)) {
    conflict(`coordinator binding ${value.session_id} disagrees with envelope ${path}; repair the envelope/binding identity or remove the binding, then rerun store upgrade.`);
  }
  return envelope;
}

function discover(context: StoreContext): { root: string; rootDoc: StatusV2Doc; rows: Source[]; skipped: MinimalImportResult["skipped"]; sourceDigest: string } {
  const root = rootOf(context);
  const statusPath = join(root, "status.json");
  const skipped: MinimalImportResult["skipped"] = [];
  const sourceFiles = new Set<string>();
  let parsed: unknown;
  if (!existsSync(statusPath)) {
    parsed = { version: 2, updated_at: SYNTHESIZED_DATE, workflows: [] };
  } else {
    sourceFiles.add(statusPath);
    try { parsed = JSON.parse(readSourceBytes(statusPath, "status.json").toString("utf8")); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      parsed = { version: 2, updated_at: SYNTHESIZED_DATE, workflows: [] };
      skipped.push({ path: "status.json", reason: "unparseable root register; left in place" });
    }
  }
  const entries = isPlainObject(parsed) && Array.isArray(parsed.workflows) ? parsed.workflows : null;
  const safeEntries: unknown[] = [];
  for (const entry of entries ?? []) {
    if (isPlainObject(entry) && typeof entry.id === "string" && typeof entry.dir === "string") {
      const dir = join(root, entry.dir);
      if (!isPathWithin(root, dir) || dir === root) conflict(`workflow ${entry.id} records dir ${JSON.stringify(entry.dir)} outside control root ${root}; correct or remove that status.json entry, then rerun store upgrade.`);
    }
    if (validateWorkflowEntry(entry).ok) safeEntries.push(entry);
    else if (isPlainObject(entry) && typeof entry.id === "string") skipped.push({ path: `status.json#${entry.id}`, reason: "unrecognizable workflow entry; left in place" });
  }
  const registeredIds = new Set(safeEntries.flatMap((entry) => isPlainObject(entry) && typeof entry.id === "string" ? [entry.id] : []));
  const workflowsDir = join(root, "workflows");
  if (existsSync(workflowsDir)) {
    const workflowsInfo = lstatSync(workflowsDir);
    if (workflowsInfo.isSymbolicLink() || !workflowsInfo.isDirectory()) conflict(`workflow root ${workflowsDir} is not a real directory; replace it with a directory inside the control root or remove it, then rerun store upgrade.`);
    for (const dirent of readdirSync(workflowsDir, { withFileTypes: true })) {
      const dir = join(workflowsDir, dirent.name);
      if (dirent.isSymbolicLink()) conflict(`workflow directory ${dir} is a symlink; replace it with an in-root directory or remove it, then rerun store upgrade.`);
      if (!dirent.isDirectory() || registeredIds.has(dirent.name)) continue;
      const snapshotPath = join(dir, WORKFLOW_SNAPSHOT_FILE);
      if (!existsSync(snapshotPath)) continue;
      sourceFiles.add(snapshotPath);
      const snapshotValue = readRegularJson(snapshotPath, `unregistered snapshot at ${snapshotPath}`);
      const snapshotGate = snapshotValue === UNPARSEABLE_JSON
        ? { ok: false, violations: [{ code: "workflow.snapshot.invalid-json" }] }
        : validateWorkflowSnapshot(projectLegacySnapshot(snapshotValue));
      if (!snapshotGate.ok) {
        skipped.push({ path: relative(root, snapshotPath).split(/[\\/]+/).join("/"), reason: "unregistered snapshot is unrecognizable; left in place" });
        continue;
      }
      const snapshot = snapshotValue as WorkflowSnapshot;
      if (snapshot.id !== dirent.name) conflict(`unregistered workflow directory ${dir} contains snapshot id ${snapshot.id}; rename the directory to match or correct the snapshot id, then rerun store upgrade.`);
      const synthetic = { id: snapshot.id, type: snapshot.type, started_at: snapshot.started_at, dir: relative(root, dir).split(/[\\/]+/).join("/") };
      if (!validateWorkflowEntry(synthetic).ok) {
        skipped.push({ path: relative(root, snapshotPath).split(/[\\/]+/).join("/"), reason: "unregistered snapshot has an unrecognizable workflow identity; left in place" });
        continue;
      }
      safeEntries.push(synthetic);
    }
  }
  const candidate = entries === null ? parsed : { ...(parsed as Record<string, unknown>), workflows: safeEntries };
  const gate = validateStatusV2(candidate as StatusV2Doc);
  if (!gate.ok) skipped.push({ path: "status.json", reason: "unresolvable root register; left in place" });

  const rootDoc: StatusV2Doc = gate.ok ? candidate as StatusV2Doc : { version: 2, updated_at: SYNTHESIZED_DATE, workflows: safeEntries as WorkflowEntry[] };
  const rows: Source[] = [];
  const seen = new Set<string>();
  for (const raw of rootDoc.workflows) {
    const check = validateWorkflowEntry(raw);
    if (!check.ok) continue;
    const entry = raw as WorkflowEntry;
    if (seen.has(entry.id)) conflict(`status.json lists workflow ${entry.id} more than once; remove the duplicate registration and rerun store upgrade.`);
    seen.add(entry.id);
    const dir = join(root, entry.dir);
    const info = (() => { try { return lstatSync(dir); } catch { return null; } })();
    if (info?.isSymbolicLink() || (info !== null && !info.isDirectory())) conflict(`workflow ${entry.id} directory ${dir} is not a real in-root directory; replace it or remove its registration, then rerun store upgrade.`);
    const sessionsDir = join(dir, "sessions");
    const snapshotPath = join(dir, WORKFLOW_SNAPSHOT_FILE);
    if (info === null || !existsSync(snapshotPath)) {
      skipped.push({ path: relative(root, snapshotPath).split(/[\\/]+/).join("/"), reason: "registered workflow snapshot is missing; left in place" });
      continue;
    }
    sourceFiles.add(snapshotPath);
    const snapshotValue = readRegularJson(snapshotPath, `snapshot for workflow ${entry.id}`);
    if (snapshotValue === UNPARSEABLE_JSON) {
      skipped.push({ path: relative(root, snapshotPath).split(/[\\/]+/).join("/"), reason: "unparseable snapshot; left in place" });
      continue;
    }
    const snapshotGate = validateWorkflowSnapshot(projectLegacySnapshot(snapshotValue));
    if (!snapshotGate.ok) {
      skipped.push({ path: relative(root, snapshotPath).split(/[\\/]+/).join("/"), reason: `snapshot is unrecognizable (${snapshotGate.violations.map((v) => v.code).join(", ")}); left in place` });
      continue;
    }
    const snapshot = projectLegacySnapshot(snapshotValue);
    if (existsSync(sessionsDir)) {
      const sessionsInfo = lstatSync(sessionsDir);
      if (sessionsInfo.isSymbolicLink() || !sessionsInfo.isDirectory()) conflict(`workflow ${entry.id} sessions path is not a real directory; replace it with a real directory or remove it, then rerun store upgrade.`);
      for (const sessionEntry of readdirSync(sessionsDir, { withFileTypes: true })) {
        const sessionPath = join(sessionsDir, sessionEntry.name);
        if (!sessionEntry.isFile() || sessionEntry.isSymbolicLink()) {
          skipped.push({ path: relative(root, sessionPath).split(/[\\/]+/).join("/"), reason: "unrecognized session entry; left in place" });
          continue;
        }
        sourceFiles.add(sessionPath);
        const envelopeBytes = readSourceBytes(sessionPath, `session envelope for workflow ${entry.id}`);
        let rawEnvelope: unknown;
        try { rawEnvelope = JSON.parse(envelopeBytes.toString("utf8")); } catch { rawEnvelope = null; }
        if (isPlainObject(rawEnvelope) && rawEnvelope.role === "plan-pm") {
          // A legacy per-plan PM envelope is a projection of the removed seat.
          // It is dropped, never verified or resurrected: the stopped
          // workspace's business rows are what this import preserves.
          skipped.push({ path: relative(root, sessionPath).split(/[\\/]+/).join("/"), reason: "legacy plan-PM session envelope dropped; the seat was removed" });
          continue;
        }
        if (isPlainObject(rawEnvelope) &&
            ((typeof rawEnvelope.workflow_id === "string" && rawEnvelope.workflow_id !== entry.id) ||
             (typeof rawEnvelope.harness_root === "string" && canonicalPath(rawEnvelope.harness_root) !== canonicalPath(root)))) {
          conflict(`session envelope ${sessionPath} claims workflow ${String(rawEnvelope.workflow_id ?? "unknown")} or another control root; correct its owner identity or remove the foreign file, then rerun store upgrade.`);
        }
        let envelope: CoordinationSession;
        try { envelope = readSessionEnvelope(sessionPath); }
        catch { skipped.push({ path: relative(root, sessionPath).split(/[\\/]+/).join("/"), reason: "unrecognizable session envelope; left in place" }); continue; }
        if (envelope.workflow_id !== entry.id || canonicalPath(envelope.harness_root) !== canonicalPath(root)) {
          conflict(`session envelope ${sessionPath} claims workflow ${envelope.workflow_id} or another control root; correct its owner identity or remove the foreign file, then rerun store upgrade.`);
        }
      }
    }
    if (snapshot.id !== entry.id || snapshot.type !== entry.type || snapshot.started_at !== entry.started_at) conflict(`workflow ${entry.id} entry and snapshot identity differ; repair status.json or snapshot.json, then rerun store upgrade.`);
    const coordinatorValue = snapshot.coordination?.coordinator;
    const coordinator = coordinatorValue === undefined ? null : binding(coordinatorValue);
    if (coordinatorValue !== undefined && coordinator === null) conflict(`workflow ${entry.id} has a malformed coordinator binding; repair or remove the binding, then rerun store upgrade.`);
    const plans: Plan[] = [];
    const planIds = new Set<string>();
    for (const rawPlan of snapshot.plans ?? []) {
      if (!isPlainObject(rawPlan)) continue;
      const id = rowPlanId(rawPlan) ?? "";
      if (!id || planIds.has(id)) conflict(`workflow ${entry.id} has a missing or duplicate plan id; repair its plans array, then rerun store upgrade.`);
      const rowGate = validatePlanRow(rawPlan);
      if (!rowGate.ok) conflict(`plan ${id} of workflow ${entry.id} is invalid (${rowGate.violations.map((v) => v.code).join(", ")}); repair or remove the plan row, then rerun store upgrade.`);
      planIds.add(id);
      const planRow: Record<string, unknown> = { ...rawPlan, id };
      delete planRow.plan_id;
      // A legacy per-plan PM binding and a legacy held lease are DROPPED
      // projections of the removed seat, not preconditions: the stopped
      // workspace's business row state (status, progress, evidence) imports
      // unchanged, and a row that was apparently in progress under a claim
      // nobody now holds imports as Blocked rather than as live work.
      const droppedSession = isPlainObject(planRow.coordination) && planRow.coordination.session !== undefined;
      const droppedLease = isPlainObject(planRow.execution_lease);
      plans.push({ id, row: planRow, pin: suppliedCatalogPin(planRow, entry.id, id), droppedSession, droppedLease });
    }
    if (coordinator !== null) verifyBinding(coordinator, { root, dir, workflowId: entry.id });
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      if (dirent.name === WORKFLOW_SNAPSHOT_FILE || dirent.name === "sessions") continue;
      const path = join(dir, dirent.name);
      if (dirent.isSymbolicLink()) conflict(`workflow entry ${path} is a symlink; replace it with a regular file or remove it, then rerun store upgrade.`);
      if (dirent.isFile()) {
        sourceFiles.add(path);
        skipped.push({ path: relative(root, path).split(/[\\/]+/).join("/"), reason: "unrecognized workflow entry; left in place" });
      }
    }
    rows.push({ entry: registeredIds.has(entry.id) ? entry : null, id: entry.id, dir, snapshot, coordinator, plans });
  }
  rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  const sourceDigest = createHash("sha256").update(JSON.stringify([...sourceFiles].sort().map((path) => [
    relative(root, path).split(/[\\/]+/).join("/"),
    createHash("sha256").update(readSourceBytes(path, `workspace source ${relative(root, path)}`)).digest("hex"),
  ]))).digest("hex");
  return { root, rootDoc, rows, skipped, sourceDigest };
}


export async function importExecutionMinimal(input: { context: StoreContext; operator: string; operationId: string }): Promise<MinimalImportResult> {
  const { context, operator, operationId } = input;
  if (!isNonEmptyString(operator) || operator.trim() === "") throw new ExecutionError("execution.migration-conflict", "operator is required; rerun `store upgrade --operator <name>`.");
  assertOperationId(operationId);
  // Concurrency: one operator with the legacy workspace stopped; this lock serializes status/snapshot row writes.
  // No execution-maintenance lock is needed because this importer creates no ledger projections.
  return withStatusWriteLock(join(rootOf(context), "status.json"), async () => {
    const source = discover(context);
    const requestHash = createHash("sha256").update(JSON.stringify({
      operation: "store.upgrade",
      root: source.root,
      operator,
      operationId,
    })).digest("hex");
    return withExecutionTransaction(context, (tx) => {
      const prior = tx.db.prepare("select request_hash, result_json from store_operations where operation_id = ?").get(operationId) as { request_hash?: unknown; result_json?: unknown } | undefined;
      if (prior !== undefined) {
        if (prior.request_hash !== requestHash) throw new ExecutionError("execution.operation-conflict", `operationId ${operationId} was already used for a different store upgrade request.`);
        return JSON.parse(String(prior.result_json)) as MinimalImportResult;
      }
      const existing = new Set((tx.db.prepare("select workflow_id from execution_workflows").all() as Array<{ workflow_id: string }>).map(({ workflow_id }) => workflow_id));
      let imported = 0;
      const dispositions: string[] = [];
      for (const row of source.rows) {
        if (existing.has(row.id)) continue;
        writeImportedExecutionWorkflow(tx, row);
        existing.add(row.id);
        imported++;
        for (const plan of row.plans) {
          if (plan.droppedLease) dispositions.push(`workflow ${row.id} plan ${plan.id}: legacy per-plan execution lease dropped on import; the row imports as Blocked and the coordinator continues it through ordinary plan operations`);
          if (plan.droppedSession) dispositions.push(`workflow ${row.id} plan ${plan.id}: legacy plan-PM session binding dropped on import; that seat no longer exists`);
        }
        if (row.snapshot.integration_merge_lease !== undefined) {
          dispositions.push(`workflow ${row.id}: integration merge lease dropped on import; the coordinator re-establishes serial integration ownership through the ordinary completion operation`);
        }
      }
      const storeAuthority = tx.db.prepare("select authority_state from store_meta where id = 1").get() as { authority_state?: unknown } | undefined;
      if (storeAuthority?.authority_state !== "active" && storeAuthority?.authority_state !== "staged") {
        throw new ExecutionError("store.not-active", `issue/catalog authority is ${String(storeAuthority?.authority_state ?? "missing")}; resolve the store state, then rerun \`store upgrade\`.`);
      }
      const now = new Date().toISOString();
      if (tx.execution.authorityState !== "active") {
        const execution = tx.db.prepare("update execution_meta set authority_state = 'active', revision = revision + 1, root_updated_at = ?, activated_at = ? where id = 1 and revision = ?")
          .run(source.rootDoc.updated_at, now, tx.execution.revision) as { changes?: unknown };
        if (Number(execution.changes) !== 1) throw new ExecutionError("execution.stale-token", "execution revision changed during import; rerun \`store upgrade\` to enumerate current files.");
      } else if (imported > 0) {
        const execution = tx.db.prepare("update execution_meta set revision = revision + 1, root_updated_at = ? where id = 1 and revision = ?")
          .run(source.rootDoc.updated_at, tx.execution.revision) as { changes?: unknown };
        if (Number(execution.changes) !== 1) throw new ExecutionError("execution.stale-token", "execution revision changed during import; rerun \`store upgrade\` to enumerate current files.");
      }
      if (storeAuthority.authority_state === "staged") {
        const store = tx.db.prepare("update store_meta set authority_state = 'active', revision = revision + 1, activated_at = ? where id = 1 and authority_state = 'staged' and authority_epoch = ?")
          .run(now, tx.epoch) as { changes?: unknown };
        if (Number(store.changes) !== 1) throw new ExecutionError("store.stale-epoch", "store epoch changed during import; rerun `store upgrade` against the current store.");
      } else if (imported > 0) {
        tx.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
      }
      const result: MinimalImportResult = { verdict: "upgraded", imported, skipped: source.skipped, dispositions, sourceDigest: source.sourceDigest };
      tx.db.prepare("insert into store_operations(operation_id, request_hash, result_json, committed_at) values (?, ?, ?, ?)").run(operationId, requestHash, JSON.stringify(result), new Date().toISOString());
      return result;
    });
  });
}

export async function upgradeStoreMinimal(input: { context: StoreContext; operator: string; operationId: string }): Promise<MinimalImportResult & { schemaVersion: number; authorityState: "active" }> {
  const { context } = input;
  const dbPath = storeDbPath(context);
  let schemaVersion: number;
  mkdirSync(dirname(dbPath), { recursive: true });
  if (!existsSync(dbPath)) {
    const initialized = await initializeStore(context);
    schemaVersion = initialized.schemaVersion;
    initialized.close();
  } else schemaVersion = (await upgradeStore(context)).schemaVersion;
  const result = await importExecutionMinimal(input);
  return { ...result, schemaVersion, authorityState: "active" };
}
