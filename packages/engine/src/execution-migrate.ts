/**
 * execution-migrate.ts — the read-only execution migration preview and the
 * staged import (primary spec §6 items 1–2, on §2.2's owned fields, §2.3's
 * session semantics and §7's catalog coexistence).
 *
 * Task ownership (plan `20260920-activation-migration-recovery`, R1): this
 * module implements EXACTLY two verbs — `previewExecutionMigration` and
 * `applyExecutionMigration`. Activation, retirement and abort are R2; backup,
 * restore and diagnostic export are R3. Nothing here activates: `apply`
 * writes staged rows and leaves execution authority `staged`, where `legacy`
 * and `staged` both keep the unchanged JSON execution route (§2.1) — so JSON
 * remains the sole live execution authority after `apply` returns, and an
 * ordinary execution read refuses `execution.not-active`.
 *
 * ## One discovery pass, closed by construction
 *
 * Both verbs run the SAME synchronous discovery (`discoverExecutionSources`):
 * preview hashes and reports it, apply re-reads it under the locks and refuses
 * any drift from the reviewed witnesses. One parser means the imported rows and
 * the reviewed hashes can never come from two different readings of a file.
 *
 * An overlooked source is the failure mode that matters (§6 item 1 names
 * "source discovery overlooks a configured root" as a stop condition), so the
 * inventory is closed rather than best-effort:
 *
 * - the root register is read at the CANONICAL control root
 *   (`dirname(storeDbPath(context))`), never at a cwd-local path, and each
 *   entry names its own harness-relative dir — a `.mstarc`-configured workflow
 *   root is discovered from that record, not guessed from a default layout;
 * - every registered workflow dir is ENUMERATED and every entry must be the
 *   core snapshot or a named deferred surface; anything else is
 *   `execution.coverage-incomplete` rather than silently skipped;
 * - every referenced session envelope is read and its identity checked;
 * - the harness-level execution-status file is probed by name.
 *
 * Registry membership alone selects an active lifecycle (§2.2), so workflow
 * dirs the root register does not list are historical evidence rather than live
 * execution authority, and are not part of this inventory.
 *
 * ## What the import writes — and what it deliberately does not
 *
 * Each registered workflow becomes one header row (the snapshot minus
 * `plans`/`coordination`/`integration_merge_lease`: the first is owned by
 * `execution_plans`, the second is the DB's `execution_sessions` binding whose
 * file path the DB authority never stores, and the third by
 * `execution_integration_leases`), one registry entry, one plan row per plan
 * (state = the row minus `coordination`/`execution_lease`; coordination = the
 * stored block minus `revision`/`session`), one sealed frozen input per plan
 * (`executionInputSelection`/`executionInputHash`, unchanged), plus the
 * ownership records:
 *
 * - **imported sessions are SUSPENDED** (§2.3). A migrated file-envelope
 *   identity is a read-only witness, never a credential, and never revives.
 *   The envelope's identity is validated against the recorded binding
 *   (workflow, role, session id, plan, control root) and only its path+hash are
 *   recorded — file contents are never copied anywhere;
 * - **held ownership is retained, not released.** A plan's held execution
 *   lease and the workflow's integration merge lease are imported as rows. The
 *   lease's holder identity resolves against the workflow's recorded
 *   coordinator or the plan's own plan-pm session — the two owners the file
 *   route can leave on a lease — and a holder that resolves to neither is an
 *   orphan and refuses. The lease keeps the import epoch as `owner_epoch`, so
 *   the single activation epoch bump leaves it strictly behind the store: the
 *   §2.2 "represented rather than repaired" arm, where it authorizes nothing
 *   until the named recovery decision.
 *
 * ## Coherence the apply refuses on
 *
 * `apply` refuses unless the reviewed manifest still matches the world: the
 * hash recomputed from the manifest it was handed, the control root, the store
 * identity and epoch, the schema version, the issue/catalog revision, an empty
 * pending catalog journal (§7: a pending operation must be reconciled while
 * JSON still owns execution) and every source witness hash. It refuses while
 * another manifest is staged ("another manifest conflicts unless explicitly
 * aborted", §6 item 2) and returns the recorded receipt for an identical staged
 * manifest without writing anything.
 *
 * ## Maintenance lock order (§4.2)
 *
 * `apply` takes, in order, the execution-maintenance lock, the root status
 * lock, every registered workflow's snapshot lock (sorted by workflow id), and
 * only then opens its SQLite transaction — a strict prefix of the order legacy
 * callers already use (root → workflow → SQL), so no live legacy writer can
 * deadlock against a migration. The outer lock is the existing ownership
 * primitive keyed under `<harness>/.execution-maintenance`:
 * `withStatusWriteLock` derives `<dirname(target)>/.status-write.lockdir`, so
 * the maintenance key must be a FILE inside that directory — naming the
 * directory itself would alias the root status lockdir and make the documented
 * order impossible to acquire.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  executionInputHash,
  executionInputSelection,
  readSessionEnvelope,
  type CatalogExecutionPin,
} from "./coordination.js";
import { isNonEmptyString, isPlainObject } from "./coordination-write.js";
import { storedCoordinationViolations } from "./coordination-transitions.js";
import { validateExecutionLease, withStatusWriteLock, type ExecutionLease } from "./lease.js";
import {
  rowPlanId,
  validatePlanRow,
  validateStatusV2,
  validateWorkflowEntry,
  type StatusV2Doc,
  type WorkflowEntry,
} from "./status.js";
import {
  LEGACY_WORKTREE_PATH_CODE,
  rowValidationRoute,
  validateWorkflowSnapshot,
  WORKFLOW_SNAPSHOT_FILE,
  type WorkflowSnapshot,
} from "./workflow.js";
import { openStore, storeDbPath, type StoreContext, type StoreDb } from "./store-db.js";
import { assertBackupDescribesStore, canonicalPath, isPathWithin, type BackupReceipt } from "./store-activation.js";
import {
  ExecutionError,
  assertOperationId,
  serializeExecutionValue,
  suppliedCatalogPin,
  withExecutionTransaction,
  type ExecutionTransaction,
} from "./execution-store.js";

/** Transport version of the execution migration manifest (§6). */
export const EXECUTION_MIGRATION_MANIFEST_VERSION = 1;

/** §6: the operator's input to preview and apply. */
export type ExecutionMigrationInput = { context: StoreContext; operationId: string; operator: string };

/** §6: one source byte witness the manifest is reviewed against. */
export type ExecutionSourceWitness = {
  path: string;
  sha256: string;
  kind: "root" | "workflow" | "session-envelope" | "deferred";
};

/**
 * §6: one deferred (2b) surface. `paths` are the paths DISCOVERED for the
 * surface, so `paths.length > 0` holds exactly when `disposition` is
 * `blocked`; a 2a activation barrier requires every surface `absent`
 * (guides/deferred-2b.md "Complete coverage rule").
 */
export type ExecutionDeferredSurface = {
  surface: string;
  paths: string[];
  disposition: "absent" | "blocked";
};

/**
 * §6: the reviewable manifest. `id` is content-derived (the digest of every
 * field above it), so re-previewing an unchanged workspace yields the same
 * manifest, the same id and the same hash.
 */
export type ExecutionManifest = {
  version: 1;
  id: string;
  storeId: string;
  epoch: number;
  schemaVersion: number;
  /** The canonical control harness root this manifest was reviewed against. */
  root: string;
  sources: ExecutionSourceWitness[];
  /** Digest of the core content the import writes: root bytes, snapshot bytes, sealed inputs. */
  coreHash: string;
  deferred: ExecutionDeferredSurface[];
  catalogRevision: number;
  /**
   * Always empty in a produced manifest: a non-committed catalog operation
   * refuses preview and apply alike (§7), so the field is the reviewer's
   * explicit "no pending catalog operation was outstanding" witness.
   */
  pendingCatalogOperations: string[];
};

/** §6: one reviewed manifest's recorded phase. */
export type ExecutionMigrationReceipt = {
  manifestId: string;
  phase: "staged" | "active" | "retired" | "aborted";
  replayed: boolean;
};

/**
 * §6: the apply request — the reviewed manifest, its hash and a verified
 * recovery point, in exactly the §6 shape. `applyExecutionMigration` declares
 * that intersection literally; this alias exists so callers can name it.
 */
export type ExecutionMigrationApplyInput = ExecutionMigrationInput & {
  manifest: ExecutionManifest;
  manifestHash: string;
  backup: BackupReceipt;
};

// ---------------------------------------------------------------------------
// Refusals (§5) and small shared helpers
// ---------------------------------------------------------------------------

/** §5: discovered legacy content contradicts the execution model, or the reviewed manifest no longer matches it. */
function conflict(detail: string): ExecutionError {
  return new ExecutionError("execution.migration-conflict", detail);
}

/** §5: the source inventory is not closed, so coverage cannot be claimed. */
function incomplete(detail: string): ExecutionError {
  return new ExecutionError("execution.coverage-incomplete", detail);
}

/**
 * The canonical control harness root that owns `context`'s store (§4.3).
 * `storeDbPath` resolves through Git, and a Git probe that falls back to the
 * lexical route answers with the same root in a different spelling, so the
 * root is canonicalized once here: every recorded path and every root
 * comparison is then the same string for the same directory.
 */
function controlRootOf(context: StoreContext): string {
  return canonicalPath(dirname(storeDbPath(context)));
}

/** The canonical value digest (§3.1 form) shared by the manifest id, the manifest hash and the core digest. */
function digestOf(value: unknown): string {
  return createHash("sha256").update(serializeExecutionValue(value), "utf8").digest("hex");
}

/** SHA-256 of raw bytes — the only correctness token used for source bytes. */
function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameBytesDigest(a: string, b: string): boolean {
  return a === b;
}

/**
 * Canonical hash of one reviewed manifest — the value `apply` must be handed
 * back verbatim. A difference between the manifest and its hash, or between
 * either and the live world, always refuses; neither side is re-derived from
 * the other.
 */
export function executionManifestHash(manifest: ExecutionManifest): string {
  return digestOf(manifest);
}

/** §6 `ExecutionMigrationInput`: both operator inputs are required contract, not decoration. */
function resolveMigrationInput(input: ExecutionMigrationInput | undefined, verb: string): ExecutionMigrationInput {
  const context = input?.context;
  if (!context || typeof context.harnessDir !== "string" || context.harnessDir.trim() === "") {
    throw new ExecutionError(
      "execution.scope-mismatch",
      `${verb} needs a store context; the control harness root is how the migration finds the store it stages into.`,
    );
  }
  assertOperationId(input.operationId);
  if (!isNonEmptyString(input.operator) || input.operator.trim() === "") {
    throw new ExecutionError(
      "execution.scope-mismatch",
      `${verb} requires the accountable operator identity (a nonblank string): an unattributed migration decision is ` +
        `never recorded. The identity is durably attested at the activation barrier (R2) rather than in the staged ` +
        `manifest, which holds reviewed content only.`,
    );
  }
  return input;
}

/** A source path read under the control root: real bytes, never a link. */
function readSourceBytes(path: string, what: string, missingDetail: string): Buffer {
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch {
    throw conflict(missingDetail);
  }
  if (info.isSymbolicLink()) {
    throw conflict(
      `${what} at ${path} is a symlink. The migration reads the real bytes under the control root \u2014 a link can ` +
        `resolve elsewhere, so it is refused rather than followed.`,
    );
  }
  if (!info.isFile()) {
    throw conflict(`${what} at ${path} is not a regular file; the migration reads source files, not directories or devices.`);
  }
  return readFileSync(path);
}

function directoryEntries(dir: string, what: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw incomplete(`${what} at ${dir} cannot be listed (${(error as Error).message}), so its coverage cannot be claimed.`);
  }
}

/** The binding shape both file-route levels record (snapshot coordinator and plan session). */
type LegacyBinding = { session_id: string; session_file: string; bound_at: string };

function legacyBinding(value: unknown): LegacyBinding | null {
  if (!isPlainObject(value)) return null;
  const { session_id: sessionId, session_file: sessionFile, bound_at: boundAt } = value;
  if (!isNonEmptyString(sessionId) || !isNonEmptyString(sessionFile) || !isAbsolute(sessionFile) || !isNonEmptyString(boundAt)) {
    return null;
  }
  return { session_id: sessionId, session_file: sessionFile, bound_at: boundAt };
}

// ---------------------------------------------------------------------------
// Source discovery (§6 item 1 inventory)
// ---------------------------------------------------------------------------

const SESSION_DIR = "sessions";
const LEGACY_WRITE_LOCK_DIR = ".status-write.lockdir";
const WORKFLOW_DEFERRED_FILES: ReadonlyArray<{ surface: string; file: string }> = [
  { surface: "workflow-notes-ledger", file: "notes.jsonl" },
  { surface: "workflow-agent-flow-ledger", file: "agent-flow.jsonl" },
  { surface: "workflow-ledger-cursors", file: "workflow-ledger-cursors.json" },
  { surface: "workflow-omp-launch-journal", file: "omp-launches.json" },
];
const SESSION_SURFACE = "workflow-session-envelopes";
const LEGACY_LOCK_SURFACE = "legacy-write-lock";
const ENGINE_STATUS_SURFACE = "engine-status-snapshot";
const ENGINE_STATUS_FILE = "snapshots/engine-status.json";

/** One discovered plan row, with the ownership the legacy row records. */
type DiscoveredPlan = {
  planId: string;
  /** The legacy row verbatim — the input of the frozen-input selection. */
  row: Record<string, unknown>;
  pin: CatalogExecutionPin | null;
  session: LegacyBinding | null;
  /** The legacy lease object verbatim, or `null` when the plan holds none. */
  lease: Record<string, unknown> | null;
};

type DiscoveredWorkflow = {
  entry: WorkflowEntry;
  workflowId: string;
  dir: string;
  snapshotPath: string;
  snapshotSha: string;
  snapshot: WorkflowSnapshot;
  coordinator: LegacyBinding | null;
  plans: DiscoveredPlan[];
};

type DiscoveredSources = {
  root: string;
  rootPath: string;
  rootDoc: StatusV2Doc;
  workflows: DiscoveredWorkflow[];
  witnesses: ExecutionSourceWitness[];
  deferred: ExecutionDeferredSurface[];
  coreHash: string;
};

function deferredSurface(name: string, paths: readonly string[]): ExecutionDeferredSurface {
  const discovered = [...paths].sort();
  return { surface: name, paths: discovered, disposition: discovered.length > 0 ? "blocked" : "absent" };
}

/** A discovered file's byte witness; an unreadable discovered file blocks coverage rather than passing absent. */
function witnessOf(path: string, kind: ExecutionSourceWitness["kind"]): ExecutionSourceWitness {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw incomplete(`${path} exists but cannot be read (${(error as Error).message}), so deferred coverage cannot be claimed.`);
  }
  return { path, sha256: sha256Of(bytes), kind };
}

/**
 * The canonical snapshot of one registered workflow: its bytes (witness), its
 * validated document, and the ONE in-memory normalization the canonical reader
 * also performs (the pre-#264 `control_worktree_path` alias), because the DB
 * header is canonical-only and `readWorkflowView` refuses the alias.
 */
function readSnapshotSource(dir: string, workflowId: string): { path: string; sha256: string; snapshot: WorkflowSnapshot } {
  const path = join(dir, WORKFLOW_SNAPSHOT_FILE);
  const bytes = readSourceBytes(path, `the snapshot of workflow ${workflowId}`, `the snapshot of workflow ${workflowId} is missing at ${path}`);
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw conflict(`the snapshot of workflow ${workflowId} is not valid JSON (${(error as Error).message}).`);
  }
  const gate = validateWorkflowSnapshot(doc);
  if (gate.ok) return { path, sha256: sha256Of(bytes), snapshot: doc as WorkflowSnapshot };
  const onlyAlias = gate.violations.every((violation) => violation.code === LEGACY_WORKTREE_PATH_CODE);
  if (onlyAlias && isPlainObject(doc) && isNonEmptyString(doc.control_worktree_path) && doc.integration_worktree_path === undefined) {
    const { control_worktree_path: _legacy, ...rest } = doc;
    const normalized = { ...rest, integration_worktree_path: doc.control_worktree_path } as unknown as WorkflowSnapshot;
    if (validateWorkflowSnapshot(normalized).ok) {
      return { path, sha256: sha256Of(bytes), snapshot: normalized };
    }
  }
  throw conflict(
    `the snapshot of workflow ${workflowId} does not validate ` +
      `(${gate.violations.map((entry) => `${entry.code}: ${entry.message}`).join("; ")}).`,
  );
}

/**
 * Read and check ONE referenced session envelope (§2.3): the recorded path must
 * live inside the workflow's own `sessions/` dir, the bytes must be the
 * envelope the binding names, and the envelope's identity must agree with that
 * binding and this control root. Only path+hash are kept — never contents.
 */
function readSessionSource(
  binding: LegacyBinding,
  expected: { workflowId: string; role: "coordinator" | "plan-pm"; planId: string | null; dir: string; root: string },
  what: string,
): ExecutionSourceWitness {
  const path = binding.session_file;
  const sessionsDir = join(expected.dir, SESSION_DIR);
  if (!isPathWithin(sessionsDir, path)) {
    throw conflict(
      `${what} records the session envelope ${path}, which is outside ${sessionsDir}. A referenced envelope that escapes ` +
        `the workflow's own sessions dir cannot be verified as this workflow's source.`,
    );
  }
  const bytes = readSourceBytes(
    path,
    `${what}'s session envelope`,
    `${what} records the session envelope ${path}, which does not exist. A missing referenced envelope is a migration ` +
      `conflict: nothing was staged.`,
  );
  let envelope;
  try {
    envelope = readSessionEnvelope(path);
  } catch (error) {
    throw conflict(`${what}'s session envelope at ${path} does not validate (${(error as Error).message}).`);
  }
  if (envelope.role !== expected.role) {
    throw conflict(
      `${what} is recorded as a ${expected.role} binding, but its envelope at ${path} declares role ` +
        `${JSON.stringify(envelope.role)}.`,
    );
  }
  if (envelope.session_id !== binding.session_id) {
    throw conflict(`${what} records session ${binding.session_id}, but its envelope at ${path} declares ${envelope.session_id}.`);
  }
  if (envelope.workflow_id !== expected.workflowId) {
    throw conflict(`${what}'s envelope at ${path} belongs to workflow ${envelope.workflow_id}, not ${expected.workflowId}.`);
  }
  if (expected.role === "plan-pm" && envelope.plan_id !== expected.planId) {
    throw conflict(
      `${what}'s envelope at ${path} declares plan ${JSON.stringify(envelope.plan_id)}, not ${JSON.stringify(expected.planId)}.`,
    );
  }
  if (canonicalPath(envelope.harness_root) !== canonicalPath(expected.root)) {
    throw conflict(`${what}'s envelope at ${path} was issued for control root ${envelope.harness_root}, not ${expected.root}.`);
  }
  return { path: canonicalPath(path), sha256: sha256Of(bytes), kind: "session-envelope" };
}

/**
 * The deferred-surface inventory of one registered workflow dir. Every entry is
 * classified: the core snapshot, the sessions dir, a named deferred surface, or
 * a held/leaked legacy write lockdir. An unclassified entry is
 * `execution.coverage-incomplete` — the inventory never skips what it cannot
 * name.
 */
function scanWorkflowDir(
  dir: string,
  workflowId: string,
  referencedEnvelopes: ReadonlySet<string>,
): { deferred: ExecutionDeferredSurface[]; witnesses: ExecutionSourceWitness[] } {
  const sessions: string[] = [];
  const lockPaths: string[] = [];
  const files = new Map<string, string[]>();
  const witnesses: ExecutionSourceWitness[] = [];

  for (const entry of directoryEntries(dir, `the workflow dir of ${workflowId}`)) {
    if (entry.name === WORKFLOW_SNAPSHOT_FILE) continue;
    if (entry.name === SESSION_DIR) {
      if (!entry.isDirectory()) {
        throw incomplete(`workflows/${workflowId}/${SESSION_DIR} is not a directory, so the session surface cannot be classified.`);
      }
      for (const nested of directoryEntries(join(dir, SESSION_DIR), `the sessions dir of ${workflowId}`)) {
        if (!nested.isFile()) {
          throw incomplete(
            `workflows/${workflowId}/${SESSION_DIR}/${nested.name} is neither a regular file nor a directory entry this ` +
              `inventory classifies (a symlink or a nested directory), so deferred coverage cannot be claimed.`,
          );
        }
        const nestedPath = join(dir, SESSION_DIR, nested.name);
        sessions.push(nestedPath);
        if (!referencedEnvelopes.has(nestedPath)) witnesses.push(witnessOf(nestedPath, "deferred"));
      }
      continue;
    }
    if (entry.name === LEGACY_WRITE_LOCK_DIR) {
      lockPaths.push(join(dir, entry.name));
      continue;
    }
    const known = WORKFLOW_DEFERRED_FILES.find((candidate) => candidate.file === entry.name);
    if (known === undefined) {
      throw incomplete(
        `workflows/${workflowId}/${entry.name} is not a source this inventory classifies. Every entry of a registered ` +
          `workflow dir must be the core snapshot or a named deferred surface; an unclassified entry blocks coverage ` +
          `rather than being skipped.`,
      );
    }
    const surfacePath = join(dir, entry.name);
    files.set(known.surface, [surfacePath]);
    // A directory or symlink where a ledger file belongs still occupies the
    // surface; it is reported blocked rather than treated as absent, and only a
    // real file is hashed as a witness.
    if (entry.isFile()) witnesses.push(witnessOf(surfacePath, "deferred"));
  }

  // Fixed surface order, one entry per known surface, so the same workspace
  // always reads back the same inventory.
  const deferred: ExecutionDeferredSurface[] = [deferredSurface(SESSION_SURFACE, sessions)];
  for (const known of WORKFLOW_DEFERRED_FILES) deferred.push(deferredSurface(known.surface, files.get(known.surface) ?? []));
  deferred.push(deferredSurface(LEGACY_LOCK_SURFACE, lockPaths));
  return { deferred, witnesses };
}

/**
 * The single read-only discovery pass: the root register, every registered
 * workflow snapshot, every referenced session envelope and the full deferred
 * surface inventory, with byte witnesses and the core digest. Writes nothing.
 */
function discoverExecutionSources(context: StoreContext): DiscoveredSources {
  const root = controlRootOf(context);
  const rootPath = join(root, "status.json");
  if (!existsSync(rootPath)) {
    throw incomplete(
      `the control harness at ${root} has no v2 root register (status.json), so there is no execution source to import. ` +
        `A workspace with no execution sources belongs on the empty-execution initializer, not on the migration route.`,
    );
  }
  const rootBytes = readSourceBytes(rootPath, "the root register", `the root register ${rootPath} is missing`);
  let rootDoc: unknown;
  try {
    rootDoc = JSON.parse(rootBytes.toString("utf8"));
  } catch (error) {
    throw conflict(`the root register ${rootPath} is not valid JSON (${(error as Error).message}).`);
  }
  // The root gate is the canonical v2 validator with the harness dir known, so
  // it already enforces the removal-at-terminal invariant: every listed entry's
  // snapshot exists PHYSICALLY under the harness and is non-terminal.
  const rootGate = validateStatusV2(rootDoc as StatusV2Doc, { harnessDir: root });
  if (!rootGate.ok) {
    throw conflict(
      `the root register ${rootPath} does not validate as the v2 active-lifecycle registry ` +
        `(${rootGate.violations.map((entry) => `${entry.code}: ${entry.message}`).join("; ")}).`,
    );
  }
  const doc = rootDoc as StatusV2Doc;
  const witnesses: ExecutionSourceWitness[] = [{ path: rootPath, sha256: sha256Of(rootBytes), kind: "root" }];
  const deferred: ExecutionDeferredSurface[] = [];
  const workflows: DiscoveredWorkflow[] = [];
  const seenDirs = new Map<string, string>();

  for (const entry of doc.workflows) {
    const entryGate = validateWorkflowEntry(entry);
    if (!entryGate.ok) {
      throw conflict(
        `the root register lists an invalid workflow entry ` +
          `(${entryGate.violations.map((violation) => `${violation.code}: ${violation.message}`).join("; ")}).`,
      );
    }
    const workflowId = entry.id;
    const dir = join(root, entry.dir);
    if (!isPathWithin(root, dir) || dir === root) {
      throw conflict(
        `workflow ${workflowId} records dir ${JSON.stringify(entry.dir)}, which does not stay inside the control root ${root}.`,
      );
    }
    const priorHolder = seenDirs.get(dir);
    if (priorHolder !== undefined) {
      throw conflict(
        `workflows ${priorHolder} and ${workflowId} both record the workflow dir ${entry.dir}. Two lifecycles cannot share ` +
          `one snapshot home, and one lock cannot serialize both; nothing was staged.`,
      );
    }
    seenDirs.set(dir, workflowId);
    let dirInfo: Stats;
    try {
      dirInfo = lstatSync(dir);
    } catch {
      throw conflict(`workflow ${workflowId} records dir ${entry.dir}, which does not exist at ${dir}.`);
    }
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
      throw conflict(`workflow ${workflowId}'s dir ${dir} is not a real directory under the control root.`);
    }

    const snapshotSource = readSnapshotSource(dir, workflowId);
    witnesses.push({ path: snapshotSource.path, sha256: snapshotSource.sha256, kind: "workflow" });

    const coordinator = legacyBinding(snapshotSource.snapshot.coordination?.coordinator);
    if (snapshotSource.snapshot.coordination !== undefined && coordinator === null) {
      throw conflict(`workflow ${workflowId} carries a coordinator block that is not a complete session binding.`);
    }
    const envelopes: ExecutionSourceWitness[] = [];
    if (coordinator !== null) {
      envelopes.push(
        readSessionSource(
          coordinator,
          { workflowId, role: "coordinator", planId: null, dir, root },
          `workflow ${workflowId}'s coordinator binding`,
        ),
      );
    }

    const plans: DiscoveredPlan[] = [];
    const seenPlans = new Set<string>();
    const scope = { workflowId, dir, root };
    for (const row of snapshotSource.snapshot.plans) {
      const planRow = row as Record<string, unknown>;
      const planId = rowPlanId(row);
      if (!isNonEmptyString(planId)) throw conflict(`workflow ${workflowId} lists a plan row with no canonical plan id.`);
      if (seenPlans.has(planId)) throw conflict(`workflow ${workflowId} lists plan ${planId} twice \u2014 a plan row is one identity.`);
      seenPlans.add(planId);
      const block = isPlainObject(planRow.coordination) ? planRow.coordination : undefined;
      const session = block === undefined ? null : legacyBinding(block.session);
      if (block !== undefined && block.session !== undefined && session === null) {
        throw conflict(`plan ${planId} of workflow ${workflowId} carries a session binding that is not complete.`);
      }
      if (session !== null) {
        envelopes.push(readSessionSource(session, { ...scope, role: "plan-pm", planId }, `plan ${planId}`));
      }
      const leaseValue = planRow.execution_lease;
      if (leaseValue !== undefined) {
        const leaseGate = validateExecutionLease(leaseValue);
        if (!leaseGate.ok) {
          throw conflict(
            `plan ${planId} of workflow ${workflowId} holds an execution lease that does not validate ` +
              `(${leaseGate.violations.map((violation) => `${violation.code}: ${violation.message}`).join("; ")}).`,
          );
        }
      }
      plans.push({
        planId,
        row: planRow,
        pin: suppliedCatalogPin(planRow, workflowId, planId),
        session,
        lease: isPlainObject(leaseValue) ? leaseValue : null,
      });
    }

    const scan = scanWorkflowDir(dir, workflowId, new Set(envelopes.map((witness) => witness.path)));
    witnesses.push(...envelopes, ...scan.witnesses);
    deferred.push(...scan.deferred);
    workflows.push({
      entry,
      workflowId,
      dir,
      snapshotPath: snapshotSource.path,
      snapshotSha: snapshotSource.sha256,
      snapshot: snapshotSource.snapshot,
      coordinator,
      plans,
    });
  }

  const engineStatusPath = join(root, ENGINE_STATUS_FILE);
  if (existsSync(engineStatusPath)) {
    // The harness-level execution-status file is a deferred surface like any
    // other, so a present one is witnessed by its bytes too.
    witnesses.push(witnessOf(engineStatusPath, "deferred"));
    deferred.push(deferredSurface(ENGINE_STATUS_SURFACE, [engineStatusPath]));
  } else {
    deferred.push(deferredSurface(ENGINE_STATUS_SURFACE, []));
  }

  return {
    root,
    rootPath,
    rootDoc: doc,
    workflows,
    witnesses,
    deferred,
    coreHash: digestOf({
      root: { path: rootPath, sha256: sha256Of(rootBytes) },
      workflows: workflows.map((workflow) => ({
        workflowId: workflow.workflowId,
        snapshotPath: workflow.snapshotPath,
        snapshotSha: workflow.snapshotSha,
        inputs: workflow.plans.map((plan) => ({ planId: plan.planId, inputHash: executionInputHash(plan.row, plan.planId) })),
      })),
    }),
  };
}

// ---------------------------------------------------------------------------
// Preview (§6 item 1)
// ---------------------------------------------------------------------------

/** §7 the pending-registration half: a non-committed catalog operation blocks migration. */
function pendingCatalogOperations(db: StoreDb): string[] {
  const rows = db
    .prepare(
      "select operation_id from catalog_operations where phase in ('prepared','execution-written') " +
        "order by updated_at asc, operation_id asc",
    )
    .all() as Array<{ operation_id?: unknown }>;
  return rows.map((row) => (typeof row.operation_id === "string" ? row.operation_id : "<unreadable>"));
}

function catalogRevisionOf(db: StoreDb): number {
  const row = db.prepare("select catalog_revision from store_meta where id = 1").get() as { catalog_revision?: unknown } | undefined;
  if (typeof row?.catalog_revision !== "number") {
    throw conflict("store_meta.catalog_revision is missing; the issue/catalog identity of this store cannot be verified.");
  }
  return row.catalog_revision;
}

/**
 * `previewExecutionMigration` — the read-only planner (§6 item 1): validate
 * every root entry and snapshot, every referenced session/lease identity, the
 * normalized roots, the imported catalog pins and the pending registration
 * journal; inventory the deferred surfaces; and return the canonical manifest
 * with byte witnesses and the core digest. It saves nothing to protected state:
 * it opens the store read-only, reads source files and returns a value.
 *
 * Refusals are the two migration verdicts of §5 —
 * `execution.coverage-incomplete` when the inventory cannot be closed, and
 * `execution.migration-conflict` when discovered legacy content contradicts the
 * execution model (a missing referenced envelope, an identity mismatch, a
 * foreign pin, a pending journal, a malformed source document, a symlinked
 * source) or when the store is not on the migration route at all (already
 * active).
 */
export async function previewExecutionMigration(input: ExecutionMigrationInput): Promise<ExecutionManifest> {
  const { context } = resolveMigrationInput(input, "preview");
  const handle = await openStore(context, "read");
  try {
    const execution = handle.execution;
    if (execution === null) {
      throw new ExecutionError(
        "execution.not-active",
        "this store predates the execution schema, so it has no execution authority to stage into. Upgrade the store to " +
          "migration 4 before previewing an execution migration.",
      );
    }
    if (execution.authorityState === "active") {
      throw conflict(
        "the execution authority is already ACTIVE; there is no staged migration to review. A manifest stages into a " +
          "legacy or staged authority only.",
      );
    }
    const catalogRevision = catalogRevisionOf(handle.db);
    const pending = pendingCatalogOperations(handle.db);
    if (pending.length > 0) {
      throw conflict(
        `${pending.length} catalog operation(s) are still pending (${pending.join(", ")}). A pending registration must be ` +
          `resolved with the legacy reconcile while JSON still owns execution (\u00a77); nothing was staged.`,
      );
    }
    const discovered = discoverExecutionSources(context);
    // §7 the pin half of the inventory: the frozen selections and any committed
    // catalog binding must agree, checked here so a disagreement is a preview
    // verdict rather than a surprise at apply time.
    for (const workflow of discovered.workflows) assertCatalogCoherence(handle.db, workflow, handle.storeId);
    const body: Omit<ExecutionManifest, "id"> = {
      version: EXECUTION_MIGRATION_MANIFEST_VERSION,
      storeId: handle.storeId,
      epoch: handle.epoch,
      schemaVersion: handle.schemaVersion,
      root: discovered.root,
      sources: discovered.witnesses,
      coreHash: discovered.coreHash,
      deferred: discovered.deferred,
      catalogRevision,
      pendingCatalogOperations: pending,
    };
    return { ...body, id: `exec-${digestOf(body).slice(0, 32)}` };
  } finally {
    handle.close();
  }
}

// ---------------------------------------------------------------------------
// Staged apply (§6 item 2)
// ---------------------------------------------------------------------------

/**
 * Test-runner-gated crash seam (the same gate every other failure injection in
 * the store uses): throw after `n` imported workflows, so "a transaction
 * failure leaves no partial staged rows" is reproduced rather than described.
 */
function importFailureHook(imported: number): void {
  const raw = process.env.MSTAR_STORE_FAIL_EXECUTION_IMPORT_AFTER;
  if (process.env.MSTAR_STORE_TEST_RUNNER !== "1" || raw === undefined) return;
  const limit = Number.parseInt(raw, 10);
  if (Number.isInteger(limit) && imported === limit) {
    throw new Error(`induced execution-import failure after ${limit} workflow(s)`);
  }
}

const LOCK_WAIT_MS = 30_000;

/**
 * The bounded wait for every level of the apply lock ladder. It is the same
 * operation's wait at each level, so one bound serves all of them (and the
 * test-runner-gated override is what lets the ordering be proven without a
 * 30-second unit test).
 */
function migrationLockWaitMs(): number {
  if (process.env.MSTAR_STORE_TEST_RUNNER === "1") {
    const parsed = Number.parseInt(process.env.MSTAR_EXECUTION_MIGRATION_LOCK_WAIT_MS ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return LOCK_WAIT_MS;
}

/**
 * The §4.2 outer lock every file-touching migration/retire/restore step takes
 * first. `withStatusWriteLock` derives `<dirname(target)>/.status-write.lockdir`
 * from the target it is given, so the maintenance key is a FILE under
 * `<harness>/.execution-maintenance/`: naming that directory itself would reuse
 * the root status lockdir and the documented order (maintenance → root →
 * workflow → SQL) could never be acquired.
 */
async function withExecutionMaintenanceLock<T>(context: StoreContext, fn: () => Promise<T>): Promise<T> {
  const key = join(controlRootOf(context), ".execution-maintenance", "execution-migration");
  mkdirSync(dirname(key), { recursive: true });
  return withStatusWriteLock(key, fn, { timeoutMs: migrationLockWaitMs() });
}

/** Hold every lock in `paths` (already ordered) for the whole of `fn`. */
async function withAllLocks<T>(paths: readonly string[], fn: () => Promise<T>): Promise<T> {
  const [head, ...rest] = paths;
  if (head === undefined) return fn();
  return withStatusWriteLock(head, () => withAllLocks(rest, fn), { timeoutMs: migrationLockWaitMs() });
}

/** The reviewed manifest, checked against the hash the caller hands back and the control root it was reviewed for. */
function requireReviewedManifest(
  manifest: ExecutionManifest | undefined,
  manifestHash: string | undefined,
  context: StoreContext,
): ExecutionManifest {
  if (!manifest || manifest.version !== EXECUTION_MIGRATION_MANIFEST_VERSION) {
    throw conflict("the manifest is missing or carries an unsupported version; re-run the preview and review it.");
  }
  if (typeof manifestHash !== "string" || manifestHash.trim() === "") {
    throw conflict("the apply request must carry the reviewed manifest hash; nothing was staged.");
  }
  const recomputed = executionManifestHash(manifest);
  if (!sameBytesDigest(recomputed, manifestHash)) {
    throw conflict(
      `the manifest does not hash to the reviewed value (recomputed ${recomputed}, supplied ${manifestHash}); the document ` +
        `and its hash must be the pair the reviewer saw.`,
    );
  }
  const root = controlRootOf(context);
  if (canonicalPath(manifest.root) !== root) {
    throw conflict(`the manifest was reviewed for control root ${manifest.root}, not ${root}; nothing was staged.`);
  }
  return manifest;
}

/** §2.3 an imported binding is recorded SUSPENDED: it authorizes nothing, ever. */
function insertSession(
  tx: ExecutionTransaction,
  input: { workflowId: string; role: "coordinator" | "plan-pm"; planId: string | null; binding: LegacyBinding },
): void {
  tx.db
    .prepare(
      "insert into execution_sessions(workflow_id, role, session_id, plan_id, epoch, revision, state, bound_at) " +
        "values (?, ?, ?, ?, ?, 1, 'suspended', ?)",
    )
    .run(input.workflowId, input.role, input.binding.session_id, input.planId, tx.epoch, input.binding.bound_at);
}

/**
 * §2.2 a held lease is imported WITH its ownership: the holder identity/role
 * the file route recorded (the plan's own plan-pm session, or the coordinator a
 * transfer moved it to) plus the DB-only observation fields
 * `writeInitialExecutionLease` writes. A holder that resolves to neither owner
 * is an orphan held lease and refuses (§6 item 1).
 */
function insertExecutionLease(tx: ExecutionTransaction, workflow: DiscoveredWorkflow, plan: DiscoveredPlan): void {
  const lease = plan.lease!;
  const holder = lease.holder as string;
  const planSessionId = plan.session?.session_id ?? null;
  const coordinatorId = workflow.coordinator?.session_id ?? null;
  const owner =
    coordinatorId !== null && coordinatorId === holder
      ? ({ role: "coordinator", sessionId: holder } as const)
      : planSessionId !== null && planSessionId === holder
        ? ({ role: "plan-pm", sessionId: holder } as const)
        : null;
  if (owner === null) {
    throw conflict(
      `plan ${plan.planId} of workflow ${workflow.workflowId} holds an execution lease whose holder ${JSON.stringify(holder)} ` +
        `resolves to neither the workflow's recorded coordinator nor this plan's recorded plan session. An orphan held ` +
        `lease has no owner to import; nothing was staged.`,
    );
  }
  tx.db
    .prepare("insert into execution_leases(workflow_id, plan_id, revision, owner_epoch, lease_json) values (?, ?, 1, ?, ?)")
    .run(
      workflow.workflowId,
      plan.planId,
      tx.epoch,
      JSON.stringify({
        ...lease,
        lease_id: randomUUID(),
        holder_session_id: owner.sessionId,
        holder_role: owner.role,
        plan_worktree_path: lease.worktree_path,
        plan_branch: lease.working_branch,
        heartbeat_at: lease.claimed_at,
        status: "held",
      }),
    );
}

/**
 * §7 the catalog half of the import check: a plan's recorded pin and the
 * committed `catalog_execution_bindings` row must agree, and neither side wins
 * silently. A plan without a binding row has nothing to disagree with, and a pin
 * that names another store is never imported as this store's frozen selection.
 */
function assertCatalogCoherence(db: StoreDb, workflow: DiscoveredWorkflow, storeId: string): void {
  const rows = db
    .prepare("select catalog_kind, catalog_id, input_hash, pin_json from catalog_execution_bindings where workflow_id = ?")
    .all(workflow.workflowId) as Array<{
    catalog_kind?: unknown;
    catalog_id?: unknown;
    input_hash?: unknown;
    pin_json?: unknown;
  }>;
  for (const plan of workflow.plans) {
    if (plan.pin === null) continue;
    if (plan.pin.store_id !== storeId) {
      throw conflict(
        `plan ${plan.planId} of workflow ${workflow.workflowId} pins catalog store ${plan.pin.store_id}, not this store ` +
          `(${storeId}); a foreign selection is never imported as this store's frozen input.`,
      );
    }
    const binding = rows.find((row) => row.catalog_kind === "plan" && row.catalog_id === plan.planId);
    if (binding === undefined) continue;
    const inputHash = executionInputHash(plan.row, plan.planId);
    if (typeof binding.input_hash === "string" && binding.input_hash !== inputHash) {
      throw conflict(
        `plan ${plan.planId} of workflow ${workflow.workflowId} records catalog binding input hash ${binding.input_hash} ` +
          `while its sealed selection hashes to ${inputHash}; neither side wins silently.`,
      );
    }
    if (typeof binding.pin_json === "string") {
      let recorded: unknown;
      try {
        recorded = JSON.parse(binding.pin_json);
      } catch {
        throw conflict(
          `plan ${plan.planId} of workflow ${workflow.workflowId} records a catalog binding whose pin payload is not JSON, ` +
            `so the frozen selection cannot be reconciled with it.`,
        );
      }
      if (!isPlainObject(recorded) || serializeExecutionValue(recorded) !== serializeExecutionValue(plan.pin)) {
        throw conflict(
          `plan ${plan.planId} of workflow ${workflow.workflowId} records a catalog pin that disagrees with its catalog ` +
            `binding; neither side wins silently.`,
        );
      }
    }
  }
}

/** Import one discovered workflow and its ownership records (§2.2). */
function importWorkflow(tx: ExecutionTransaction, workflow: DiscoveredWorkflow, now: string): void {
  const { workflowId, entry, snapshot } = workflow;
  const header: Record<string, unknown> = { ...(snapshot as unknown as Record<string, unknown>) };
  delete header.plans;
  delete header.coordination;
  delete header.integration_merge_lease;
  const headerGate = validateWorkflowSnapshot({ ...header, plans: [] });
  if (!headerGate.ok) {
    throw conflict(
      `workflow ${workflowId}'s header would not validate on the DB transport ` +
        `(${headerGate.violations.map((violation) => `${violation.code}: ${violation.message}`).join("; ")}).`,
    );
  }
  tx.db
    .prepare(
      "insert into execution_workflows(workflow_id, revision, creator_session_id, state_json, created_at, updated_at) " +
        "values (?, 1, null, ?, ?, ?)",
    )
    .run(workflowId, JSON.stringify(header), now, now);
  tx.db.prepare("insert into execution_registry(workflow_id, entry_json) values (?, ?)").run(workflowId, JSON.stringify(entry));

  if (workflow.coordinator !== null) {
    insertSession(tx, { workflowId, role: "coordinator", planId: null, binding: workflow.coordinator });
  }

  const insertPlan = tx.db.prepare(
    "insert into execution_plans(workflow_id, plan_id, revision, ordinal, state_json, coordination_json) " +
      "values (?, ?, 1, ?, ?, ?)",
  );
  const insertInput = tx.db.prepare(
    "insert into execution_inputs(workflow_id, plan_id, revision, input_json, input_hash, catalog_pin_json) " +
      "values (?, ?, 1, ?, ?, ?)",
  );
  // §D/§A1 the shape the SHARED route rules read: plan identities projected in
  // once, exactly as `readWorkflowView` builds it, so the standalone-route
  // decision is the shared rule's and not a second copy of it.
  const routeSnapshot = {
    ...(snapshot as unknown as WorkflowSnapshot),
    plans: workflow.plans.map((plan) => ({ id: plan.planId }) as Record<string, unknown>),
  } as WorkflowSnapshot;

  workflow.plans.forEach((plan, ordinal) => {
    const { planId, row } = plan;
    const state: Record<string, unknown> = { ...row, id: planId };
    delete state.coordination;
    delete state.execution_lease;
    const stateGate = validatePlanRow(state);
    if (!stateGate.ok) {
      throw conflict(
        `plan ${planId} of workflow ${workflowId} would not validate on the DB transport ` +
          `(${stateGate.violations.map((violation) => `${violation.code}: ${violation.message}`).join("; ")}).`,
      );
    }
    const block: Record<string, unknown> = isPlainObject(row.coordination) ? { ...row.coordination } : {};
    delete block.revision;
    delete block.session;
    // §2.2/§D the stored block is validated by the SHARED rules; the bound plan
    // session lives in `execution_sessions`, so the handoff's "requires a bound
    // plan session" half is checked here as the state a rebind re-attaches to.
    const violations = storedCoordinationViolations(block, {
      revision: 1,
      route: rowValidationRoute(routeSnapshot, state as never),
      sessionBound: true,
      what: `execution_plans(${workflowId},${planId}).coordination_json`,
    });
    if (violations.length > 0) {
      throw conflict(
        `plan ${planId} of workflow ${workflowId} carries a coordination block the DB transport would refuse ` +
          `(${violations.map((violation) => `${violation.code}: ${violation.message}`).join("; ")}).`,
      );
    }
    insertPlan.run(workflowId, planId, ordinal, JSON.stringify(state), JSON.stringify(block));
    insertInput.run(
      workflowId,
      planId,
      JSON.stringify(executionInputSelection(row, planId)),
      executionInputHash(row, planId),
      plan.pin === null ? null : JSON.stringify(plan.pin),
    );

    if (plan.session !== null) {
      insertSession(tx, { workflowId, role: "plan-pm", planId, binding: plan.session });
    }
    if (plan.lease !== null) insertExecutionLease(tx, workflow, plan);
  });

  const mergeLease = snapshot.integration_merge_lease;
  if (mergeLease !== undefined) {
    // §2.2/§3 the merge lease is the workflow-wide exclusive claim, and only a
    // coordinator merges: without a recorded coordinator binding the claim has
    // no owner to import. The row mirrors the DB writer's own shape (the claim
    // plus its status) rather than inventing a second one.
    if (workflow.coordinator === null) {
      throw conflict(
        `workflow ${workflowId} holds an integration merge lease (holder ` +
          `${JSON.stringify((mergeLease as Record<string, unknown>).holder)}) but records no coordinator binding, so the ` +
          `claim has no owner to import. Nothing was staged.`,
      );
    }
    tx.db
      .prepare("insert into execution_integration_leases(workflow_id, revision, owner_epoch, lease_json) values (?, 1, ?, ?)")
      .run(workflowId, tx.epoch, JSON.stringify({ ...(mergeLease as Record<string, unknown>), status: "held" }));
  }
}

/**
 * `applyExecutionMigration` — the reviewed staged apply (§6 item 2): require a
 * verified recovery point, take the maintenance/root/workflow locks in §4.2
 * order, recheck every witness and every identity against the reviewed
 * manifest, and insert all core rows plus the staged manifest record in ONE
 * database transaction.
 *
 * It never activates. Execution authority ends `staged`, ordinary DB verbs
 * refuse `execution.not-active`, the JSON route stays live, every source byte is
 * left exactly as it was, existing issue/catalog rows and revisions are
 * untouched, and imported sessions are suspended.
 */
export async function applyExecutionMigration(
  input: ExecutionMigrationInput & { manifest: ExecutionManifest; manifestHash: string; backup: BackupReceipt },
): Promise<ExecutionMigrationReceipt> {
  const { context } = resolveMigrationInput(input, "apply");
  const manifest = requireReviewedManifest(input.manifest, input.manifestHash, context);
  // §6 item 2: the recovery point is re-verified against the reviewed authority
  // and the bytes it names BEFORE any lock is taken or any byte is written.
  await assertBackupDescribesStore(context, input.backup, {
    storeId: manifest.storeId,
    epoch: manifest.epoch,
    schemaVersion: manifest.schemaVersion,
    catalogRevision: manifest.catalogRevision,
  });
  // The workflow locks come from a discovery pass so they can be taken before
  // the transaction. It is not the authority for the import: the same discovery
  // runs again inside the transaction and every witness is compared against the
  // reviewed manifest, so a register that changed between the two cannot reach
  // the rows.
  const prelock = discoverExecutionSources(context);
  const workflowLocks = [...prelock.workflows]
    .sort((a, b) => a.workflowId.localeCompare(b.workflowId))
    .map((workflow) => join(workflow.dir, WORKFLOW_SNAPSHOT_FILE));

  return withExecutionMaintenanceLock(context, () =>
    withStatusWriteLock(
      prelock.rootPath,
      () =>
        withAllLocks(workflowLocks, () =>
          withExecutionTransaction(context, (tx) => {
            const discovered = discoverExecutionSources(context);
            if (discovered.witnesses.length !== manifest.sources.length) {
              throw conflict(
                `the source set changed since the preview (${manifest.sources.length} reviewed witness(es), ` +
                  `${discovered.witnesses.length} found). Re-preview the migration; nothing was staged.`,
              );
            }
            for (const [index, reviewed] of manifest.sources.entries()) {
              const found = discovered.witnesses[index]!;
              if (reviewed.path !== found.path || reviewed.kind !== found.kind || !sameBytesDigest(reviewed.sha256, found.sha256)) {
                throw conflict(
                  `source ${reviewed.path} no longer holds the reviewed bytes (${reviewed.kind}). Re-preview the migration; ` +
                    `nothing was staged.`,
                );
              }
            }
            if (!sameBytesDigest(discovered.coreHash, manifest.coreHash)) {
              throw conflict("the core authority content changed since the preview; nothing was staged.");
            }
            if (manifest.storeId !== tx.storeId || manifest.epoch !== tx.epoch) {
              throw conflict(
                `the manifest was reviewed against store ${manifest.storeId} epoch ${manifest.epoch}, but the live store is ` +
                  `${tx.storeId} epoch ${tx.epoch}. Re-preview against the current authority; nothing was staged.`,
              );
            }
            const schema = tx.db.prepare("select max(version) as v from schema_version").get() as { v?: unknown } | undefined;
            if (typeof schema?.v !== "number" || schema.v !== manifest.schemaVersion) {
              throw conflict(
                `the store schema changed since the preview (reviewed ${manifest.schemaVersion}, found ` +
                  `${String(schema?.v)}); nothing was staged.`,
              );
            }
            if (catalogRevisionOf(tx.db) !== manifest.catalogRevision) {
              throw conflict("the issue/catalog revision changed since the preview; nothing was staged.");
            }
            const pending = pendingCatalogOperations(tx.db);
            if (pending.length > 0) {
              throw conflict(
                `${pending.length} catalog operation(s) became pending since the preview (${pending.join(", ")}); nothing was staged.`,
              );
            }
            if (tx.execution.authorityState === "active") {
              throw conflict("the execution authority is ACTIVE; a manifest stages into a legacy or staged authority only.");
            }

            const recorded = tx.db
              .prepare("select manifest_hash, phase from execution_migrations where manifest_id = ?")
              .get(manifest.id) as { manifest_hash?: unknown; phase?: unknown } | undefined;
            if (recorded !== undefined) {
              if (recorded.manifest_hash !== input.manifestHash) {
                throw conflict(
                  `manifest ${manifest.id} is already recorded with a different hash (${String(recorded.manifest_hash)}); ` +
                    `another manifest is staged under this id, and only an explicit abort can replace it.`,
                );
              }
              if (recorded.phase !== "staged") {
                throw conflict(
                  `manifest ${manifest.id} is recorded ${String(recorded.phase)}; only a staged manifest re-applies ` +
                    `idempotently, and an aborted one needs a re-preview under a new manifest.`,
                );
              }
              return { manifestId: manifest.id, phase: "staged" as const, replayed: true };
            }
            const otherStaged = tx.db
              .prepare("select manifest_id from execution_migrations where phase = 'staged'")
              .all() as Array<{ manifest_id?: unknown }>;
            if (otherStaged.length > 0) {
              throw conflict(
                `${otherStaged.length} other manifest(s) are already staged ` +
                  `(${otherStaged.map((row) => String(row.manifest_id)).join(", ")}); abort that migration before staging another.`,
              );
            }
            for (const table of [
              "execution_workflows",
              "execution_registry",
              "execution_plans",
              "execution_sessions",
              "execution_leases",
              "execution_integration_leases",
              "execution_inputs",
              "execution_operations",
            ]) {
              const count = tx.db.prepare(`select count(*) as n from ${table}`).get() as { n?: unknown } | undefined;
              if (typeof count?.n === "number" && count.n > 0) {
                throw conflict(
                  `${table} already holds ${count.n} row(s) while the execution authority is ` +
                    `${tx.execution.authorityState}; nothing was staged.`,
                );
              }
            }

            const now = new Date().toISOString();
            for (const [index, workflow] of discovered.workflows.entries()) {
              assertCatalogCoherence(tx.db, workflow, tx.storeId);
              importWorkflow(tx, workflow, now);
              importFailureHook(index + 1);
            }
            tx.db
              .prepare(
                "insert into execution_migrations(manifest_id, manifest_hash, phase, manifest_json, activation_receipt_json, " +
                  "retirement_json, created_at, updated_at) values (?, ?, 'staged', ?, null, null, ?, ?)",
              )
              .run(manifest.id, input.manifestHash, serializeExecutionValue(manifest), now, now);
            // §2.2 the root revision advances ONCE (registry membership and the
            // authority state both changed in this one transaction) and the store
            // revision advances once for the multi-domain write. The epoch does
            // NOT move: activation owns the single epoch bump (§6 item 3).
            tx.db
              .prepare(
                "update execution_meta set authority_state = 'staged', revision = revision + 1, root_updated_at = ?, " +
                  "manifest_id = ? where id = 1",
              )
              .run(discovered.rootDoc.updated_at, manifest.id);
            tx.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
            return { manifestId: manifest.id, phase: "staged" as const, replayed: false };
          }),
        ),
      { timeoutMs: migrationLockWaitMs() },
    ),
  );
}
