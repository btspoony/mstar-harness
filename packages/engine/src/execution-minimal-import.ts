import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { parseSessionEnvelope, type CoordinationSession } from "./coordination-envelope.js";
import { isNonEmptyString, isPlainObject } from "./coordination-write.js";
import { rowPlanId, validatePlanRow, validateStatusV2, validateWorkflowEntry, type StatusV2Doc, type WorkflowEntry } from "./status.js";
import { validateWorkflowSnapshot, WORKFLOW_SNAPSHOT_FILE, type WorkflowSnapshot } from "./workflow.js";
import { CompassSkipError, convertLegacyV1Tree, DeliveryDeclarationError, MIGRATE_STATUS_FILE, type DeliveryLiftDeclarations, type LegacyV1Conversion } from "./migrate.js";
import { ExecutionError, assertOperationId, suppliedCatalogPin, withExecutionTransaction } from "./execution-store.js";
import { canonicalPath, isPathWithin, validateActivationAttestation } from "./store-activation.js";
import { legacySnapshotInventory, projectLegacySnapshot, writeImportedExecutionWorkflow, type ImportedPlan, type ImportedSessionBinding } from "./execution-import-rows.js";
import { initializeStore, openStore, StoreError, storeDbPath, upgradeStore, type MigrationContext, type StoreContext, type StoreDb } from "./store-db.js";
import { importDshHostStateFiles, type DshHostStateImportReport } from "./host-state-import.js";

/** One registered workflow an execution-specific acknowledgement skipped importing. */
type MinimalWorkflowSkip = { id: string; path: string };
export type MinimalImportResult = {
  /**
   * `upgraded` when this run committed execution rows; `nothing-to-import` when
   * it committed none but PROVED that the native authority already holds the
   * colliding workflows from an import of these exact source bytes.
   */
  verdict: "upgraded" | "nothing-to-import";
  imported: number;
  /** The original workflow ids whose rows this operation committed. */
  importedIds: string[];
  skipped: Array<{ path: string; reason: string }>;
  dispositions: string[];
  sourceDigest: string;
};
export type MinimalStoreUpgradeResult = MinimalImportResult & { schemaVersion: number; authorityState: "active"; dsh: DshHostStateImportReport };

type Binding = ImportedSessionBinding;
type Plan = ImportedPlan;
type Source = { entry: WorkflowEntry | null; id: string; dir: string; snapshot: WorkflowSnapshot; coordinator: Binding | null; plans: Plan[] };
/** One workflow the root register names, paired with the absolute directory it addresses. */
type RegisteredExecution = { id: string; dir: string };

const UNPARSEABLE_JSON = Symbol("unparseable-json");
const SYNTHESIZED_DATE = "1970-01-01";

function conflict(message: string): never {
  throw new ExecutionError("execution.migration-conflict", message);
}

/**
 * A refused `--ack-skip-workflow` acknowledgement: it named no workflow source
 * this run actually refuses — neither a registered source the preflight
 * classified as not a real in-root directory (a symlink that is never followed,
 * or a non-directory path) nor a recognized legacy source whose id already
 * exists in the native execution authority. Carried as a distinct type so the
 * import producer raises it as the discoverable same-entry usage refusal
 * instead of a generic migration failure, mirroring `DeliveryDeclarationError`.
 */
class WorkflowSkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowSkipError";
  }
}

function rootOf(context: StoreContext): string {
  return canonicalPath(dirname(storeDbPath(context)));
}

/**
 * The workflow ids the store's OWN retained import receipts prove were already
 * imported from the exact source bytes this run is reading.
 *
 * Every committed execution import writes a `store_operations` row whose
 * `result_json` carries the consumed `sourceDigest` and the `importedIds` it
 * committed, and that table is never pruned (`execution_operations` is the
 * pruned table). The lookup is therefore keyed on the RECORDED digest and never
 * on the caller's operation id, which the command surface mints fresh per
 * invocation: a receipt keyed on that id could never answer a repeat through
 * the public entry. The SQL prefilter is bounded to the rows whose receipt text
 * mentions this digest, and every candidate is then shape-validated in JS (an
 * object whose `sourceDigest` string EQUALS the current digest plus an
 * `importedIds` array of strings), so unrelated JSON that merely mentions the
 * digest - or a receipt for different source bytes - proves nothing.
 */
function provenReplayIds(db: StoreDb, sourceDigest: string): Set<string> {
  const ids = new Set<string>();
  const candidates = db
    .prepare("select result_json from store_operations where result_json like ?")
    .all(`%"sourceDigest":${JSON.stringify(sourceDigest)}%`) as Array<{ result_json?: unknown }>;
  for (const candidate of candidates) {
    if (typeof candidate.result_json !== "string") continue;
    let receipt: unknown;
    try { receipt = JSON.parse(candidate.result_json); } catch { continue; }
    if (!isPlainObject(receipt) || receipt.sourceDigest !== sourceDigest) continue;
    if (!Array.isArray(receipt.importedIds)) continue;
    for (const id of receipt.importedIds) if (isNonEmptyString(id)) ids.add(id);
  }
  return ids;
}

/**
 * The legacy `workflows/` tree is never followed through a symlink and never
 * read through a path that is not a real directory. Returns whether it can be
 * enumerated as a real in-root directory, plus the registered execution ids
 * whose source this run refuses — a registered source that is not itself a real
 * in-root directory (a symlink, or a non-directory path). The caller rejects an
 * acknowledgement that addresses no such source. A missing registered directory
 * retains the containment refusal; only a missing snapshot in a real directory
 * is an ordinary reported skip.
 *
 * The ROOT is `lstat`-ed FIRST and every decision about which registrations it
 * makes an execution source is purely lexical, so no path is resolved (and
 * therefore no link is followed) while the root's own linkage is unknown. Only
 * after the root is known to be a real directory may a registration directory
 * be probed.
 *
 * A symlinked ROOT is deferred to the DSH importer's own source handling when
 * it registers no execution workflow: the operator's documented
 * `--ack-skip-dsh dsh-workflows` recovery can then drop exactly that source
 * (and its loss report), instead of the preflight aborting before that
 * acknowledgement can run. A root that REGISTERS execution workflows is never
 * discarded by a DSH acknowledgement; it still refuses unless the operator
 * acknowledged the exact original workflow id with `--ack-skip-workflow <id>`,
 * which skips importing that registered workflow while its bytes stay in place.
 * Nothing is followed either way: linked bytes are reached only under the real
 * path, which the DSH evaluation lstat-refuses.
 *
 * A symlinked CHILD of a real tree is the DSH importer's own source, so an
 * operator who has already acknowledged dropping it (`--ack-skip-dsh
 * dsh-ledger:<id>`) leaves it to that phase instead of failing here before its
 * documented recovery runs. A registered child is not a DSH source: its own
 * guard names the execution acknowledgement.
 */
function assertWorkflowTreeIsReal(
  root: string,
  acknowledgedSkips: readonly string[],
  registeredExecution: readonly RegisteredExecution[],
  acknowledgedWorkflowSkips: ReadonlySet<string>,
): { enumerable: boolean; refusedRegisteredIds: Set<string>; refusal?: string } {
  const workflowsDir = join(root, "workflows");
  // Purely lexical, before any `lstat`: whether a registration addresses a
  // directory UNDER `workflows/` decides if a symlinked root is an execution
  // source, and resolving the path to answer that would itself follow the link.
  const workflowsPrefix = workflowsDir.endsWith(sep) ? workflowsDir : `${workflowsDir}${sep}`;
  const registeredUnderRoot = registeredExecution.filter(({ dir }) => dir !== workflowsDir && dir.startsWith(workflowsPrefix));
  let info;
  try { info = lstatSync(workflowsDir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enumerable: false, refusedRegisteredIds: new Set() };
    throw error;
  }
  if (!info.isSymbolicLink() && info.isDirectory()) {
    // The root is a real directory, so a registration's own directory may now be
    // probed: a registered linked source or a registered non-directory path (a
    // regular file, named pipe, etc.) is refused by the per-registration guard
    // and is classified here so an acknowledged id can be skipped before any
    // read. A MISSING path is not classified: that stays the guard's own
    // reported skip, never an ackable refusal.
    const refusedRegisteredIds = new Set<string>();
    for (const entry of registeredExecution) {
      try {
        const entryInfo = lstatSync(entry.dir);
        if (entryInfo.isSymbolicLink() || !entryInfo.isDirectory()) refusedRegisteredIds.add(entry.id);
      } catch { /* a missing path is the per-registration guard's own skip */ }
    }
    for (const dirent of readdirSync(workflowsDir, { withFileTypes: true })) {
      if (!dirent.isSymbolicLink()) continue;
      const path = join(workflowsDir, dirent.name);
      // A registered workflow is an execution source: the per-registration
      // guard names its own acknowledgement, and no DSH selector can discard
      // or skip one.
      if (registeredExecution.some((entry) => entry.dir === path)) continue;
      // An acknowledged DSH-only child is re-refused and dropped by
      // `importDshHostStateFiles`.
      if (acknowledgedSkips.includes(`dsh-ledger:${dirent.name}`)) continue;
      conflict(`workflow directory ${path} is a symlink; if it holds only legacy DSH host-state data, rerun store upgrade with \`--ack-skip-dsh dsh-ledger:${dirent.name}\` to drop exactly that source, otherwise replace it with an in-root directory or remove it, then rerun store upgrade.`);
    }
    return { enumerable: true, refusedRegisteredIds };
  }
  // A symlinked root with no registered execution workflow under it is exactly
  // what the DSH acknowledgement exists for: defer it so the documented
  // `--ack-skip-dsh dsh-workflows` recovery runs and reports the real loss.
  if (info.isSymbolicLink() && registeredUnderRoot.length === 0) {
    if (!acknowledgedSkips.includes("dsh-workflows")) {
      conflict(`workflow root ${workflowsDir} is not a real directory; if it holds only legacy DSH host-state data, rerun store upgrade with \`--ack-skip-dsh dsh-workflows\` to drop exactly that source, otherwise restore it as a directory inside the control root, then rerun store upgrade.`);
    }
    return { enumerable: false, refusedRegisteredIds: new Set() };
  }
  if (info.isSymbolicLink()) {
    const refusedRegisteredIds = new Set(registeredUnderRoot.map(({ id }) => id));
    const unacknowledged = registeredUnderRoot.filter(({ id }) => !acknowledgedWorkflowSkips.has(id));
    if (unacknowledged.length > 0) {
      return { enumerable: false, refusedRegisteredIds, refusal: `workflow root ${workflowsDir} is a symlink and its registration names execution workflow(s) under it (${unacknowledged.map(({ dir }) => relative(root, dir).split(/[\\/]+/).join("/")).join(", ")}); a linked directory is never followed, so a registered execution source is never discarded by a DSH acknowledgement \u2014 rerun store upgrade with \`--ack-skip-workflow ${unacknowledged.map(({ id }) => id).join(" ")}\` to skip importing exactly those registered workflows (their legacy sources remain in place and no execution row is imported for them), or replace the symlink with a real in-root directory holding those workflows, then rerun store upgrade.` };
    }
    return { enumerable: false, refusedRegisteredIds };
  }
  // A root that is neither a real directory nor a symlink (a regular file, a
  // named pipe, etc.) can never be read as a workflow source. When it registers
  // execution workflows under it, those registered sources are what this run
  // refuses, so the operator's execution acknowledgement can skip exactly those
  // imports while the root's bytes stay in place; with no registration under it
  // it is not an execution source at all — the DSH importer reports it as its
  // own ignored source, exactly like a symlinked root it can skip — so the run
  // must not abort one healthy upgrade over a file that sources nothing.
  if (registeredUnderRoot.length > 0) {
    const refusedRegisteredIds = new Set(registeredUnderRoot.map(({ id }) => id));
    const unacknowledged = registeredUnderRoot.filter(({ id }) => !acknowledgedWorkflowSkips.has(id));
    if (unacknowledged.length > 0) {
      return { enumerable: false, refusedRegisteredIds, refusal: `workflow root ${workflowsDir} is not a real directory, and its registration names execution workflow(s) under it (${unacknowledged.map(({ dir }) => relative(root, dir).split(/[\\/]+/).join("/")).join(", ")}); a source that is not a real in-root directory is never read as a workflow source \u2014 rerun store upgrade with \`--ack-skip-workflow ${unacknowledged.map(({ id }) => id).join(" ")}\` to keep the source in place and skip ONLY those legacy IMPORTs (each loss is reported in the receipt), or restore the root as a real in-root directory holding those workflows, then rerun store upgrade.` };
    }
    return { enumerable: false, refusedRegisteredIds };
  }
  return { enumerable: false, refusedRegisteredIds: new Set() };
}

function binding(value: unknown): Binding | null {
  if (!isPlainObject(value)) return null;
  if (!isNonEmptyString(value.session_id) || !isNonEmptyString(value.session_file) || !isAbsolute(value.session_file) || !isNonEmptyString(value.bound_at)) return null;
  return { session_id: value.session_id, session_file: value.session_file, bound_at: value.bound_at };
}

class UnsafeSourceError extends ExecutionError {
  constructor(message: string) {
    super("execution.migration-conflict", `${message} To explicitly start WITHOUT any legacy imports, use \`store init --harness <new-empty-control-root>\`; existing stores and all legacy bytes remain untouched. Existing native authority remains usable without this legacy upgrade.`);
  }
}

/**
 * Read one registered legacy source leaf through ONE descriptor: the leaf is
 * opened without following a final symlink and WITHOUT blocking, and the same
 * descriptor is verified against the `lstat` probe by device/inode before it is
 * read, so a LEAF swapped after that probe refuses instead of contributing the
 * replacement's bytes.
 *
 * That is the whole guard. These importers assume the control root they read is
 * trusted and defend against ACCIDENTAL symlink traversal, not against a writer
 * already inside that root. This reader's uncovered case is an intermediate
 * ANCESTOR directory replaced BEFORE the leaf probe: the probe and the open then
 * both observe the redirected regular file, so the device/inode comparison
 * (which rejects a post-probe leaf swap) sees one consistent inode and passes.
 * `isPathWithin` below still refuses a source that resolves *outside* the
 * control root on the default path, but a redirect that stays in-root is not
 * caught here. Where a supported flow imports a tree the operator does not
 * trust (for example a `.mstar` copied from another checkout), the correct shape
 * is a staged, re-validated private copy — not descriptor anchoring.
 *
 * The guard is also only as wide as the platform's constants, and each flag
 * degrades independently (`O_NOFOLLOW ?? 0`, `O_NONBLOCK ?? 0`). Where a runtime
 * omits `O_NOFOLLOW`, only the no-follow protection disappears, so a final
 * symlink would be followed; where it omits `O_NONBLOCK`, only the non-blocking
 * open disappears, so a FIFO or other special file could block the open. In both
 * cases the descriptor checks remain: the regular-file `fstat` refusal, and the
 * device/inode comparison against the probe. No Windows CI exercises this today,
 * so the guard is described here, never implied.
 */
function readSourceBytes(path: string, label: string): Buffer {
  let info;
  try { info = lstatSync(path); } catch { conflict(`${label} is missing at ${path}; restore the file or remove its registration, then rerun store upgrade.`); }
  if (info.isSymbolicLink() || !info.isFile()) throw new UnsafeSourceError(`${label} at ${path} is not a regular file.`);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new UnsafeSourceError(`${label} at ${path} was replaced, is not a regular file, or is no longer the verified bytes.`);
    }
    return readFileSync(fd);
  } catch (error) {
    if (error instanceof UnsafeSourceError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new UnsafeSourceError(`${label} at ${path} was replaced by a symlink and was not followed.`);
    return conflict(`${label} at ${path} is unreadable (${error instanceof Error ? error.message : String(error)}); restore read access and rerun store upgrade.`);
  }
  finally { if (fd !== undefined) closeSync(fd); }
}

function readRegularJson(path: string, label: string, read: (path: string, label: string) => Buffer = readSourceBytes): unknown | typeof UNPARSEABLE_JSON {
  const bytes = read(path, label);
  try { return JSON.parse(bytes.toString("utf8")); } catch { return UNPARSEABLE_JSON; }
}

function verifyBinding(value: Binding, source: { root: string; dir: string; workflowId: string }, read: (path: string, label: string) => Buffer = readSourceBytes): CoordinationSession {
  const sessionsDir = join(source.dir, "sessions");
  const path = resolve(value.session_file);
  // Every coordinator-envelope failure belongs to THIS workflow's own source, so
  // the workflow-scoped refusal (and its `--ack-skip-workflow <id>` disposal) owns
  // it instead of aborting every other import in the run.
  if (!isPathWithin(canonicalPath(sessionsDir), path) || path === canonicalPath(sessionsDir)) {
    throw new UnsafeSourceError(`coordinator binding ${value.session_id} points outside ${sessionsDir}; move its envelope into that workflow's sessions directory or remove the binding.`);
  }
  let envelope: CoordinationSession;
  try { envelope = parseSessionEnvelope(JSON.parse(read(path, "coordinator session envelope").toString("utf8")), path); }
  catch (error) {
    if (error instanceof UnsafeSourceError) throw error;
    throw new UnsafeSourceError(`coordinator session envelope ${path} is malformed; repair the envelope or remove its coordinator binding.`);
  }
  if (envelope.workflow_id !== source.workflowId || envelope.session_id !== value.session_id || envelope.role !== "coordinator" ||
      canonicalPath(envelope.harness_root) !== canonicalPath(source.root)) {
    throw new UnsafeSourceError(`coordinator binding ${value.session_id} disagrees with envelope ${path}; repair the envelope/binding identity or remove the binding.`);
  }
  return envelope;
}

/**
 * Convert a recognizable v1 root directly into the same import rows the v2
 * route produces: `convertLegacyV1Tree` supplies the snapshots in memory (the
 * legacy tree is never rewritten), and the ordinary projection/plan-row
 * pipeline below admits them. Registry membership follows the v2 route's own
 * rule — the registry lists ACTIVE lifecycles, so a terminal v1 lift imports as
 * unregistered terminal history exactly like an unregistered terminal v2
 * snapshot.
 */
function discoverV1(
  root: string,
  legacy: LegacyV1Conversion,
  operator: string,
  verifiedStatusBytes: Buffer,
  acknowledgedWorkflowSkips: ReadonlySet<string>,
): {
  rootDoc: StatusV2Doc;
  rows: Source[];
  sourceDigest: string;
  skipped: MinimalImportResult["skipped"];
  skippedWorkflowAcknowledgements: MinimalWorkflowSkip[];
  refusedSourceIds: ReadonlySet<string>;
  refusal?: string;
} {
  const rows: Source[] = [];
  const entries: WorkflowEntry[] = [];
  const skipped: MinimalImportResult["skipped"] = [];
  const skippedWorkflowAcknowledgements: MinimalWorkflowSkip[] = [];
  // A converted v1 lifecycle whose rows cannot be imported is refused as that
  // lifecycle's OWN source, exactly like a malformed v2 snapshot: one
  // agent-authored row must not block every other valid workflow, and the
  // operator's `--ack-skip-workflow <original id>` must be able to skip it.
  const refusedSourceIds = new Set<string>();
  let refusal: string | undefined;
  // A duplicated plan id is that id's own refused source: the conversion kept
  // the first row in stable order and reported every later duplicate, so the
  // operator's `--ack-skip-workflow <id>` can acknowledge the exact lost rows
  // instead of one duplicated agent-authored row blocking every healthy sibling.
  for (const duplicate of legacy.duplicatePlanIds) {
    refusedSourceIds.add(duplicate.id);
    const owner = duplicate.owner === null ? "unregistered (no iteration compass names it)" : `owned by iteration ${duplicate.owner}`;
    if (!acknowledgedWorkflowSkips.has(duplicate.id)) {
      refusal ??= `plan id ${duplicate.id} is claimed by ${duplicate.dropped.length + 1} rows in the v1 root plans[]: the first in stable order (plan id, then owning lifecycle id, then row ordinal) survives at plans[] index ${duplicate.kept} (${owner}) and the later duplicate row(s) at plans[] index ${duplicate.dropped.join(", ")} cannot be converted \u2014 every v1 row must land in exactly one snapshot. Rerun store upgrade with \`--ack-skip-workflow ${duplicate.id}\` to keep the first row and skip ONLY those duplicate rows; each lost row is reported in the receipt.`;
      continue;
    }
    for (const ordinal of duplicate.dropped) {
      skipped.push({
        path: `status.json#plans[${ordinal}]`,
        reason: `plan id ${duplicate.id} is duplicated in the v1 root plans[]; this run kept the row at plans[] index ${duplicate.kept} (${owner}) and skipped the later duplicate row at plans[] index ${ordinal} acknowledged by --ack-skip-workflow, so that row's status, progress and notes are not imported and stay only in the legacy status.json`,
      });
      legacy.dispositions.push(`plan id ${duplicate.id}: duplicate plan id in the v1 root plans[] \u2014 the row at plans[] index ${duplicate.kept} survives (${owner}) and the duplicate row at plans[] index ${ordinal} is not converted, so its status, progress and notes stay only in the legacy status.json (import disposal, not deletion, and every other source imports normally)`);
    }
  }
  // An acknowledged non-regular compass was never read: it produced no iteration
  // lifecycle, so every plan row it registered converts as a standalone row.
  // The receipt names the skipped iteration and reports that grouping loss.
  for (const compass of legacy.skippedCompasses) {
    skipped.push({
      path: compass.path,
      reason: `iteration ${compass.id} skipped by --ack-skip-compass; its canonical compass was not read (a non-regular leaf is never opened or followed), so this invocation created no iteration lifecycle for it and every plan row it registered converts as a standalone plan row`,
    });
    legacy.dispositions.push(`iteration ${compass.id}: skipped by --ack-skip-compass \u2014 its compass at ${compass.path} was not read, so this conversion produced no iteration lifecycle for it and every plan row it registered converts as a standalone plan row instead. An unread compass cannot enumerate its registered plan set, so the receipt lists this invocation's imported and skipped plan lifecycles for the operator to compare against that iteration's plans; an active standalone lift still needs its own --delivery declaration.`);
  }
  for (const converted of legacy.snapshots) {
    try {
      const raw = converted.data as unknown as Record<string, unknown>;
      const rawInventory = legacySnapshotInventory(raw);
      const snapshot = projectLegacySnapshot(raw);
      const historicalMetadata = snapshot.legacy_metadata;
      const historicalLease = historicalMetadata?.integration_merge_lease;
      if (historicalMetadata && historicalLease !== undefined) {
        const holder = isPlainObject(historicalLease) && isNonEmptyString(historicalLease.holder)
          ? historicalLease.holder
          : "unidentified holder";
        delete historicalMetadata.integration_merge_lease;
        if (Object.keys(historicalMetadata).length === 0) delete snapshot.legacy_metadata;
        legacy.dispositions.push(
          `workflow ${converted.id}: historical v1 integration merge lease for ${holder} was not imported as a live lease; operator ${JSON.stringify(operator)} requested store upgrade, which retires the historical claim, and future integration ownership uses the ordinary serial lease operation`,
        );
      }
      const plans: Plan[] = [];
      for (const rawPlan of snapshot.plans ?? []) {
        const id = rowPlanId(rawPlan);
        if (id === undefined || id === "") throw new UnsafeSourceError(`workflow ${converted.id} produced an unnamed plan row; the conversion must identify every row.`);
        const rowGate = validatePlanRow(rawPlan);
        if (!rowGate.ok) throw new UnsafeSourceError(`plan ${id} of workflow ${converted.id} is not convertible (${rowGate.violations.map((v) => v.code).join(", ")}); repair or remove that row, or acknowledge dropping this workflow's import.`);
        const planRow: Record<string, unknown> = { ...(rawPlan as unknown as Record<string, unknown>), id };
        delete planRow.plan_id;
        const rawFlags = rawInventory.get(id) ?? { droppedSession: false, droppedLease: false };
        plans.push({ id, row: planRow, pin: suppliedCatalogPin(planRow, converted.id, id), ...rawFlags });
      }
      // `workflows/<id>` is the canonical harness-relative registration dir —
      // an imported v1 lifecycle has no on-disk workflow directory to point at.
      const entry: WorkflowEntry = {
        id: converted.id,
        type: converted.type,
        started_at: snapshot.started_at,
        dir: join("workflows", converted.id),
      };
      const registered = converted.status === "running" || converted.status === "paused";
      if (registered) entries.push(entry);
      rows.push({ entry: registered ? entry : null, id: converted.id, dir: join(root, "workflows", converted.id), snapshot, coordinator: null, plans });
    } catch (error) {
      if (!(error instanceof UnsafeSourceError)) throw error;
      refusedSourceIds.add(converted.id);
      const path = join("workflows", converted.id).split(/[\\/]+/).join("/");
      if (acknowledgedWorkflowSkips.has(converted.id)) {
        skipped.push({ path, reason: `workflow ${converted.id} skipped by --ack-skip-workflow; its converted legacy row could not be imported and no execution row was registered for it` });
        skippedWorkflowAcknowledgements.push({ id: converted.id, path });
      } else {
        refusal ??= `${error.message} Rerun store upgrade with \`--ack-skip-workflow ${converted.id}\` to keep the source in place and skip ONLY this legacy IMPORT; its loss is reported in the receipt.`;
      }
    }
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // `legacy.sourceHashes` were computed where those files were read; the root
  // register contributes its own verified bytes, so the digest is exactly the
  // input this run consumed (no second acquisition on either route).
  const sourceDigest = createHash("sha256").update(JSON.stringify([
    [MIGRATE_STATUS_FILE, createHash("sha256").update(verifiedStatusBytes).digest("hex")] as [string, string],
    ...legacy.sourceHashes,
  ].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest("hex");
  return { rootDoc: { version: 2, updated_at: legacy.updatedAt, workflows: entries }, rows, sourceDigest, skipped, skippedWorkflowAcknowledgements, refusedSourceIds, ...(refusal === undefined ? {} : { refusal }) };
}

function discover(context: StoreContext, operator: string, acknowledgedSkips: readonly string[], acknowledgedWorkflowSkips: ReadonlySet<string>, declarations: DeliveryLiftDeclarations, acknowledgedCompassSkips: ReadonlySet<string>): { root: string; rootDoc: StatusV2Doc; rows: Source[]; skipped: MinimalImportResult["skipped"]; skippedWorkflowAcknowledgements: MinimalWorkflowSkip[]; sourceDigest: string; dispositions: string[]; refusedSourceIds: ReadonlySet<string>; refusal?: string } {
  const root = rootOf(context);
  const statusPath = join(root, "status.json");
  const skipped: MinimalImportResult["skipped"] = [];
  // Every source byte that becomes a row is hashed where it is read, so the
  // receipt digest names the bytes this run consumed instead of a later re-read
  // of the same paths.
  const sourceHashes = new Map<string, string>();
  const relOf = (path: string) => relative(root, path).split(/[\\/]+/).join("/");
  const readTracked = (path: string, label: string): Buffer => {
    const bytes = readSourceBytes(path, label);
    sourceHashes.set(relOf(path), createHash("sha256").update(bytes).digest("hex"));
    return bytes;
  };
  let parsed: unknown;
  // The one verified read of the root register on this route: the v1 conversion
  // below consumes these bytes instead of re-acquiring the path, so the
  // classification inode and the converted rows are the same bytes.
  let statusBytes: Buffer | undefined;
  if (!existsSync(statusPath)) {
    parsed = { version: 2, updated_at: SYNTHESIZED_DATE, workflows: [] };
  } else {
    statusBytes = readTracked(statusPath, "status.json");
    try { parsed = JSON.parse(statusBytes.toString("utf8")); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      parsed = { version: 2, updated_at: SYNTHESIZED_DATE, workflows: [] };
      skipped.push({ path: "status.json", reason: "unparseable root register; left in place" });
    }
  }
  const entries = isPlainObject(parsed) && Array.isArray(parsed.workflows) ? parsed.workflows : null;
  // Which workflows the root register names, so the `workflows/` preflight can
  // tell a DSH-only source tree from execution snapshots it must never discard.
  const registeredExecution: RegisteredExecution[] = (entries ?? [])
    .flatMap((entry) => isPlainObject(entry) && typeof entry.dir === "string" && typeof entry.id === "string" ? [{ id: entry.id, dir: join(root, entry.dir) }] : []);
  // A recognizable v1 root converts its lifecycles in memory from status.json;
  // nothing is ever read from `workflows/` there, so for the v1 route a
  // registration under it is NOT a skippable linked source and an execution
  // acknowledgement naming one is refused as unmatched rather than accepted and
  // silently ignored. The v2 route still classifies a registration the same way;
  // only the v1 conversion has no `workflows/` source to skip.
  const skippableRegistered = isPlainObject(parsed) && parsed.version === 1 ? [] : registeredExecution;
  const tree = assertWorkflowTreeIsReal(root, acknowledgedSkips, skippableRegistered, acknowledgedWorkflowSkips);
  const isRealWorkflowTree = tree.enumerable;
  // Preflight classified refused registered sources before child or target access.
  // That half of the acknowledgement vocabulary is settled here; the
  // other half (recognized legacy sources whose id the native authority already
  // holds) is only knowable inside the import transaction, so the whole-input
  // check runs at that seam instead of speculating about native state here.
  const refusedSourceIds = tree.refusedRegisteredIds;
  let refusal = tree.refusal;
  // A recognizable v1 root converts in memory and imports through the same
  // native rows; the legacy bytes stay on disk untouched.
  if (isPlainObject(parsed) && parsed.version === 1) {
    const legacy = convertLegacyV1Tree(root, declarations, statusBytes, [...acknowledgedCompassSkips]);
    const converted = discoverV1(root, legacy, operator, statusBytes!, acknowledgedWorkflowSkips);
    // The v1 route reads nothing from `workflows/`, so it reports no linked
    // skip of its own; its converted ids take the same collision/acknowledgement
    // contract in the import transaction below, and a lifecycle whose converted
    // rows cannot be imported is refused as that lifecycle's own source.
    return {
      root,
      rootDoc: converted.rootDoc,
      rows: converted.rows,
      skipped: converted.skipped,
      skippedWorkflowAcknowledgements: converted.skippedWorkflowAcknowledgements,
      sourceDigest: converted.sourceDigest,
      dispositions: legacy.dispositions,
      refusedSourceIds: converted.refusedSourceIds,
      ...(converted.refusal === undefined ? {} : { refusal: converted.refusal }),
    };
  }
  // A compass acknowledgement addresses the canonical compasses of a v1
  // conversion. Only the v1 route scans them, so on any other root the id names
  // no refused compass: refuse it (caller input) rather than silently ignoring
  // the acknowledgement the operator asked to spend.
  if (acknowledgedCompassSkips.size > 0) {
    throw new CompassSkipError(
      `--ack-skip-compass ${[...acknowledgedCompassSkips].sort().join(" ")} matched no refused compass; ` +
        `this control root is ${isPlainObject(parsed) && parsed.version === 2 ? "already a v2 tree, whose lifecycles carry no v1 compass to skip" : "an empty root with no compass at all"} \u2014 ` +
        `pass --ack-skip-compass only when upgrading a v1 root whose canonical compass this invocation refuses as non-regular, or omit it entirely`,
    );
  }
  // Declarations describe the ACTIVE standalone lifts a v1 conversion produces.
  // A v2 tree declares its kinds in its own snapshots and an empty root has no
  // lift to declare, so a nonempty declaration here addresses nothing: refuse it
  // rather than silently registering without the declaration the caller asked
  // for. A later seam cannot spend it either, so an ignored entry is a silent
  // no-op — the same actionable refusal the v1 route raises, before any row.
  if (declarations.length > 0) {
    throw new DeliveryDeclarationError(
      `${declarations.length} --delivery declaration(s) (${declarations.map((entry) => JSON.stringify(entry.workflow)).join(", ")}) address no active standalone plan lift; ` +
        `this control root is ${isPlainObject(parsed) && parsed.version === 2 ? "already a v2 tree, whose snapshots declare their own delivery kinds" : "an empty root with no active standalone v1 lift to declare"} \u2014 ` +
        `pass --delivery only when upgrading a v1 root that holds an active standalone plan, or omit it entirely`,
    );
  }
  const safeEntries: unknown[] = [];
  for (const entry of entries ?? []) {
    if (isPlainObject(entry) && typeof entry.id === "string" && typeof entry.dir === "string") {
      // Lexical containment only: a relative `../..` climb, an absolute dir, or
      // the root itself is caller input and is refused by NAME. Resolving the
      // path here (`isPathWithin` → `realpathSync`) would follow a linked
      // `workflows/` root into its target and turn a registered source the
      // operator may acknowledge into a containment refusal they cannot fix.
      const dir = join(root, entry.dir);
      const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
      if (!dir.startsWith(prefix) || dir === root) conflict(`workflow ${entry.id} records dir ${JSON.stringify(entry.dir)} outside control root ${root}; correct or remove that status.json entry, then rerun store upgrade.`);
    }
    if (validateWorkflowEntry(entry).ok) safeEntries.push(entry);
    else if (isPlainObject(entry) && typeof entry.id === "string") skipped.push({ path: `status.json#${entry.id}`, reason: "unrecognizable workflow entry; left in place" });
  }
  const registeredIds = new Set(safeEntries.flatMap((entry) => isPlainObject(entry) && typeof entry.id === "string" ? [entry.id] : []));
  const workflowsDir = join(root, "workflows");
  // `assertWorkflowTreeIsReal` already ran as the precondition for both routes;
  // it also reports whether `workflows/` may be enumerated at all, so an
  // unacknowledged symlinked root is NEVER followed here to discover snapshots.
  if (isRealWorkflowTree) {
    for (const dirent of readdirSync(workflowsDir, { withFileTypes: true })) {
      const dir = join(workflowsDir, dirent.name);
      if (!dirent.isDirectory() || registeredIds.has(dirent.name)) continue;
      const snapshotPath = join(dir, WORKFLOW_SNAPSHOT_FILE);
      if (!existsSync(snapshotPath)) continue;
      const snapshotValue = readRegularJson(snapshotPath, `unregistered snapshot at ${snapshotPath}`, readTracked);
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
  const skippedWorkflowAcknowledgements: MinimalWorkflowSkip[] = [];
  const seen = new Set<string>();
  for (const raw of rootDoc.workflows) {
    const check = validateWorkflowEntry(raw);
    if (!check.ok) continue;
    const entry = raw as WorkflowEntry;
    if (seen.has(entry.id)) conflict(`status.json lists workflow ${entry.id} more than once; remove the duplicate registration and rerun store upgrade.`);
    seen.add(entry.id);
    const dir = join(root, entry.dir);
    // `refusedRegisteredIds` is the preflight's own classification, computed by
    // lstat before any link is traversed. It is the authority here because under
    // a symlinked ROOT an `lstat(dir)` resolves THROUGH the link and would look
    // like a real directory — using it would read a linked source this run
    // refuses.
    const refusedRegistered = tree.refusedRegisteredIds.has(entry.id);
    // The operator's execution-specific acknowledgement skips importing exactly
    // this registered source: its raw directory/snapshot/link bytes are never
    // read or followed, no linked target is visited, and no native row is
    // imported or fabricated for it. The receipt states the skip and its loss.
    // This decision is deliberately taken BEFORE `lstatSync(dir)` so an
    // acknowledged source is never even probed for its own metadata.
    if (refusedRegistered && acknowledgedWorkflowSkips.has(entry.id)) {
      const path = relative(root, dir).split(/[\\/]+/).join("/");
      skipped.push({
        path,
        reason: `registered workflow ${entry.id} skipped by --ack-skip-workflow; its registered legacy source is not a real in-root directory, so it was not read and no execution row was imported for it`,
      });
      skippedWorkflowAcknowledgements.push({ id: entry.id, path });
      continue;
    }
    // Defer the refusal, not source access: invalid acknowledgements take
    // precedence once the transaction can classify native collisions too.
    const info = refusedRegistered && !isRealWorkflowTree
      ? null
      : (() => { try { return lstatSync(dir); } catch { return null; } })();
    if (refusedRegistered || info?.isSymbolicLink() || (info !== null && !info.isDirectory())) {
      // The source is a registered execution source whose path is not a real
      // in-root directory. Both shapes refuse with the SAME public recovery (the
      // exact original id on --ack-skip-workflow) and both leave the source's
      // bytes in place. The fresh probe is only trustworthy when the whole tree
      // was enumerable: under a non-enumerable root `lstatSync` resolves THROUGH
      // the root link, so the preflight's own classification is the authority
      // there and the refusal stays generic instead of guessing a shape.
      const kind = !isRealWorkflowTree || info === null
        ? "its registered path cannot be read as a workflow source"
        : info.isSymbolicLink()
          ? "a linked source is never followed"
          : "a non-directory path is not a workflow source";
      refusedSourceIds.add(entry.id);
      refusal ??= `workflow ${entry.id} directory ${dir} is not a real in-root directory (${kind}); rerun store upgrade with \`--ack-skip-workflow ${entry.id}\` to keep that source in place and skip ONLY its legacy IMPORT (the loss is reported in the receipt), or restore it as a real in-root directory, then rerun store upgrade.`;
      continue;
    }
    // Ordinary imports keep the physical containment the register previously had
    // applied: a REGULAR leaf reached through an intermediate ancestor symlink
    // must not escape the control root on the default path. That is an ESCAPE
    // check only — a redirect that stays inside the trusted control root passes
    // (see `readSourceBytes`). It is deliberately placed AFTER the
    // acknowledgement `continue` above, so an acknowledged linked source is
    // never canonicalized (which would resolve its link).
    try {
      // Inside the workflow scope on purpose: an escaping registration is this
      // workflow's own source failure, so the catch below registers the id and
      // either honours `--ack-skip-workflow <id>` or raises the actionable refusal.
      // It still runs AFTER the acknowledgement `continue` above, so an
      // acknowledged linked source is never canonicalized.
      if (!isPathWithin(root, dir) || dir === root) throw new UnsafeSourceError(`workflow ${entry.id} directory ${dir} resolves outside control root ${root}; replace it with a real in-root directory or remove its registration.`);
      const sessionsDir = join(dir, "sessions");
      const snapshotPath = join(dir, WORKFLOW_SNAPSHOT_FILE);
      if (info === null || !existsSync(snapshotPath)) {
        skipped.push({ path: relative(root, snapshotPath).split(/[\\/]+/).join("/"), reason: "registered workflow snapshot is missing; left in place" });
        continue;
      }
      const snapshotValue = readRegularJson(snapshotPath, `snapshot for workflow ${entry.id}`, readTracked);
      if (snapshotValue === UNPARSEABLE_JSON) {
        skipped.push({ path: relative(root, snapshotPath).split(/[\\/]+/).join("/"), reason: "unparseable snapshot; left in place" });
        continue;
      }
      const snapshotGate = validateWorkflowSnapshot(projectLegacySnapshot(snapshotValue));
      if (!snapshotGate.ok) {
        skipped.push({ path: relative(root, snapshotPath).split(/[\\/]+/).join("/"), reason: `snapshot is unrecognizable (${snapshotGate.violations.map((v) => v.code).join(", ")}); left in place` });
        continue;
      }
      // The raw historical inventory is read before projection deletes it.
      const rawInventory = legacySnapshotInventory(snapshotValue);
      const snapshot = projectLegacySnapshot(snapshotValue);
      if (existsSync(sessionsDir)) {
        const sessionsInfo = lstatSync(sessionsDir);
        if (sessionsInfo.isSymbolicLink() || !sessionsInfo.isDirectory()) throw new UnsafeSourceError(`workflow ${entry.id} sessions path is not a real directory.`);
        for (const sessionEntry of readdirSync(sessionsDir, { withFileTypes: true })) {
          const sessionPath = join(sessionsDir, sessionEntry.name);
          if (!sessionEntry.isFile() || sessionEntry.isSymbolicLink()) {
            skipped.push({ path: relative(root, sessionPath).split(/[\\/]+/).join("/"), reason: "unrecognized session entry; left in place" });
            continue;
          }
          const envelopeBytes = readTracked(sessionPath, `session envelope for workflow ${entry.id}`);
          let rawEnvelope: unknown;
          try { rawEnvelope = JSON.parse(envelopeBytes.toString("utf8")); } catch { rawEnvelope = null; }
          if (isPlainObject(rawEnvelope) && rawEnvelope.role === "plan-pm") {
            // The removed seat is dropped, never verified or resurrected.
            skipped.push({ path: relative(root, sessionPath).split(/[\\/]+/).join("/"), reason: "legacy plan-PM session envelope dropped; the seat was removed" });
            continue;
          }
          if (isPlainObject(rawEnvelope) &&
              ((typeof rawEnvelope.workflow_id === "string" && rawEnvelope.workflow_id !== entry.id) ||
               (typeof rawEnvelope.harness_root === "string" && canonicalPath(rawEnvelope.harness_root) !== canonicalPath(root)))) {
            throw new UnsafeSourceError(`session envelope ${sessionPath} claims workflow ${String(rawEnvelope.workflow_id ?? "unknown")} or another control root; correct its owner identity or remove the foreign file.`);
          }
          let envelope: CoordinationSession;
          try { envelope = parseSessionEnvelope(rawEnvelope, sessionPath); }
          catch { skipped.push({ path: relative(root, sessionPath).split(/[\\/]+/).join("/"), reason: "unrecognizable session envelope; left in place" }); continue; }
          if (envelope.workflow_id !== entry.id || canonicalPath(envelope.harness_root) !== canonicalPath(root)) {
            throw new UnsafeSourceError(`session envelope ${sessionPath} claims workflow ${envelope.workflow_id} or another control root; correct its owner identity or remove the foreign file.`);
          }
        }
      }
      // Every failure that this ONE workflow's own source causes is refused as that
      // workflow's source, so the documented `--ack-skip-workflow <id>` can skip it
      // with an explicit loss report instead of the whole run aborting and only
      // manual source editing remaining.
      if (snapshot.id !== entry.id || snapshot.type !== entry.type || snapshot.started_at !== entry.started_at) throw new UnsafeSourceError(`workflow ${entry.id} entry and snapshot identity differ; repair status.json or snapshot.json.`);
      const coordinatorValue = snapshot.coordination?.coordinator;
      const coordinator = coordinatorValue === undefined ? null : binding(coordinatorValue);
      if (coordinatorValue !== undefined && coordinator === null) throw new UnsafeSourceError(`workflow ${entry.id} has a malformed coordinator binding; repair or remove the binding.`);
      const plans: Plan[] = [];
      const planIds = new Set<string>();
      for (const rawPlan of snapshot.plans ?? []) {
        if (!isPlainObject(rawPlan)) continue;
        const id = rowPlanId(rawPlan) ?? "";
        if (!id || planIds.has(id)) throw new UnsafeSourceError(`workflow ${entry.id} has a missing or duplicate plan id; a lost or duplicated row cannot be imported as-is. Repair its plans array, or acknowledge dropping this workflow's import.`);
        const rowGate = validatePlanRow(rawPlan);
        if (!rowGate.ok) throw new UnsafeSourceError(`plan ${id} of workflow ${entry.id} is not convertible (${rowGate.violations.map((v) => v.code).join(", ")}); repair or remove the row, or acknowledge dropping this workflow's import.`);
        planIds.add(id);
        const planRow: Record<string, unknown> = { ...rawPlan, id };
        delete planRow.plan_id;
        const rawFlags = rawInventory.get(id) ?? { droppedSession: false, droppedLease: false };
        plans.push({ id, row: planRow, pin: suppliedCatalogPin(planRow, entry.id, id), droppedSession: rawFlags.droppedSession, droppedLease: rawFlags.droppedLease });
      }
      if (coordinator !== null) verifyBinding(coordinator, { root, dir, workflowId: entry.id }, readTracked);
      for (const dirent of readdirSync(dir, { withFileTypes: true })) {
        if (dirent.name === WORKFLOW_SNAPSHOT_FILE || dirent.name === "sessions") continue;
        const path = join(dir, dirent.name);
        if (dirent.isSymbolicLink()) throw new UnsafeSourceError(`workflow entry ${path} is a symlink.`);
        if (dirent.isFile()) {
          readTracked(path, `workspace source ${relative(root, path)}`);
          skipped.push({ path: relative(root, path).split(/[\\/]+/).join("/"), reason: "unrecognized workflow entry; left in place" });
        }
      }
      rows.push({ entry: registeredIds.has(entry.id) ? entry : null, id: entry.id, dir, snapshot, coordinator, plans });
    } catch (error) {
      if (!(error instanceof UnsafeSourceError)) throw error;
      refusedSourceIds.add(entry.id);
      const path = relative(root, dir).split(/[\\/]+/).join("/");
      if (acknowledgedWorkflowSkips.has(entry.id)) {
        skipped.push({ path, reason: `workflow ${entry.id} skipped by --ack-skip-workflow; unsafe nested source was not followed and no execution row was imported for it` });
        skippedWorkflowAcknowledgements.push({ id: entry.id, path });
      } else {
        refusal ??= `${error.message} Rerun store upgrade with \`--ack-skip-workflow ${entry.id}\` to keep the source in place and skip ONLY this legacy IMPORT; its loss is reported in the receipt.`;
      }
    }
  }
  rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  const sourceDigest = createHash("sha256").update(JSON.stringify([
    [...sourceHashes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  ])).digest("hex");
  return { root, rootDoc, rows, skipped, skippedWorkflowAcknowledgements, sourceDigest, dispositions: [], refusedSourceIds, refusal };
}


export async function importExecutionMinimal(input: { context: StoreContext; operator: string; operationId: string; acknowledgedSkips?: readonly string[]; acknowledgedWorkflowSkips?: readonly string[]; acknowledgedCompassSkips?: readonly string[]; deliveryDeclarations?: DeliveryLiftDeclarations }): Promise<MinimalImportResult> {
  const { context, operator, operationId } = input;
  if (!isNonEmptyString(operator) || operator.trim() === "") throw new ExecutionError("execution.migration-conflict", "operator is required; rerun `store upgrade --operator <name>`.");
  assertOperationId(operationId);
  // A repeated id is an ordinary caller slip with one meaning: normalize it so
  // both the request identity and the run treat `[a, a]` exactly like `[a]`. The
  // raw values are kept, so a blank or unknown id stays a caller fact that the
  // unmatched guard below reports rather than a silently discarded input.
  const workflowSkips = new Set(input.acknowledgedWorkflowSkips ?? []);
  const compassSkips = new Set(input.acknowledgedCompassSkips ?? []);
  const source = discover(context, operator, input.acknowledgedSkips ?? [], workflowSkips, input.deliveryDeclarations ?? [], compassSkips);
  const requestHash = createHash("sha256").update(JSON.stringify({
    operation: "store.upgrade",
    root: source.root,
    operator,
    operationId,
    deliveryDeclarations: input.deliveryDeclarations ?? [],
    acknowledgedWorkflowSkips: [...workflowSkips].sort(),
    // A compass acknowledgement selects which lifecycles the conversion
    // produces, so it is part of the request identity a retained receipt binds.
    acknowledgedCompassSkips: [...compassSkips].sort(),
    // The imported input is part of the request identity: a retained receipt
    // must never vouch for bytes that were never imported, so reusing one
    // operationId across changed legacy bytes conflicts instead of replaying.
    sourceDigest: source.sourceDigest,
  })).digest("hex");
  return withExecutionTransaction(context, (tx) => {
    const prior = tx.db.prepare("select request_hash, result_json from store_operations where operation_id = ?").get(operationId) as { request_hash?: unknown; result_json?: unknown } | undefined;
    if (prior !== undefined) {
      if (prior.request_hash !== requestHash) throw new ExecutionError("execution.operation-conflict", `operationId ${operationId} was already used for a different store upgrade request.`);
      if (source.refusal !== undefined) conflict(source.refusal);
      return JSON.parse(String(prior.result_json)) as MinimalImportResult;
    }
    const existing = new Set((tx.db.prepare("select workflow_id from execution_workflows").all() as Array<{ workflow_id: string }>).map(({ workflow_id }) => workflow_id));
    // A recognized legacy source whose id the native authority already holds is
    // a COLLISION: this run never overwrites, deletes or silently omits the
    // existing native workflow, and it never guesses a prior import from a
    // matching id/type/date/header either. The operator's explicit
    // `--ack-skip-workflow <id>` acknowledges exactly that lost IMPORT; without
    // it the collision refuses before any execution row commits. A genuine
    // same-operation replay already returned its retained receipt above, so a
    // receipt — not a heuristic — is the only thing that skips this decision.
    const collidingIds = new Set(source.rows.filter((row) => existing.has(row.id)).map(({ id }) => id));
    // The ONE additional thing that may skip this decision beside the caller's
    // own operation receipt above: the store's retained import receipts for the
    // EXACT source bytes this run is reading. A colliding id those receipts
    // already list as imported is a PROVEN replay — the native authority holds
    // it because this same input was imported before, not because an unrelated
    // workflow happens to share the id. Anything else still refuses.
    const provenIds = new Set([...provenReplayIds(tx.db, source.sourceDigest)].filter((id) => collidingIds.has(id)));
    const importable = source.rows.filter((row) => !collidingIds.has(row.id));
    const acknowledgedCollisions = source.rows
      .filter((row) => collidingIds.has(row.id) && !provenIds.has(row.id) && workflowSkips.has(row.id))
      .map((row) => ({ id: row.id, path: relative(source.root, row.dir).split(/[\\/]+/).join("/") }));
    // The acknowledgement vocabulary is exactly the sources THIS run refuses:
    // the registered sources the preflight classified by lstat before any target
    // access (a linked source, or a non-directory path), plus the recognized ids
    // colliding in this transaction. An acknowledgement naming anything else
    // would silently drop a source this run would otherwise import, so it is
    // caller input (usage), not a skip. An acknowledgement naming a PROVEN-replay
    // collision is accepted (it names a real collision whose import did not
    // happen) and simply reports the proven disposition instead of a loss.
    const unmatchedWorkflowSkips = [...workflowSkips]
      .filter((id) => !source.refusedSourceIds.has(id) && !collidingIds.has(id));
    if (unmatchedWorkflowSkips.length > 0) {
      throw new WorkflowSkipError(
        `--ack-skip-workflow ${unmatchedWorkflowSkips.join(" ")} matched no workflow source this run refuses \u2014 neither a registered source that is not a real in-root directory (a linked source or a non-directory path) nor a recognized legacy source whose id the native execution authority already holds. ` +
          `Skipping an unrefused source would silently drop a workflow this run would otherwise import \u2014 pass only the original workflow ids named by the refusal, or omit --ack-skip-workflow entirely.`,
      );
    }
    if (source.refusal !== undefined) conflict(source.refusal);
    const refusedCollisions = [...collidingIds].filter((id) => !workflowSkips.has(id) && !provenIds.has(id));
    if (refusedCollisions.length > 0) {
      conflict(
        `the retained legacy source${refusedCollisions.length === 1 ? "" : "s"} for ${refusedCollisions.map((id) => JSON.stringify(id)).join(", ")} already ${refusedCollisions.length === 1 ? "exists" : "exist"} in the native execution authority; an upgrade never overwrites, deletes or silently omits an existing native workflow. ` +
          `Rerun store upgrade with \`--ack-skip-workflow ${refusedCollisions.join(" ")}\` to keep the native authority and skip ONLY ${refusedCollisions.length === 1 ? "that legacy IMPORT" : "those legacy IMPORTs"} (the loss is reported in the receipt). ` +
          `No execution import was committed; schema initialization or normalization may already have committed. Legacy source bytes remain unchanged.`,
      );
    }
    let imported = 0;
    const importedIds: string[] = [];
    const skipped = [...source.skipped];
    const dispositions: string[] = [...source.dispositions];
    for (const row of importable) {
      writeImportedExecutionWorkflow(tx, row);
      imported++;
      importedIds.push(row.id);
      for (const plan of row.plans) {
        if (plan.droppedLease) dispositions.push(`workflow ${row.id} plan ${plan.id}: legacy per-plan execution lease dropped on import; the row imports as Blocked and the coordinator continues it through ordinary plan operations`);
        if (plan.droppedSession) dispositions.push(`workflow ${row.id} plan ${plan.id}: legacy plan-PM session binding dropped on import; that seat no longer exists`);
      }
      if (row.snapshot.integration_merge_lease !== undefined) {
        dispositions.push(`workflow ${row.id}: integration merge lease dropped on import; the coordinator re-establishes serial integration ownership through the ordinary completion operation`);
      }
    }
    for (const entry of acknowledgedCollisions) {
      skipped.push({
        path: entry.path,
        reason: `legacy source for workflow ${entry.id} skipped by --ack-skip-workflow; the native execution authority already holds that id, so its native rows were kept and its legacy IMPORT was skipped`,
      });
      dispositions.push(`workflow ${entry.id}: skipped by --ack-skip-workflow; the native execution authority already holds that id, so this run kept the native workflow/plan rows, coordination, header and revisions unchanged and imported nothing from the retained legacy source at ${entry.path}. The legacy bytes remain in place and the native progress stays authoritative even if that source body was later edited \u2014 this is import disposal, not deletion, and no prior import or resumption is inferred.`);
    }
    // A proven replay is NOT an acknowledged loss: the store's own retained
    // import receipt for THESE exact source bytes already lists the id, so the
    // native authority holds it because this input was imported before. It is
    // reported as the ordinary already-current outcome, never as a skipped or
    // lost import, and it needs no acknowledgement.
    for (const row of source.rows.filter((entry) => provenIds.has(entry.id))) {
      const path = relative(source.root, row.dir).split(/[\\/]+/).join("/");
      // An acknowledgement on a PROVEN collision is honoured (it names a real
      // collision) but it disposed of nothing: no loss is fabricated for an
      // import that demonstrably already happened, and the receipt says so
      // instead of leaving the operator's own input unreported.
      const acknowledged = workflowSkips.has(row.id)
        ? " The --ack-skip-workflow acknowledgement this run also carried was unnecessary for that id and disposed of no import."
        : "";
      dispositions.push(`workflow ${row.id}: proven replay \u2014 this store's own retained import receipt for source digest ${source.sourceDigest} already imported this id, so the native execution authority already holds it from an import of these exact source bytes at ${path}. This run imported nothing for it and kept the native workflow/plan rows, coordination, header and revisions unchanged; the legacy bytes remain in place.${acknowledged}`);
    }
    skipped.sort((a, b) => a.path.localeCompare(b.path));
    for (const entry of source.skippedWorkflowAcknowledgements) {
      dispositions.push(`workflow ${entry.id}: skipped by --ack-skip-workflow; the operator acknowledged discarding this registered legacy execution source, so no workflow or plan row was imported for it. The refused source path was not read or followed (the per-item skip above names it and its exact cause) and its bytes remain in place \u2014 this is import disposal, not deletion, and no resumption is fabricated.`);
    }
    const storeAuthority = tx.db.prepare("select authority_state from store_meta where id = 1").get() as { authority_state?: unknown } | undefined;
    if (storeAuthority?.authority_state !== "active" && storeAuthority?.authority_state !== "staged") {
      throw new ExecutionError("store.not-active", `issue/catalog authority is ${String(storeAuthority?.authority_state ?? "missing")}; resolve the store state, then rerun \`store upgrade\`.`);
    }
    const now = new Date().toISOString();
    if (tx.execution.authorityState !== "active") {
      const execution = tx.db.prepare("update execution_meta set authority_state = 'active', revision = revision + 1, root_updated_at = ?, activated_at = ? where id = 1 and revision = ?")
        .run(source.rootDoc.updated_at, now, tx.execution.revision) as { changes?: unknown };
      if (Number(execution.changes) !== 1) throw new ExecutionError("execution.stale-token", "execution revision changed during import; rerun `store upgrade` to enumerate current files.");
    } else if (imported > 0) {
      const execution = tx.db.prepare("update execution_meta set revision = revision + 1, root_updated_at = ? where id = 1 and revision = ?")
        .run(source.rootDoc.updated_at, tx.execution.revision) as { changes?: unknown };
      if (Number(execution.changes) !== 1) throw new ExecutionError("execution.stale-token", "execution revision changed during import; rerun `store upgrade` to enumerate current files.");
    }
    if (storeAuthority.authority_state === "staged") {
      const store = tx.db.prepare("update store_meta set authority_state = 'active', revision = revision + 1, activated_at = ? where id = 1 and authority_state = 'staged' and authority_epoch = ?")
        .run(now, tx.epoch) as { changes?: unknown };
      if (Number(store.changes) !== 1) throw new ExecutionError("store.stale-epoch", "store epoch changed during import; rerun `store upgrade` against the current store.");
    } else if (imported > 0) {
      tx.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
    }
    // The report shape mirrors the DSH importer's existing vocabulary: a run
    // that commits rows is an `upgraded` import; a run that commits none but
    // proves at least one replay reports the already-current state as
    // `nothing-to-import` instead of claiming an upgrade that did not happen.
    const result: MinimalImportResult = {
      verdict: imported === 0 && provenIds.size > 0 ? "nothing-to-import" : "upgraded",
      imported, importedIds, skipped, dispositions, sourceDigest: source.sourceDigest,
    };
    tx.db.prepare("insert into store_operations(operation_id, request_hash, result_json, committed_at) values (?, ?, ?, ?)").run(operationId, requestHash, JSON.stringify(result), new Date().toISOString());
    return result;
  });
}

export async function upgradeStoreMinimal(input: {
  context: StoreContext;
  operator: string;
  operationId: string;
  /**
   * The operator's FULL activation attestation for the plan-PM holders this
   * cutover retires, validated here before any schema change: a migration never
   * treats a thin or unattested stop id as authority.
   */
  attestation?: unknown;
  acknowledgedSkips?: readonly string[];
  /**
   * The operator's execution-specific acknowledgements: the exact ORIGINAL
   * workflow ids this run skips IMPORTING. Two sources are refusable and can be
   * acknowledged: a registered legacy source whose `workflows/` root or own path
   * is not a real in-root directory (a symlink that is never followed, or a
   * non-directory path), and a recognized legacy source whose id the native
   * execution authority already holds (a collision). Each skip keeps the native
   * authority and the source bytes in place and reports its lost import. An id
   * naming neither refusal is caller input (usage), never a silent skip. Distinct
   * from `acknowledgedSkips`, which only disposes DSH host state and can never
   * discard a registered execution source.
   */
  acknowledgedWorkflowSkips?: readonly string[];
  /**
   * The operator's `--ack-skip-compass <iteration-id>` acknowledgements: the
   * iteration DIRECTORY names under `iterations/` whose canonical compass this
   * run refuses as non-regular. The acknowledged compass is never read, so that
   * iteration produces no lifecycle and the plan rows it registered convert as
   * standalone rows; the receipt reports the skipped iteration and that
   * grouping loss. An id naming no such refused compass is caller input
   * (usage), never a silent skip.
   */
  acknowledgedCompassSkips?: readonly string[];
  /**
   * Per-lift delivery declarations for the ACTIVE standalone v1 plans this
   * import lifts (the former `migrate` declaration contract): a lifted plan
   * workflow fixes its delivery kind at registration, so an undeclared or
   * malformed entry refuses the whole import before any native row commits.
   */
  deliveryDeclarations?: DeliveryLiftDeclarations;
}): Promise<MinimalStoreUpgradeResult> {
  const { context } = input;
  const attestation: MigrationContext["attestation"] =
    input.attestation === undefined ? undefined : validateActivationAttestation(input.attestation);
  const dbPath = storeDbPath(context);
  let schemaVersion: number;
  mkdirSync(dirname(dbPath), { recursive: true });
  // Initialization publishes the canonical path in ONE atomic create-only step
  // (`initializeStore` builds the complete store beside it and hard-links it
  // into place), so this existence check can no longer route a peer onto the
  // upgrade path against an in-flight first creation: the path is either
  // absent — and this process's own create-only claim loses the publish race
  // with a truthful `store.already-exists`, retried through this same public
  // operation — or a complete, committed store to upgrade.
  if (!existsSync(dbPath)) {
    const initialized = await initializeStore(context, { attestation });
    schemaVersion = initialized.schemaVersion;
    initialized.close();
  } else schemaVersion = (await upgradeStore(context, { attestation })).schemaVersion;
  let result: MinimalImportResult;
  try {
    result = await importExecutionMinimal(input);
  } catch (error) {
    // A refused delivery declaration is a caller-input condition of THIS
    // attempt (missing/duplicate/unmatched/incoherent entry), not a damaged
    // legacy source: it is reported as its own code so the command surface can
    // return the actionable usage refusal naming the exact retry. It is raised
    // before any execution row is registered.
    const earlyRefusalCode = error instanceof DeliveryDeclarationError
      ? "execution.delivery-declaration-required"
      : error instanceof WorkflowSkipError
        ? "execution.workflow-skip-unmatched"
        : error instanceof CompassSkipError
          ? "execution.compass-skip-unmatched"
          : undefined;
    let authority = "authority state could not be read";
    try {
      const store = await openStore(context, "read");
      try {
        const rows = store.db.prepare(
          "select s.authority_state as store_state, e.authority_state as execution_state " +
            "from store_meta s cross join execution_meta e where s.id = 1 and e.id = 1",
        ).get() as { store_state?: unknown; execution_state?: unknown } | undefined;
        authority = `issue/catalog authority ${String(rows?.store_state ?? "missing")}, execution authority ${String(rows?.execution_state ?? "missing")}`;
      } finally {
        store.close();
      }
    } catch {
      // Keep the original import failure and disclose that state could not be observed.
    }
    const cause = error instanceof Error ? error.message : String(error);
    if (earlyRefusalCode !== undefined) {
      const causeSentence = cause.endsWith(".") ? cause : `${cause}.`;
      throw new ExecutionError(earlyRefusalCode, `${causeSentence} The legacy source bytes are unchanged. Schema version ${schemaVersion} was committed before legacy execution import failed; ${authority}. The failed import transaction committed no rows, and existing execution rows remain unchanged. Resolve the reported cause through its source owner, then retry \`mstar store upgrade --operator <name>\`.`);
    }
    const detail = `Schema version ${schemaVersion} was committed before legacy execution import failed; ${authority}. The failed import transaction committed no rows, and existing execution rows remain unchanged. Resolve the reported cause through its source owner, then retry \`mstar store upgrade --operator <name>\`. Original refusal: ${cause}`;
    if (error instanceof ExecutionError) throw new ExecutionError(error.code, detail);
    if (error instanceof StoreError) throw new StoreError(error.code, detail, error.details);
    throw new ExecutionError("execution.migration-conflict", detail);
  }
  let dsh: DshHostStateImportReport;
  try {
    dsh = await importDshHostStateFiles(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The advertised retry must be reachable in one step: the execution rows this
    // operation committed are native collisions for the next invocation, whose
    // fresh operation id cannot replay this receipt, AND the unchanged root still
    // requires the workflow acknowledgements this invocation already accepted (a
    // duplicated v1 plan id, an unsafe registered source or a pre-existing native
    // collision is a property of the source, not of this commit). An unchanged v1
    // root also re-converts the same active standalone plan lift(s), so a retry
    // that omits the declarations this invocation used refuses in declaration
    // application before it ever reaches the legacy DSH phase.
    const declarations = input.deliveryDeclarations ?? [];
    const deliveries = declarations.length === 0
      ? ""
      : ` The same retry must also repeat the --delivery declaration(s) this invocation used (${declarations.map((entry) => `--delivery ${JSON.stringify(entry)}`).join(" ")}), because the unchanged v1 root still needs one per active standalone plan lift.`;
    const compassSkips = [...(input.acknowledgedCompassSkips ?? [])];
    const compasses = compassSkips.length === 0
      ? ""
      : ` The same retry must also repeat the --ack-skip-compass acknowledgement(s) this invocation used (${compassSkips.map((id) => `--ack-skip-compass ${id}`).join(" ")}), because the unchanged v1 root still refuses that non-regular compass.`;
    const workflowAcks = [...new Set([...(input.acknowledgedWorkflowSkips ?? []), ...result.importedIds])].sort();
    const committed = workflowAcks.length === 0
      ? ""
      : ` retry the same entry and include \`--ack-skip-workflow ${workflowAcks.join(" ")}\` in that same retry: it is always safe, because the source-scoped acknowledgements this unchanged root still requires (a duplicated v1 plan id, an unsafe registered source) keep their meaning while the ids this invocation committed are now PROVEN replays by the receipt it retained, so repeating them is accepted and reported as unnecessary rather than as a loss.`;
    // The refusal body lists one `- <selector>: ...` line per fact group it
    // refused. Those selectors stay refused on the unchanged root, and so do the
    // selectors this invocation already acknowledged (an acknowledgement is
    // never persisted), so the advertised retry is their union — never the
    // acknowledgement of a different DSH failure, such as an unmatched selector.
    const refusedSelectors = error instanceof StoreError && error.code === "store.upgrade-dsh-source-refused"
      ? [...message.matchAll(/^- (\S+?): /gm)].map((match) => match[1]!)
      : [];
    const dshAcks = [...new Set([...(input.acknowledgedSkips ?? []), ...refusedSelectors])].sort();
    const dsh = refusedSelectors.length === 0
      ? ""
      : ` the same retry must also repeat every DSH acknowledgement this invocation used together with the selectors this refusal names \u2014 an acknowledgement is not persisted, so the unchanged root refuses those selectors again \u2014 so include \`--ack-skip-dsh ${dshAcks.join(" ")}\` in that same retry.`;
    const prefix = `Execution-state import committed (${result.imported} workflows${result.imported > 0 ? `: ${result.importedIds.join(", ")}` : ""});${committed}${deliveries}${compasses}${dsh} DSH import did not commit.`;
    if (error instanceof StoreError) {
      throw new StoreError(error.code, `${prefix} ${message}`, error.details);
    }
    if (error instanceof ExecutionError) {
      throw new ExecutionError(error.code, `${prefix} ${message}`);
    }
    throw new StoreError("store.upgrade-dsh-failed", `${prefix} ${message}`);
  }
  return { ...result, schemaVersion, authorityState: "active", dsh };
}
