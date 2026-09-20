/**
 * execution-migrate.ts — the executable §6 migration protocol: the read-only
 * preview and staged import (items 1–2, R1) followed by activation,
 * filesystem retirement and staged abort (items 3–5, R2), on §2.2's owned
 * fields, §2.3's session semantics and §7's catalog coexistence.
 *
 * Task ownership (plan `20260920-activation-migration-recovery`): R1 landed
 * `previewExecutionMigration` and `applyExecutionMigration`; R2 adds
 * `activateExecutionMigration`, `retireExecutionSources` and
 * `abortExecutionMigration`; backup, restore and diagnostic export are R3.
 * `apply` never activates: it writes staged rows and leaves execution
 * authority `staged`, where `legacy` and `staged` both keep the unchanged
 * JSON execution route (§2.1) — so JSON remains the sole live execution
 * authority after `apply` returns, and an ordinary execution read refuses
 * `execution.not-active`.
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
 *
 * ## The barrier (R2, §6 item 3)
 *
 * `activateExecutionMigration` is the single cutover. It takes the manifest id
 * and hash the reviewer handed back — never a manifest document — re-reads the
 * recorded staged manifest, and refuses unless it still describes the world:
 * the exact witness bytes, the core digest, the deferred coverage
 * classification, an empty pending catalog journal, the store identity, the
 * `expectedEpoch` CAS, the reviewed schema and the operator's own identity.
 * Only then does ONE transaction advance the store-wide epoch, flip
 * `execution_meta` to `active`, revoke the imported sessions and record the
 * activation receipt. A crash before that commit leaves exactly the staged
 * (JSON-live) authority; a crash after it leaves exactly the active one, and a
 * retry of the same pair returns the recorded receipt instead of a second
 * epoch bump.
 *
 * Three preconditions are the barrier rather than decoration:
 *
 * - **every deferred surface must be ABSENT.** Guides/deferred-2b.md
 *   "Complete coverage rule": 2a accepts a deferred surface only when the
 *   discovery proves it absent, so a real envelope-bearing workspace stays
 *   staged. There is no allow-incomplete flag, and none is accepted;
 * - **the attestation must cover the frozen owner inventory.** The owners the
 *   import recorded (the session envelopes it witnessed) are exactly the
 *   sessions the attestation must name as stopped/reloaded — a missing one is
 *   an owner nobody observed stopped, an extra one is a claim the inventory
 *   cannot justify — and at least one attested consumer must actually have
 *   adopted this build;
 * - **imported ownership is revoked, never adopted.** Sessions become
 *   `revoked` at their own (pre-bump) epoch and every imported lease keeps its
 *   `owner_epoch`, so it is REPRESENTED and authorizes nothing (§2.2). The
 *   receipt names the required reconciliation — `recoverExecutionCoordinator`
 *   for each workflow, `bindExecutionSession` for each plan, explicit
 *   `reconcile` for a suspended lease — so no caller discovers it by
 *   arithmetic (residual R13).
 *
 * The barrier reads its staged rows through this module's own diagnostic SQL,
 * never through `readExecutionState`: that reader requires an ACTIVE plan-pm
 * session for a handoff-bearing plan, which a suspended import cannot have
 * (§2.2 + §2.3, residual R13). It re-reads the graph and refuses a store whose
 * workflows, plans, sealed inputs or session rows are not exactly the reviewed
 * import, then activates precisely that graph.
 *
 * ## Retirement and abort (R2, §6 items 4–5)
 *
 * `retireExecutionSources` runs only behind an active receipt and moves the
 * EXACT unchanged core sources — the root register and the registered workflow
 * snapshots, never a session envelope, note ledger, launch journal or
 * host-owned status file — into manifest-addressed read-only history under
 * `<harness>/archived/execution/<manifestId>/`. Same-filesystem rename plus a
 * checksum check; a source that is absent while its archive copy holds the
 * reviewed bytes is already done; a source and destination that disagree
 * refuse without overwriting either. Per-item progress is durable in the
 * archive's own `retirement.json`, so a crash after a rename and before the
 * receipt resumes from the destination hash, and the DB receipt is written
 * last. A resume may contribute per-item PROGRESS only: every addressed field
 * of the durable ledger is reconciled against the reviewed manifest before any
 * rename, and every destination is the manifest's own, so an edited ledger can
 * neither redirect a move outside the archive nor claim progress for a file the
 * manifest does not address. Partial retirement never returns authority to
 * JSON: the store stays `active` throughout.
 *
 * `abortExecutionMigration` is staged-only and DB-only. Active and retired
 * manifests cannot abort, so it can never return a live authority to JSON or
 * remove active data. It deletes exactly the addressed manifest's staged rows
 * in one transaction, preserves issue/catalog and every source byte, records
 * the aborted receipt (the schema has no dedicated abort column, so the
 * activation-receipt column carries the self-describing, phase-guarded record)
 * and leaves `execution_meta` `legacy` — which is what lets changed legacy
 * input be previewed and applied anew under a fresh manifest instead of a
 * hidden merge.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  executionInputHash,
  executionInputSelection,
  readSessionEnvelope,
  type CatalogExecutionPin,
} from "./coordination.js";
import { isNonEmptyString, isPlainObject } from "./coordination-write.js";
import { storedCoordinationViolations } from "./coordination-transitions.js";
import { validateExecutionLease, withStatusWriteLock, type ExecutionLease, type IntegrationMergeLease } from "./lease.js";
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
import {
  assertBackupDescribesStore,
  canonicalPath,
  isPathWithin,
  validateActivationAttestation,
  StoreActivationError,
  type ActivationAttestation,
  type BackupReceipt,
} from "./store-activation.js";
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

/**
 * §6 item 3: the activation request — the recorded manifest's identity (never
 * its document: the barrier re-reads the staged record and hashes it itself),
 * the epoch the reviewer observed, and the operator attestation.
 */
export type ExecutionMigrationActivationInput = ExecutionMigrationInput & {
  manifestId: string;
  manifestHash: string;
  expectedEpoch: number;
  attestation: ActivationAttestation;
};

/** §6 item 4: the retirement request — which recorded manifest's core sources move. */
export type ExecutionMigrationRetireInput = ExecutionMigrationInput & { manifestId: string; manifestHash: string };

/** §6 item 5: the staged abort request, with the reason the abort is recorded under. */
export type ExecutionMigrationAbortInput = ExecutionMigrationInput & { manifestId: string; manifestHash: string; reason: string };

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

/**
 * The listing primitive of the inventory, in CANONICAL order. The manifest is
 * content-addressed and `apply` compares witnesses by array index, so a
 * directory's inventory must be a function of its content — never of the order
 * a filesystem happens to enumerate it in. Entries are ordered by name in
 * code-unit order, the same order `deferredSurface` sorts a surface's paths
 * with, so the same unchanged workspace always reads back the same manifest.
 */
function directoryEntries(dir: string, what: string): Dirent[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw incomplete(`${what} at ${dir} cannot be listed (${(error as Error).message}), so its coverage cannot be claimed.`);
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
  /**
   * §2.3 the frozen OWNER inventory: every session identity the discovered
   * bindings and their envelopes resolve to. This is what the activation
   * attestation has to cover with stop evidence, because these are exactly the
   * references the barrier revokes.
   */
  owners: DiscoveredOwner[];
  coreHash: string;
};

/** One discovered session identity, in canonical (workflow, coordinator-then-plans) order. */
type DiscoveredOwner = {
  workflowId: string;
  role: "coordinator" | "plan-pm";
  sessionId: string;
  planId: string | null;
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
  const owners: DiscoveredOwner[] = [];
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
      owners.push({ workflowId, role: "coordinator", sessionId: coordinator.session_id, planId: null });
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
        owners.push({ workflowId, role: "plan-pm", sessionId: session.session_id, planId });
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
    owners,
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

/**
 * §6 the reviewed manifest against ONE locked discovery: the witness set
 * (count, path, kind, bytes), the core digest, the deferred coverage
 * classification and the pending catalog journal. `apply` and `activate` must
 * both refuse the same drift, so both run this one rule rather than two
 * drifting copies of it.
 *
 * `selfHeldLockDirs` are the legacy write-lock paths THIS caller holds for the
 * duration of its own transaction: they occupy a discovered surface without the
 * workspace having changed, so they are removed from the FOUND inventory (and
 * from nothing else) before the comparison — a leaked lock that appeared since
 * the preview is still a coverage change while the lock this caller holds is
 * not.
 */
function assertReviewedManifestHolds(input: {
  manifest: ExecutionManifest;
  discovered: DiscoveredSources;
  selfHeldLockDirs: ReadonlySet<string>;
  pendingCatalogOperations: string[];
}): void {
  const { manifest, discovered, selfHeldLockDirs, pendingCatalogOperations } = input;
  if (discovered.witnesses.length !== manifest.sources.length) {
    throw conflict(
      `the source set changed since the preview (${manifest.sources.length} reviewed witness(es), ` +
        `${discovered.witnesses.length} found). Re-preview the migration; nothing was written.`,
    );
  }
  for (const [index, reviewed] of manifest.sources.entries()) {
    const found = discovered.witnesses[index]!;
    if (reviewed.path !== found.path || reviewed.kind !== found.kind || !sameBytesDigest(reviewed.sha256, found.sha256)) {
      throw conflict(
        `source ${reviewed.path} no longer holds the reviewed bytes (${reviewed.kind}). Re-preview the migration; ` +
          `nothing was written.`,
      );
    }
  }
  if (!sameBytesDigest(discovered.coreHash, manifest.coreHash)) {
    throw conflict("the core authority content changed since the preview; nothing was written.");
  }
  const foundDeferred = discovered.deferred.map((surface) =>
    surface.surface === LEGACY_LOCK_SURFACE
      ? deferredSurface(surface.surface, surface.paths.filter((path) => !selfHeldLockDirs.has(path)))
      : surface,
  );
  if (serializeExecutionValue(foundDeferred) !== serializeExecutionValue(manifest.deferred)) {
    throw conflict(
      "the deferred-surface coverage changed since the preview; the reviewed manifest no longer describes the surfaces " +
        "this store holds. Re-preview the migration; nothing was written.",
    );
  }
  // §7 the reviewed "no pending catalog operation was outstanding" witness is
  // compared against the locked journal too, so a manifest that claims a pending
  // set the live store does not hold is refused rather than persisted as the
  // reviewed pair.
  if (serializeExecutionValue(pendingCatalogOperations) !== serializeExecutionValue(manifest.pendingCatalogOperations)) {
    throw conflict(
      `the reviewed manifest records ${manifest.pendingCatalogOperations.length} pending catalog operation(s), but the ` +
        `live journal holds ${pendingCatalogOperations.length}; the manifest is not the reviewed pair, and nothing was written.`,
    );
  }
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
 * §7 the catalog half of the import check: a plan's recorded pin, the frozen
 * input it is sealed with and the committed `catalog_execution_bindings` row
 * must agree, and neither side wins silently.
 *
 * - a pin freezes the very row it is sealed with, so `document_hash` must be
 *   that row's frozen-input hash. Both live routes enforce it (create:
 *   `assertSelectedCatalogEntities`; read: `readExecutionCatalogPin`), and a
 *   pin whose row moved after preparation is exactly the incoherence this
 *   refuses. The check runs BEFORE the binding lookup and whether or not a
 *   binding row exists: a missing binding is not licence to seal a pin the row
 *   does not hash to — that one-sided pair is the failure this closes;
 * - a plan that records NO pin is the §1 coexistence case, not a disagreement:
 *   its pin is the workflow's committed binding, read exactly as
 *   `readExecutionCatalogPin` reads it (the binding's identity, with the
 *   document half supplied by the frozen row). Nothing is silently accepted
 *   there — there is no snapshot pin for the binding to disagree with — and
 *   requiring the two to be equal would refuse a state the contract keeps
 *   importable (a binding row records its own binding identity in `input_hash`
 *   / `pin_json`, not an execution pin: `writeBinding`), so the binding's
 *   recorded pin is compared against the row's own pin only when the row has
 *   one;
 * - a pin that names another store is never imported as this store's frozen
 *   selection.
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
    const inputHash = executionInputHash(plan.row, plan.planId);
    if (plan.pin.document_hash !== inputHash) {
      throw conflict(
        `plan ${plan.planId} of workflow ${workflow.workflowId} records catalog pin document hash ` +
          `${plan.pin.document_hash.slice(0, 12)}\u2026, but the frozen execution input it is sealed with hashes to ` +
          `${inputHash.slice(0, 12)}\u2026; the pin and its row disagree, and neither side is rewritten.`,
      );
    }
    const binding = rows.find((row) => row.catalog_kind === "plan" && row.catalog_id === plan.planId);
    if (binding === undefined) continue;
    if (typeof binding.input_hash === "string" && binding.input_hash !== inputHash) {
      throw conflict(
        `plan ${plan.planId} of workflow ${workflow.workflowId} records catalog binding input hash ${binding.input_hash} ` +
          `while its sealed selection hashes to ${inputHash}; neither side wins silently.`,
      );
    }
    if (typeof binding.pin_json !== "string") continue;
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

/**
 * §2.2/§3 the integration merge lease is the workflow-wide exclusive claim and
 * only the workflow's coordinator merges, so an imported claim must agree with
 * the lifecycle that recorded it. The file route leaves exactly one shape: the
 * coordinator takes the claim for an ACCEPTED attempt whose handoff it moved to
 * `integrating`, naming that attempt's source branch and the snapshot's
 * integration target (`mutateIntegrationStart`). Anything else — a plan-pm or
 * foreign holder, a plan this workflow does not own, a plan with no accepted
 * attempt, a source branch that is not the attempt's, a target that is not this
 * workflow's integration branch — is ownership no recorded session graph can
 * justify, so it is refused rather than staged as a `held` claim.
 */
function assertMergeLeaseCoherence(workflow: DiscoveredWorkflow, lease: IntegrationMergeLease, coordinator: LegacyBinding): void {
  const what = `workflow ${workflow.workflowId}'s integration merge lease`;
  if (lease.holder !== coordinator.session_id) {
    throw conflict(
      `${what} is held by ${JSON.stringify(lease.holder)}, not the workflow's recorded coordinator ` +
        `${coordinator.session_id}. Only the coordinator merges, so a claim held by any other session has no recorded ` +
        `authority to import; nothing was staged.`,
    );
  }
  const plan = workflow.plans.find((candidate) => candidate.planId === lease.plan_id);
  if (plan === undefined) {
    throw conflict(
      `${what} claims plan ${JSON.stringify(lease.plan_id)}, which is not a plan of this workflow ` +
        `(${workflow.plans.map((candidate) => candidate.planId).join(", ") || "\u2014 none"}); a claim outside this ` +
        `lifecycle is never imported as its held ownership. Nothing was staged.`,
    );
  }
  const block = isPlainObject(plan.row.coordination) ? plan.row.coordination : {};
  const handoff = isPlainObject(block.handoff) ? block.handoff : null;
  if (handoff === null || handoff.state !== "integrating") {
    throw conflict(
      `${what} claims plan ${plan.planId}, whose recorded handoff is ` +
        `${handoff === null ? "absent" : JSON.stringify(handoff.state)}. A merge claim exists only while its accepted ` +
        `attempt is being integrated; nothing was staged.`,
    );
  }
  if (handoff.source_branch !== lease.source_branch) {
    throw conflict(
      `${what} claims source branch ${JSON.stringify(lease.source_branch)}, but plan ${plan.planId}'s integrating ` +
        `handoff names ${JSON.stringify(handoff.source_branch)}; a claim on another attempt is never imported. ` +
        `Nothing was staged.`,
    );
  }
  const target = workflow.snapshot.branch?.integration;
  if (!isNonEmptyString(target) || target !== lease.target_branch) {
    throw conflict(
      `${what} claims target branch ${JSON.stringify(lease.target_branch)}, but the snapshot records integration target ` +
        `${JSON.stringify(target ?? null)}; a claim against another branch is never imported. Nothing was staged.`,
    );
  }
}

/** Import one discovered workflow and its ownership records (§2.2). */
function importWorkflow(tx: ExecutionTransaction, workflow: DiscoveredWorkflow): void {
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
    // §6 the imported lifecycle keeps its OWN validated timestamps: a migration
    // is not an edit of the history it imports, so the header's `created_at` /
    // `updated_at` are the source snapshot's `started_at` / `updated_at` read
    // back verbatim. `now` is used only for the migration's own receipt and
    // apply bookkeeping.
    .run(workflowId, JSON.stringify(header), snapshot.started_at, snapshot.updated_at);
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
    // plan session" half is checked against the row this import actually
    // inserts — exactly the DB reader's own rule (`sessionBound: sessionRow !==
    // undefined`). A handoff whose plan records no session binding therefore
    // refuses here instead of being staged as a graph the reader would reject
    // as corrupt after activation.
    const violations = storedCoordinationViolations(block, {
      revision: 1,
      route: rowValidationRoute(routeSnapshot, state as never),
      sessionBound: plan.session !== null,
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
    // coordinator merges: the holder, the plan it claims, that plan's accepted
    // attempt and both branches must agree with the recorded lifecycle before
    // the claim is imported as held ownership. The row mirrors the DB writer's
    // own shape (the claim plus its status) rather than inventing a second one.
    if (workflow.coordinator === null) {
      throw conflict(
        `workflow ${workflowId} holds an integration merge lease (holder ` +
          `${JSON.stringify((mergeLease as Record<string, unknown>).holder)}) but records no coordinator binding, so the ` +
          `claim has no owner to import. Nothing was staged.`,
      );
    }
    assertMergeLeaseCoherence(workflow, mergeLease, workflow.coordinator);
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
            // §7: a non-committed catalog operation blocks staging outright —
            // the shared rule below compares the reviewed claim, but a journal
            // that is genuinely pending refuses whatever the manifest claims.
            const pending = pendingCatalogOperations(tx.db);
            if (pending.length > 0) {
              throw conflict(
                `${pending.length} catalog operation(s) became pending since the preview (${pending.join(", ")}); nothing was staged.`,
              );
            }
            assertReviewedManifestHolds({
              manifest,
              discovered,
              // The one legitimate difference is this apply's OWN workflow locks:
              // they occupy each workflow dir's legacy write-lock surface for the
              // duration of the transaction, so the shared rule removes exactly
              // those paths from the found inventory before comparing coverage.
              selfHeldLockDirs: new Set(prelock.workflows.map((workflow) => join(workflow.dir, LEGACY_WRITE_LOCK_DIR))),
              pendingCatalogOperations: pending,
            });
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
              importWorkflow(tx, workflow);
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

// ---------------------------------------------------------------------------
// The recorded manifest (§6 items 3–5 read the RECORD, never a document)
// ---------------------------------------------------------------------------

/**
 * §6 items 3–5 address a manifest by identity and hash. The document itself is
 * re-read from the store and re-hashed here, so a caller cannot hand the
 * barrier a manifest the store never reviewed, and cannot substitute a
 * different document under a reviewed id.
 */
type MigrationRecord = {
  manifestId: string;
  manifestHash: string;
  phase: ExecutionMigrationReceipt["phase"];
  manifest: ExecutionManifest;
  /** The recorded activation record; `null` until the barrier committed (or aborted). */
  activation: Record<string, unknown> | null;
  retirement: Record<string, unknown> | null;
};

function storedJsonOrNull(text: unknown, what: string): Record<string, unknown> | null {
  if (text === null || text === undefined) return null;
  if (typeof text !== "string") throw conflict(`${what} is not a JSON string`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw conflict(`${what} is not valid JSON (${(error as Error).message}); the migration record cannot be verified.`);
  }
  if (!isPlainObject(parsed)) throw conflict(`${what} is not a JSON object`);
  return parsed;
}

function readMigrationRecord(db: StoreDb, manifestId: string): MigrationRecord | null {
  const row = db
    .prepare(
      "select manifest_hash, phase, manifest_json, activation_receipt_json, retirement_json from execution_migrations " +
        "where manifest_id = ?",
    )
    .get(manifestId) as
    | {
        manifest_hash?: unknown;
        phase?: unknown;
        manifest_json?: unknown;
        activation_receipt_json?: unknown;
        retirement_json?: unknown;
      }
    | undefined;
  if (row === undefined) return null;
  const phase = row.phase;
  if (
    typeof row.manifest_hash !== "string" ||
    typeof row.manifest_json !== "string" ||
    (phase !== "staged" && phase !== "active" && phase !== "retired" && phase !== "aborted")
  ) {
    throw conflict(`execution_migrations(${manifestId}) is malformed; the manifest's reviewed identity cannot be verified.`);
  }
  let document: unknown;
  try {
    document = JSON.parse(row.manifest_json);
  } catch (error) {
    throw conflict(`execution_migrations(${manifestId}).manifest_json is not valid JSON (${(error as Error).message}).`);
  }
  if (!isPlainObject(document) || document.version !== EXECUTION_MIGRATION_MANIFEST_VERSION) {
    throw conflict(`execution_migrations(${manifestId}).manifest_json is not a version ${EXECUTION_MIGRATION_MANIFEST_VERSION} manifest.`);
  }
  return {
    manifestId,
    manifestHash: row.manifest_hash,
    phase,
    manifest: document as unknown as ExecutionManifest,
    activation: storedJsonOrNull(row.activation_receipt_json, `execution_migrations(${manifestId}).activation_receipt_json`),
    retirement: storedJsonOrNull(row.retirement_json, `execution_migrations(${manifestId}).retirement_json`),
  };
}

/** The recorded manifest, checked against the pair the caller hands back and the control root it belongs to. */
function requireMigrationRecord(input: {
  record: MigrationRecord | null;
  manifestId: string;
  manifestHash: string;
  root: string;
  verb: string;
}): MigrationRecord {
  const { record, manifestId, manifestHash, root, verb } = input;
  if (record === null) {
    throw conflict(
      `${verb} addresses manifest ${manifestId}, which this store has not recorded. Stage the reviewed manifest first; ` +
        `nothing was changed.`,
    );
  }
  if (!sameBytesDigest(executionManifestHash(record.manifest), record.manifestHash)) {
    throw conflict(
      `manifest ${manifestId}'s recorded document does not hash to its recorded hash; the record is not self-consistent, ` +
        `and ${verb} refuses to act on it.`,
    );
  }
  if (!sameBytesDigest(record.manifestHash, manifestHash)) {
    throw conflict(
      `${verb} supplied the manifest hash ${manifestHash}, but manifest ${manifestId} is recorded with ` +
        `${record.manifestHash}; the document and its hash must be the pair the reviewer saw.`,
    );
  }
  if (canonicalPath(record.manifest.root) !== root) {
    throw conflict(`manifest ${manifestId} was reviewed for control root ${record.manifest.root}, not ${root}; nothing was changed.`);
  }
  return record;
}

/** Read one recorded manifest on its own read handle — the pre-lock pass every verb runs. */
async function readMigrationRecordFor(
  context: StoreContext,
  manifestId: string,
  manifestHash: string,
  root: string,
  verb: string,
): Promise<MigrationRecord> {
  const handle = await openStore(context, "read");
  try {
    return requireMigrationRecord({
      record: readMigrationRecord(handle.db, manifestId),
      manifestId,
      manifestHash,
      root,
      verb,
    });
  } finally {
    handle.close();
  }
}

/** §6 `manifestId` / `manifestHash` are identities, never documents: a blank one is not addressable. */
function requireManifestRef(value: unknown, verb: string, field: string): string {
  if (!isNonEmptyString(value) || value.trim() === "") {
    throw conflict(
      `${verb} requires a nonblank ${field}: the recorded manifest is addressed by identity, never by a caller-supplied ` +
        `document, and nothing was changed.`,
    );
  }
  return value;
}

/**
 * The test-runner-gated crash seam, the same gate every other failure injection
 * in the store uses. Each verb names the stage it is about to reach, so a crash
 * BEFORE the commit is reproduced rather than described.
 */
const MIGRATION_FAILURE_ENV = {
  activation: "MSTAR_STORE_FAIL_EXECUTION_ACTIVATION",
  retirement: "MSTAR_STORE_FAIL_EXECUTION_RETIREMENT",
  abort: "MSTAR_STORE_FAIL_EXECUTION_ABORT",
} as const;

function migrationFailureHook(variable: string, stage: string): void {
  if (process.env.MSTAR_STORE_TEST_RUNNER !== "1") return;
  if (process.env[variable] === stage) throw new Error(`induced execution-migration failure at ${stage}`);
}

// ---------------------------------------------------------------------------
// Activation (R2, §6 item 3)
// ---------------------------------------------------------------------------

/** §6 item 3: the cutover the activation receipt records, so a retry and an operator both read the same facts. */
type ExecutionActivationRecord = {
  activationVersion: number;
  manifestId: string;
  manifestHash: string;
  storeId: string;
  previousEpoch: number;
  epoch: number;
  /** `execution_meta.revision` after the barrier. */
  rootRevision: number;
  /** `store_meta.revision` after the barrier. */
  storeRevision: number;
  attestationDigest: string;
  attestation: ActivationAttestation;
  /** The imported references this barrier revoked (they stay rows; they stop authorizing). */
  revokedSessions: DiscoveredOwner[];
  /** Imported held ownership that stays REPRESENTED and requires the named reconciliation. */
  suspendedLeases: Array<{ workflowId: string; planId: string }>;
  suspendedIntegrationLeases: string[];
  /** Residual R13: the step the operator must take before a migrated workflow is consumable again. */
  requiredReconciliation: string;
  activatedAt: string;
};

/** §2.3/§6 item 3 the ONE step a migrated workspace still owes before ordinary consumers may read it. */
function reconciliationRequired(record: {
  revoked: readonly DiscoveredOwner[];
  leases: readonly { workflowId: string; planId: string }[];
  integrationLeases: readonly string[];
}): string {
  const workflows = [...new Set(record.revoked.map((owner) => owner.workflowId))];
  const first = workflows[0];
  const named =
    first === undefined
      ? "the imported sessions are revoked"
      : `the imported sessions of ${workflows.join(", ")} are revoked (starting with ${first})`;
  const leases =
    record.leases.length === 0 && record.integrationLeases.length === 0
      ? "no imported lease is outstanding"
      : `imported held ownership stays represented at its pre-activation epoch (${[
          ...record.leases.map((lease) => `plan ${lease.planId} of ${lease.workflowId}`),
          ...record.integrationLeases.map((workflowId) => `the integration merge lease of ${workflowId}`),
        ].join(", ")}) and authorizes nothing`;
  return (
    `${named} and ${leases}. Before any consumer reads a migrated workflow, recover each workflow's coordinator with ` +
    `recoverExecutionCoordinator (naming the recorded prior holder and attesting it stopped), then rebind its plans with ` +
    `bindExecutionSession; a suspended execution or integration lease needs an explicit reconcile before reuse.`
  );
}

/** §6/2b "Complete coverage rule": a 2a activation accepts a deferred surface only when it is proven ABSENT. */
function assertNoDeferredSurfaces(manifest: ExecutionManifest): void {
  const populated = manifest.deferred.filter((surface) => surface.disposition !== "absent" || surface.paths.length > 0);
  if (populated.length === 0) return;
  throw incomplete(
    `${populated.length} deferred (2b) surface(s) are populated: ` +
      `${populated.map((surface) => `${surface.surface} (${surface.paths.length} path(s))`).join(", ")}. A 2a activation ` +
      `accepts a deferred surface only when the discovery proves it absent; there is no allow-incomplete flag, and this ` +
      `workspace belongs on the staged route until 2b resolves those files. Nothing was activated.`,
  );
}

/**
 * §6 item 3 the attestation against the FROZEN OWNER INVENTORY. The owners the
 * import recorded are exactly the references the barrier revokes, so each one
 * needs stop evidence: a missing entry is an owner nobody observed stopped, and
 * an entry the inventory cannot justify is a claim that proves nothing. At
 * least one attested consumer must also have adopted this build — an inventory
 * of pure exclusions attests that nobody is running the new authority.
 */
function assertAttestationCoversOwners(owners: readonly DiscoveredOwner[], attestation: ActivationAttestation): void {
  const known = new Set(owners.map((owner) => owner.sessionId));
  const attested = new Set(attestation.stoppedSessions.map((session) => session.sessionId));
  const missing = [...known].filter((sessionId) => !attested.has(sessionId));
  if (missing.length > 0) {
    throw incomplete(
      `the attestation does not name ${missing.length} imported session owner(s) as stopped/reloaded ` +
        `(${missing.join(", ")}). Activation revokes those references, so it requires stop evidence for each of them; a ` +
        `string saying the workspace is covered is not that evidence. Nothing was activated.`,
    );
  }
  const unknown = [...attested].filter((sessionId) => !known.has(sessionId));
  if (unknown.length > 0) {
    throw incomplete(
      `the attestation names session(s) ${unknown.join(", ")} that this workspace's frozen source inventory does not ` +
        `contain; an unknown stopped session is a claim the inventory cannot justify, so the consumer inventory is not ` +
        `closed. Nothing was activated.`,
    );
  }
  if (!attestation.consumers.some((consumer) => consumer.disposition === "reloaded" || consumer.disposition === "upgraded")) {
    throw incomplete(
      `every attested consumer is excluded and none adopted this build, so nothing attests that the new execution ` +
        `authority runs anywhere. Nothing was activated.`,
    );
  }
}

/**
 * §6 item 3 "recheck ... every identity": the staged graph read through this
 * module's own diagnostic SQL. `readExecutionState` is deliberately NOT used —
 * it requires an ACTIVE plan-pm session for a handoff-bearing plan, which a
 * suspended import cannot have (§2.2 + §2.3, residual R13) — so the barrier
 * reads the rows it is about to activate and refuses a graph that is not
 * exactly the reviewed import.
 */
type StagedGraph = {
  workflowIds: string[];
  plans: Array<{ workflowId: string; planId: string; inputHash: string }>;
  sessions: Array<DiscoveredOwner & { state: string; epoch: number }>;
};

function readStagedGraph(db: StoreDb): StagedGraph {
  const workflowIds = (db.prepare("select workflow_id from execution_registry order by rowid").all() as Array<{
    workflow_id?: unknown;
  }>).map((row) => String(row.workflow_id));
  const plans = (db
    .prepare("select workflow_id, plan_id, input_hash from execution_inputs order by workflow_id, plan_id")
    .all() as Array<{ workflow_id?: unknown; plan_id?: unknown; input_hash?: unknown }>).map((row) => ({
    workflowId: String(row.workflow_id),
    planId: String(row.plan_id),
    inputHash: String(row.input_hash),
  }));
  const sessions = (db
    .prepare("select workflow_id, role, session_id, plan_id, state, epoch from execution_sessions order by workflow_id, role, session_id")
    .all() as Array<Record<string, unknown>>).map((row) => ({
    workflowId: String(row.workflow_id),
    role: row.role === "coordinator" ? ("coordinator" as const) : ("plan-pm" as const),
    sessionId: String(row.session_id),
    planId: row.plan_id === null || row.plan_id === undefined ? null : String(row.plan_id),
    state: String(row.state),
    epoch: Number(row.epoch),
  }));
  return { workflowIds, plans, sessions };
}

/** §6 item 3: the staged graph must be exactly the reviewed import, or the barrier refuses to activate it. */
function assertStagedGraphIsTheImport(graph: StagedGraph, discovered: DiscoveredSources, epoch: number): void {
  const expectedWorkflows = discovered.workflows.map((workflow) => workflow.workflowId);
  if (serializeExecutionValue(graph.workflowIds) !== serializeExecutionValue(expectedWorkflows)) {
    throw conflict(
      `the staged graph holds workflow(s) ${graph.workflowIds.join(", ") || "\u2014 none"} while the reviewed import holds ` +
        `${expectedWorkflows.join(", ") || "\u2014 none"}. A barrier activates exactly one reviewed import; nothing was activated.`,
    );
  }
  const key = (entry: { workflowId: string; planId: string | null }): string => `${entry.workflowId}\u0000${entry.planId}`;
  const expectedPlans = discovered.workflows
    .flatMap((workflow) =>
      workflow.plans.map((plan) => ({
        workflowId: workflow.workflowId,
        planId: plan.planId,
        inputHash: executionInputHash(plan.row, plan.planId),
      })),
    )
    .sort((a, b) => (key(a) < key(b) ? -1 : 1));
  // Both sides are projected into the SAME canonical order: the manifest order is
  // registry order and the SQL order is (workflow_id, plan_id, …), so comparing
  // them unsorted would refuse an import that is in fact identical.
  const stagedPlans = [...graph.plans].sort((a, b) => (key(a) < key(b) ? -1 : 1));
  if (serializeExecutionValue(stagedPlans) !== serializeExecutionValue(expectedPlans)) {
    throw conflict(
      `the staged plan rows and sealed inputs are not the reviewed import (${graph.plans.length} staged, ` +
        `${expectedPlans.length} reviewed). Nothing was activated.`,
    );
  }
  const expectedSessions = discovered.owners
    .map((owner) => ({ ...owner, state: "suspended", epoch }))
    .sort((a, b) => (key(a) < key(b) ? -1 : 1));
  const stagedSessions = [...graph.sessions].sort((a, b) => (key(a) < key(b) ? -1 : 1));
  if (serializeExecutionValue(stagedSessions) !== serializeExecutionValue(expectedSessions)) {
    throw conflict(
      `the staged session rows are not the suspended import the recorded bindings resolve to (${graph.sessions.length} ` +
        `staged, ${expectedSessions.length} reviewed). Activation revokes exactly the imported references; nothing was activated.`,
    );
  }
}

/** §6 item 3 the recorded activation of an already-active manifest: its receipt is the only answer. */
function replayActivation(record: MigrationRecord, attestationDigest: string): ExecutionMigrationReceipt {
  const recorded = record.activation?.attestationDigest;
  if (typeof recorded !== "string" || recorded !== attestationDigest) {
    throw conflict(
      `manifest ${record.manifestId} is already ACTIVE under a different attestation (recorded ` +
        `${typeof recorded === "string" ? recorded.slice(0, 12) : "\u2014 none"}), supplied ${attestationDigest.slice(0, 12)}); ` +
        `activation history is immutable, so reuse the recorded attestation. The live authority was not changed.`,
    );
  }
  return { manifestId: record.manifestId, phase: "active", replayed: true };
}

/**
 * `activateExecutionMigration` — the §6 item 3 barrier: one all-or-nothing
 * cutover from the staged import to the DB execution authority.
 *
 * It re-reads the recorded staged manifest (never a caller-supplied document),
 * takes the §4.2 maintenance → root → sorted-workflow lock ladder, and inside
 * ONE transaction rechecks the exact witness bytes, the core digest, the
 * deferred coverage classification, an empty pending catalog journal, the store
 * identity, the reviewed schema, the `expectedEpoch` CAS, the operator's own
 * identity, the attestation's coverage of the frozen owner inventory, the
 * staged graph against the reviewed import, and the ABSENCE of every deferred
 * surface. Then it advances the store-wide epoch ONCE, flips the execution
 * authority to `active`, revokes the imported sessions at their own epoch,
 * leaves every imported lease REPRESENTED (never adopted) and records the
 * activation receipt naming the reconciliation that remains.
 *
 * A crash before the commit leaves the staged (JSON-live) authority untouched;
 * a retry of the same pair returns the recorded receipt instead of a second
 * epoch bump. Nothing here deletes, renames or rewrites a source byte: that is
 * `retireExecutionSources`, which runs as its own step.
 */
export async function activateExecutionMigration(
  input: ExecutionMigrationActivationInput,
): Promise<ExecutionMigrationReceipt> {
  const { context, operator } = resolveMigrationInput(input, "activate");
  const manifestId = requireManifestRef(input.manifestId, "activate", "manifestId");
  const manifestHash = requireManifestRef(input.manifestHash, "activate", "manifestHash");
  if (!Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch <= 0) {
    throw conflict(
      `activation requires expectedEpoch: the positive store epoch the reviewed manifest was staged at. The barrier is a ` +
        `CAS on it, so an absent or unusable witness is refused rather than guessed. Nothing was activated.`,
    );
  }
  const attestation = validateActivationAttestation(input.attestation);
  if (attestation.operator.actor !== operator) {
    throw new StoreActivationError(
      "store.attestation-invalid",
      `the attestation is signed by ${JSON.stringify(attestation.operator.actor)} while the migration is recorded under ` +
        `${JSON.stringify(operator)}; the accountable operator and the attesting operator are one identity at the barrier. ` +
        `Nothing was activated.`,
    );
  }
  const attestationDigest = digestOf(attestation);
  const root = controlRootOf(context);

  // The recorded phase is read BEFORE any lock. An already-active manifest is
  // resolved from its receipt, and that answer must not be able to change
  // because discovery no longer recognises the workspace: after activation the
  // file route is fenced, and after retirement the root register is gone.
  const known = await readMigrationRecordFor(context, manifestId, manifestHash, root, "activation");
  if (known.phase === "active") return replayActivation(known, attestationDigest);
  if (known.phase !== "staged") {
    throw conflict(
      `manifest ${manifestId} is recorded ${known.phase}; only a staged manifest activates. An aborted or retired manifest ` +
        `needs a re-preview under a fresh manifest, and nothing was activated.`,
    );
  }

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
            const record = requireMigrationRecord({
              record: readMigrationRecord(tx.db, manifestId),
              manifestId,
              manifestHash,
              root,
              verb: "activation",
            });
            if (record.phase === "active") return replayActivation(record, attestationDigest);
            if (record.phase !== "staged") {
              throw conflict(
                `manifest ${manifestId} is recorded ${record.phase}; only a staged manifest activates, and nothing was activated.`,
              );
            }
            const manifest = record.manifest;
            if (tx.execution.authorityState === "active") {
              throw conflict(
                `the execution authority is already ACTIVE under manifest ${String(tx.execution.manifestId)}; an active ` +
                  `authority is never re-activated by another manifest. Nothing was activated.`,
              );
            }
            if (tx.execution.authorityState !== "staged" || tx.execution.manifestId !== manifestId) {
              throw conflict(
                `the execution authority is ${tx.execution.authorityState}` +
                  `${tx.execution.manifestId === null ? "" : ` under manifest ${tx.execution.manifestId}`}, not the staged ` +
                  `manifest ${manifestId}. Nothing was activated.`,
              );
            }
            if (input.expectedEpoch !== tx.epoch || manifest.epoch !== tx.epoch) {
              throw conflict(
                `the barrier is a CAS on the store epoch: the manifest was reviewed at epoch ${manifest.epoch}, the caller ` +
                  `expects ${input.expectedEpoch}, and the live store is at epoch ${tx.epoch}. Re-preview against the current ` +
                  `authority; nothing was activated.`,
              );
            }
            if (manifest.storeId !== tx.storeId) {
              throw conflict(
                `the manifest was reviewed against store ${manifest.storeId}, but the live store is ${tx.storeId}; nothing was activated.`,
              );
            }
            const schema = tx.db.prepare("select max(version) as v from schema_version").get() as { v?: unknown } | undefined;
            if (typeof schema?.v !== "number" || schema.v !== manifest.schemaVersion) {
              throw conflict(
                `the store schema changed since the preview (reviewed ${manifest.schemaVersion}, found ${String(schema?.v)}); ` +
                  `nothing was activated.`,
              );
            }
            // §7: a pending registration must be reconciled while JSON still owns
            // execution, so a journal that became pending since the staged apply
            // blocks the barrier outright.
            const pending = pendingCatalogOperations(tx.db);
            if (pending.length > 0) {
              throw conflict(
                `${pending.length} catalog operation(s) are pending (${pending.join(", ")}). A pending registration must be ` +
                  `resolved with the legacy reconcile while JSON still owns execution (\u00a77); nothing was activated.`,
              );
            }
            const discovered = discoverExecutionSources(context);
            assertReviewedManifestHolds({
              manifest,
              discovered,
              selfHeldLockDirs: new Set(prelock.workflows.map((workflow) => join(workflow.dir, LEGACY_WRITE_LOCK_DIR))),
              pendingCatalogOperations: pending,
            });
            assertNoDeferredSurfaces(manifest);
            assertAttestationCoversOwners(discovered.owners, attestation);
            assertStagedGraphIsTheImport(readStagedGraph(tx.db), discovered, tx.epoch);

            // ── the cutover: ONE transaction, ONE epoch bump ──────────────
            const epoch = tx.epoch + 1;
            const now = new Date().toISOString();
            // §2.3 the imported references are REVOKED at the epoch they were
            // issued in, never rewritten: a stale reference is fenced by the
            // epoch AND by the state, and the superseded rows stay as the
            // provenance the recovery verbs name.
            tx.db
              .prepare("update execution_sessions set state = 'revoked', revision = revision + 1 where state = 'suspended' and epoch = ?")
              .run(tx.epoch);
            // §2.2 the root revision advances once (the activation state changed
            // in this one transaction); `root_updated_at` is left alone because
            // no root membership changed.
            tx.db
              .prepare(
                "update execution_meta set authority_state = 'active', revision = revision + 1, activated_at = ?, " +
                  "manifest_id = ? where id = 1",
              )
              .run(now, manifestId);
            const rootRevision = Number(
              (tx.db.prepare("select revision from execution_meta where id = 1").get() as { revision?: unknown } | undefined)?.revision,
            );
            // §6 item 3 the ONE store-wide epoch advance. Every reference issued
            // before this instant — execution or issue/catalog — is now stale.
            tx.db.prepare("update store_meta set authority_epoch = ?, revision = revision + 1 where id = 1").run(epoch);
            const storeRevision = Number(
              (tx.db.prepare("select revision from store_meta where id = 1").get() as { revision?: unknown } | undefined)?.revision,
            );
            const suspendedLeases = discovered.workflows.flatMap((workflow) =>
              workflow.plans.filter((plan) => plan.lease !== null).map((plan) => ({ workflowId: workflow.workflowId, planId: plan.planId })),
            );
            const suspendedIntegrationLeases = discovered.workflows
              .filter((workflow) => workflow.snapshot.integration_merge_lease !== undefined)
              .map((workflow) => workflow.workflowId);
            const stored: ExecutionActivationRecord = {
              activationVersion: 1,
              manifestId,
              manifestHash,
              storeId: tx.storeId,
              previousEpoch: tx.epoch,
              epoch,
              rootRevision,
              storeRevision,
              attestationDigest,
              attestation,
              revokedSessions: discovered.owners,
              suspendedLeases,
              suspendedIntegrationLeases,
              requiredReconciliation: reconciliationRequired({
                revoked: discovered.owners,
                leases: suspendedLeases,
                integrationLeases: suspendedIntegrationLeases,
              }),
              activatedAt: now,
            };
            const wrote = tx.db
              .prepare(
                "update execution_migrations set phase = 'active', activation_receipt_json = ?, updated_at = ? " +
                  "where manifest_id = ? and phase = 'staged'",
              )
              .run(JSON.stringify(stored), now, manifestId) as { changes?: unknown };
            if (Number(wrote.changes) !== 1) {
              throw conflict(
                `manifest ${manifestId} left the staged phase while the barrier ran; the activation was rolled back and the ` +
                  `authority is unchanged.`,
              );
            }
            migrationFailureHook(MIGRATION_FAILURE_ENV.activation, "before-commit");
            return { manifestId, phase: "active" as const, replayed: false };
          }),
        ),
      { timeoutMs: migrationLockWaitMs() },
    ),
  );
}

// ---------------------------------------------------------------------------
// Retirement of the core sources (R2, §6 item 4)
// ---------------------------------------------------------------------------

/** §6 item 4: where the manifest-addressed read-only history lives. */
const ARCHIVED_EXECUTION_DIR = ["archived", "execution"] as const;

/** §6 item 4: one core source file, with the durable per-item progress the resume reads. */
type RetirementItem = {
  kind: "root" | "workflow";
  path: string;
  relativePath: string;
  archivePath: string;
  sha256: string;
  state: "pending" | "moved";
};

/** §6 item 4: the resumable per-item record, written into the archive it describes. */
type ExecutionRetirementLedger = {
  version: number;
  manifestId: string;
  manifestHash: string;
  storeId: string;
  epoch: number;
  archiveDir: string;
  startedAt: string;
  updatedAt: string;
  items: RetirementItem[];
};

/** §6 item 4: what the store records once every core source has moved. */
type ExecutionRetirementRecord = {
  retirementVersion: number;
  manifestId: string;
  manifestHash: string;
  storeId: string;
  epoch: number;
  archiveDir: string;
  ledgerPath: string;
  items: Array<{ relativePath: string; sha256: string; archivePath: string }>;
  retiredAt: string;
};

function readIfExists(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

/** Atomic write: same-directory temp + rename, so a reader never sees a partial ledger. */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

/** The harness-relative path of one retired source, traversal-refused. */
function harnessRelativePath(root: string, path: string, what: string): string {
  const rel = relative(root, path);
  const segments = rel.split(/[\\/]+/);
  if (rel === "" || isAbsolute(rel) || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw conflict(`${what} at ${path} does not resolve inside the control root ${root}; it is never retired.`);
  }
  return segments.join("/");
}

/**
 * §6 item 4 the retire set: EXACTLY the core sources the reviewed manifest
 * witnessed — the root register and the registered workflow snapshots. Session
 * envelopes, note/flow ledgers, launch journals and the host-owned execution
 * status file are deferred 2b surfaces and are never touched here.
 */
function retirementItems(manifest: ExecutionManifest, root: string, archiveDir: string): RetirementItem[] {
  const core = manifest.sources.filter((witness) => witness.kind === "root" || witness.kind === "workflow");
  if (core.length === 0) {
    throw conflict(
      `manifest ${manifest.id} records no core root/snapshot source, so there is nothing a 2a retirement could move; ` +
        `nothing was retired.`,
    );
  }
  return core.map((witness) => {
    const relativePath = harnessRelativePath(root, witness.path, `the ${witness.kind} source`);
    return {
      kind: witness.kind === "root" ? ("root" as const) : ("workflow" as const),
      path: witness.path,
      relativePath,
      archivePath: join(archiveDir, ...relativePath.split("/")),
      sha256: witness.sha256,
      state: "pending" as const,
    };
  });
}

function readRetirementLedger(path: string): ExecutionRetirementLedger | undefined {
  const bytes = readIfExists(path);
  if (bytes === undefined) return undefined;
  let ledger: ExecutionRetirementLedger;
  try {
    ledger = JSON.parse(bytes.toString("utf8")) as ExecutionRetirementLedger;
  } catch (error) {
    throw conflict(`the retirement ledger at ${path} is unreadable (${(error as Error).message}); refusing to guess at partial retirement state.`);
  }
  if (!isPlainObject(ledger) || !Array.isArray(ledger.items)) {
    throw conflict(`the retirement ledger at ${path} is not a per-item retirement record; refusing to resume against it.`);
  }
  return ledger;
}

/**
 * §6 item 4 resume (fix round 1): reconcile a durable ledger against the
 * reviewed core set. A resume may contribute per-item PROGRESS and nothing
 * else: every addressed field (kind, source path, manifest-relative path,
 * archive destination, hash) is re-derived from the reviewed manifest and
 * compared with what the ledger claims, and the item state must be one this
 * protocol writes. The returned items are the MANIFEST's, so an edited or
 * corrupted ledger can neither redirect a rename outside the
 * manifest-addressed archive nor smuggle in progress for a file the manifest
 * does not address.
 */
function reconcileRetirementItems(input: {
  ledger: ExecutionRetirementLedger;
  expected: readonly RetirementItem[];
  manifestId: string;
  manifestHash: string;
  storeId: string;
  epoch: number;
  archiveDir: string;
  ledgerPath: string;
}): RetirementItem[] {
  const { ledger, expected, manifestId, manifestHash, storeId, epoch, archiveDir, ledgerPath } = input;
  function refuse(detail: string): never {
    throw conflict(`the retirement ledger at ${ledgerPath} ${detail}; refusing to resume against it, and nothing was retired.`);
  }
  if (ledger.version !== 1 || ledger.manifestId !== manifestId || ledger.manifestHash !== manifestHash) {
    refuse(`does not describe this manifest's reviewed core sources`);
  }
  if (ledger.storeId !== storeId || ledger.epoch !== epoch) {
    refuse(
      `records store ${JSON.stringify(ledger.storeId)} at epoch ${JSON.stringify(ledger.epoch)} while manifest ${manifestId} ` +
        `was reviewed against store ${storeId} at epoch ${epoch}`,
    );
  }
  if (canonicalPath(ledger.archiveDir) !== canonicalPath(archiveDir)) {
    refuse(`names the archive directory ${JSON.stringify(ledger.archiveDir)} rather than ${archiveDir}`);
  }
  if (ledger.items.length !== expected.length) {
    refuse(`addresses ${ledger.items.length} item(s) rather than the ${expected.length} reviewed core source(s)`);
  }
  return expected.map((item, index) => {
    const recorded: unknown = ledger.items[index];
    const what = `item ${index + 1} (${item.relativePath})`;
    if (!isPlainObject(recorded)) refuse(`does not record ${what}`);
    if (recorded.kind !== item.kind) {
      refuse(`records ${what} with kind ${JSON.stringify(recorded.kind)} rather than ${JSON.stringify(item.kind)}`);
    }
    if (recorded.relativePath !== item.relativePath) {
      refuse(`records ${what} under relativePath ${JSON.stringify(recorded.relativePath)} rather than ${JSON.stringify(item.relativePath)}`);
    }
    if (typeof recorded.path !== "string" || canonicalPath(recorded.path) !== canonicalPath(item.path)) {
      refuse(`records ${what} at source path ${JSON.stringify(recorded.path)} rather than ${item.path}`);
    }
    if (typeof recorded.archivePath !== "string" || canonicalPath(recorded.archivePath) !== canonicalPath(item.archivePath)) {
      refuse(
        `records ${what} at archive destination ${JSON.stringify(recorded.archivePath)} rather than the ` +
          `manifest-addressed ${item.archivePath}`,
      );
    }
    if (recorded.sha256 !== item.sha256) {
      refuse(`records ${what} with sha256 ${JSON.stringify(recorded.sha256)} rather than the reviewed bytes ${item.sha256}`);
    }
    if (recorded.state !== "pending" && recorded.state !== "moved") {
      refuse(`records ${what} in state ${JSON.stringify(recorded.state)} rather than pending or moved`);
    }
    return { ...item, state: recorded.state };
  });
}

/**
 * §6 item 4: the one destination a retirement may write, refused when it is not
 * the manifest-addressed archive itself. `isPathWithin` compares canonical
 * prefixes, so a destination spelled outside the archive — absolute, traversal,
 * or resolving through a symlinked ancestor — is not inside it; the `lstat` walk
 * then refuses a symlinked component even when it resolves back inside, because
 * a rename through a link this protocol did not create files the reviewed bytes
 * somewhere the manifest does not address.
 */
function assertArchiveDestination(root: string, archiveDir: string, item: RetirementItem): void {
  if (!isPathWithin(archiveDir, item.archivePath)) {
    throw conflict(
      `the archive destination ${item.archivePath} of ${item.relativePath} is outside the manifest-addressed archive ` +
        `${archiveDir}; nothing was retired.`,
    );
  }
  let current = root;
  for (const segment of relative(root, item.archivePath).split(/[\\/]+/)) {
    current = join(current, segment);
    let info: Stats;
    try {
      info = lstatSync(current);
    } catch {
      // Not created yet: retirement makes it itself, under this same walk.
      continue;
    }
    if (info.isSymbolicLink()) {
      throw conflict(
        `the archive destination ${current} of ${item.relativePath} is a symlink. Retirement writes only into directories ` +
          `it created under ${archiveDir}, so nothing was retired.`,
      );
    }
  }
}

/** §6 item 4 one item's exact source bytes, checked before anything moves. */
function assertRetirementItemHolds(item: RetirementItem): void {
  const live = readIfExists(item.path);
  const archived = readIfExists(item.archivePath);
  if (item.state === "moved") {
    if (archived === undefined || sha256Of(archived) !== item.sha256) {
      throw conflict(
        `the archived copy of ${item.relativePath} no longer holds the reviewed bytes; refusing to claim retirement.`,
      );
    }
    if (live !== undefined) {
      throw conflict(
        `the retired source ${item.relativePath} exists again at ${item.path}; an old consumer is still writing old-format ` +
          `data, so the archive is not the only copy. Nothing was retired.`,
      );
    }
    return;
  }
  if (live === undefined) {
    if (archived === undefined) {
      throw conflict(
        `both ${item.relativePath} and its archive copy at ${item.archivePath} are gone, so the reviewed source cannot be ` +
          `retired truthfully. Nothing was retired.`,
      );
    }
    if (sha256Of(archived) !== item.sha256) {
      throw conflict(
        `the archive copy of ${item.relativePath} does not hold the reviewed bytes; neither copy is overwritten, and ` +
          `nothing was retired.`,
      );
    }
    return;
  }
  const liveHash = sha256Of(live);
  if (liveHash !== item.sha256) {
    throw conflict(
      `the retired source ${item.relativePath} no longer holds the reviewed bytes (live ${liveHash.slice(0, 12)}, reviewed ` +
        `${item.sha256.slice(0, 12)}). An old consumer is still writing old-format data, so the live file was NOT moved: ` +
        `stop it, re-preview and re-apply, then resume retirement.`,
    );
  }
  if (archived !== undefined) {
    throw conflict(
      `both the source ${item.relativePath} and a copy at ${item.archivePath} exist; retirement refuses without overwriting ` +
        `either. Nothing was retired.`,
    );
  }
}

/** §2.2/§6 item 4: retirement runs only behind the ACTIVE receipt of this manifest. */
async function assertRetirableAuthority(context: StoreContext, record: MigrationRecord, verb: string): Promise<void> {
  const handle = await openStore(context, "read");
  try {
    const execution = handle.execution;
    if (execution === null || execution.authorityState !== "active" || execution.manifestId !== record.manifestId) {
      throw conflict(
        `${verb} requires the ACTIVE receipt of manifest ${record.manifestId}, but the live execution authority is ` +
          `${execution === null ? "absent" : `${execution.authorityState} under ${String(execution.manifestId)}`}. Core ` +
          `sources are retired only after the activation barrier committed; nothing was retired.`,
      );
    }
    if (handle.storeId !== record.manifest.storeId) {
      throw conflict(
        `the live store is ${handle.storeId} while manifest ${record.manifestId} was reviewed against ${record.manifest.storeId}; ` +
          `nothing was retired.`,
      );
    }
    if (handle.epoch <= record.manifest.epoch) {
      throw conflict(
        `the live authority is still at epoch ${handle.epoch}, the epoch manifest ${record.manifestId} was reviewed at, so ` +
          `the activation that must precede retirement has not committed. Nothing was retired.`,
      );
    }
    if (record.activation === null || record.activation.manifestId !== record.manifestId) {
      throw conflict(
        `manifest ${record.manifestId} is recorded active without its activation receipt; retirement refuses to move sources ` +
          `it cannot tie to a barrier. Nothing was retired.`,
      );
    }
  } finally {
    handle.close();
  }
}

/**
 * `retireExecutionSources` — the §6 item 4 step: move the EXACT unchanged core
 * sources of one activated manifest into manifest-addressed read-only history
 * under `<harness>/archived/execution/<manifestId>/`.
 *
 * It runs only behind the recorded active receipt and re-verifies the store
 * identity, the advanced epoch, every item's manifest-addressed destination and
 * every source's exact bytes BEFORE anything moves, so a changed source or a
 * redirected destination refuses with the live tree untouched. Then, per
 * item, a same-filesystem `rename` plus a checksum check of the destination,
 * each item's result written durably into the archive's own
 * `retirement.json`; the DB receipt is the LAST write. A crash after a rename
 * and before the receipt therefore resumes from the destination hash, a source
 * that is absent while its archive copy holds the reviewed bytes is already
 * done, and a source/destination disagreement refuses without overwriting
 * either. A durable ledger is a claim about this manifest and never a source of
 * addressing: its envelope and every item field are reconciled against the
 * reviewed manifest first, and the resume moves the manifest's items. Partial
 * retirement is recoverable and NEVER returns authority to
 * JSON: the store stays `active` throughout, and this verb writes no authority
 * row of its own.
 */
export async function retireExecutionSources(input: ExecutionMigrationRetireInput): Promise<ExecutionMigrationReceipt> {
  const { context } = resolveMigrationInput(input, "retire");
  const manifestId = requireManifestRef(input.manifestId, "retire", "manifestId");
  const manifestHash = requireManifestRef(input.manifestHash, "retire", "manifestHash");
  const root = controlRootOf(context);

  const known = await readMigrationRecordFor(context, manifestId, manifestHash, root, "retirement");
  if (known.phase === "retired") return { manifestId, phase: "retired", replayed: true };
  if (known.phase !== "active") {
    throw conflict(
      `manifest ${manifestId} is recorded ${known.phase}; core sources are retired only behind an ACTIVE receipt, so a staged ` +
        `or aborted migration has nothing to retire. Nothing was retired.`,
    );
  }
  await assertRetirableAuthority(context, known, "retirement");

  const archiveDir = join(root, ...ARCHIVED_EXECUTION_DIR, manifestId);
  const ledgerPath = join(archiveDir, "retirement.json");
  const expectedItems = retirementItems(known.manifest, root, archiveDir);
  const lockPaths = [...expectedItems]
    .filter((item) => item.kind === "workflow")
    .map((item) => item.path)
    .sort();

  const run = async (): Promise<ExecutionMigrationReceipt> => {
    const live = requireMigrationRecord({
      record: await readMigrationRecordFor(context, manifestId, manifestHash, root, "retirement"),
      manifestId,
      manifestHash,
      root,
      verb: "retirement",
    });
    if (live.phase === "retired") return { manifestId, phase: "retired" as const, replayed: true };
    if (live.phase !== "active") {
      throw conflict(`manifest ${manifestId} left the active phase while retirement ran; nothing was retired.`);
    }
    await assertRetirableAuthority(context, live, "retirement");

    const existing = readRetirementLedger(ledgerPath);
    if (existing !== undefined) {
      // Resume ONLY against the same reviewed set: a ledger from another
      // manifest, or one that does not reconcile field-for-field with the
      // reviewed core sources, is not a partial run of this retirement. The
      // reconciled items ARE the manifest's, so the ledger supplies progress
      // and never a destination.
      existing.items = reconcileRetirementItems({
        ledger: existing,
        expected: expectedItems,
        manifestId,
        manifestHash,
        storeId: live.manifest.storeId,
        epoch: live.manifest.epoch,
        archiveDir,
        ledgerPath,
      });
    }
    const now = new Date().toISOString();
    const ledger: ExecutionRetirementLedger = existing ?? {
      version: 1,
      manifestId,
      manifestHash,
      storeId: live.manifest.storeId,
      epoch: live.manifest.epoch,
      archiveDir,
      startedAt: now,
      updatedAt: now,
      items: expectedItems,
    };

    // §6 item 4 "recheck the exact current source hashes" FIRST: every item's
    // destination and every item's bytes are verified before the first rename,
    // so a redirected destination or a changed source refuses with the live tree
    // completely untouched rather than halfway through a partial move.
    for (const item of ledger.items) {
      assertArchiveDestination(root, archiveDir, item);
      assertRetirementItemHolds(item);
    }
    for (const item of ledger.items) {
      if (item.state === "moved") continue;
      if (readIfExists(item.path) !== undefined) {
        mkdirSync(dirname(item.archivePath), { recursive: true });
        renameSync(item.path, item.archivePath);
        migrationFailureHook(MIGRATION_FAILURE_ENV.retirement, "after-rename");
      }
      const archived = readIfExists(item.archivePath);
      if (archived === undefined || sha256Of(archived) !== item.sha256) {
        throw conflict(
          `the moved copy of ${item.relativePath} does not hold the reviewed bytes; it was NOT overwritten, and the ` +
            `retirement did not complete.`,
        );
      }
      item.state = "moved";
      ledger.updatedAt = new Date().toISOString();
      writeJsonAtomic(ledgerPath, ledger);
    }

    migrationFailureHook(MIGRATION_FAILURE_ENV.retirement, "before-receipt");
    const retiredAt = new Date().toISOString();
    const stored: ExecutionRetirementRecord = {
      retirementVersion: 1,
      manifestId,
      manifestHash,
      storeId: live.manifest.storeId,
      epoch: live.manifest.epoch,
      archiveDir,
      ledgerPath,
      items: ledger.items.map((item) => ({
        relativePath: item.relativePath,
        sha256: item.sha256,
        archivePath: item.archivePath,
      })),
      retiredAt,
    };
    return withExecutionTransaction(context, (tx) => {
      if (tx.execution.authorityState !== "active" || tx.execution.manifestId !== manifestId) {
        throw conflict(
          `manifest ${manifestId} is no longer the active execution authority, so the retirement receipt was not recorded. ` +
            `The moved sources stay archived; nothing was returned to JSON.`,
        );
      }
      const wrote = tx.db
        .prepare(
          "update execution_migrations set phase = 'retired', retirement_json = ?, updated_at = ? " +
            "where manifest_id = ? and phase = 'active'",
        )
        .run(JSON.stringify(stored), retiredAt, manifestId) as { changes?: unknown };
      if (Number(wrote.changes) !== 1) {
        throw conflict(`manifest ${manifestId} left the active phase while retirement ran; the retirement receipt was not recorded.`);
      }
      return { manifestId, phase: "retired" as const, replayed: false };
    });
  };

  return withExecutionMaintenanceLock(context, () =>
    withStatusWriteLock(join(root, "status.json"), () => withAllLocks(lockPaths, run)),
  );
}

// ---------------------------------------------------------------------------
// Staged abort (R2, §6 item 5)
// ---------------------------------------------------------------------------

/**
 * §6 item 5: what the store records about an aborted staging. The schema has no
 * dedicated abort column, so the activation-receipt column carries it — the
 * record is self-describing (`abortVersion`) and the row's `phase` is
 * `aborted`, which is the field every reader checks first.
 */
type ExecutionAbortRecord = {
  abortVersion: number;
  manifestId: string;
  manifestHash: string;
  reason: string;
  operator: string;
  storeId: string;
  epoch: number;
  previousAuthority: string;
  deletedRows: Record<string, number>;
  abortedAt: string;
};

/** §2.2 the child-before-parent order the staged rows have to leave in. */
const STAGED_TABLES = [
  "execution_operations",
  "execution_leases",
  "execution_integration_leases",
  "execution_inputs",
  "execution_sessions",
  "execution_plans",
  "execution_registry",
  "execution_workflows",
] as const;

/**
 * `abortExecutionMigration` — the §6 item 5 explicit staged abort: delete
 * exactly the addressed manifest's staged execution rows in ONE transaction,
 * preserve issue/catalog and every source byte, record the aborted receipt and
 * return the execution mode to `legacy`, so changed legacy input can be
 * previewed and applied anew under a fresh manifest instead of a hidden merge.
 *
 * It can never remove active data: a manifest recorded `active` or `retired`
 * cannot abort, and the transaction refuses unless the live authority is still
 * the staged manifest it addresses. It writes no file and no issue/catalog row.
 */
export async function abortExecutionMigration(input: ExecutionMigrationAbortInput): Promise<ExecutionMigrationReceipt> {
  const { context, operator } = resolveMigrationInput(input, "abort");
  const manifestId = requireManifestRef(input.manifestId, "abort", "manifestId");
  const manifestHash = requireManifestRef(input.manifestHash, "abort", "manifestHash");
  if (!isNonEmptyString(input.reason) || input.reason.trim() === "") {
    throw conflict(`abort requires the reason it is recorded under (a nonblank string); an unattributed abort is never recorded.`);
  }
  const root = controlRootOf(context);

  const known = await readMigrationRecordFor(context, manifestId, manifestHash, root, "abort");
  if (known.phase === "active" || known.phase === "retired") {
    throw conflict(
      `manifest ${manifestId} is recorded ${known.phase}: a live execution authority is never returned to JSON, and a retired ` +
        `one has already left the staged phase behind. Nothing was aborted.`,
    );
  }
  if (known.phase === "aborted") return { manifestId, phase: "aborted", replayed: true };

  return withExecutionTransaction(context, (tx) => {
    const record = requireMigrationRecord({
      record: readMigrationRecord(tx.db, manifestId),
      manifestId,
      manifestHash,
      root,
      verb: "abort",
    });
    if (record.phase === "active" || record.phase === "retired") {
      throw conflict(
        `manifest ${manifestId} is recorded ${record.phase}; only a staged manifest aborts, and nothing was aborted.`,
      );
    }
    if (record.phase === "aborted") return { manifestId, phase: "aborted" as const, replayed: true };
    if (tx.execution.authorityState !== "staged" || tx.execution.manifestId !== manifestId) {
      throw conflict(
        `the execution authority is ${tx.execution.authorityState}` +
          `${tx.execution.manifestId === null ? "" : ` under manifest ${tx.execution.manifestId}`}, not the staged manifest ` +
          `${manifestId}. An abort removes only the staged rows it addresses; nothing was aborted.`,
      );
    }

    // The delete set is scoped to the workflows this manifest's own staged graph
    // holds, so an abort can never reach a record another manifest owns.
    const workflowIds = (tx.db.prepare("select workflow_id from execution_workflows order by workflow_id").all() as Array<{
      workflow_id?: unknown;
    }>).map((row) => String(row.workflow_id));
    const deletedRows: Record<string, number> = {};
    const now = new Date().toISOString();
    if (workflowIds.length > 0) {
      const placeholders = workflowIds.map(() => "?").join(", ");
      for (const table of STAGED_TABLES) {
        const before = tx.db.prepare(`select count(*) as n from ${table} where workflow_id in (${placeholders})`).get(...workflowIds) as
          | { n?: unknown }
          | undefined;
        deletedRows[table] = Number(before?.n ?? 0);
        tx.db.prepare(`delete from ${table} where workflow_id in (${placeholders})`).run(...workflowIds);
      }
    }
    // §2.1 legacy and staged share the unchanged JSON execution route, so an
    // aborted staging returns the store to `legacy` with the JSON route live
    // again — the root timestamp it imported is preserved (no root changed).
    tx.db
      .prepare("update execution_meta set authority_state = 'legacy', revision = revision + 1, manifest_id = null where id = 1")
      .run();
    tx.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
    const stored: ExecutionAbortRecord = {
      abortVersion: 1,
      manifestId,
      manifestHash,
      reason: input.reason,
      operator,
      storeId: tx.storeId,
      epoch: tx.epoch,
      previousAuthority: tx.execution.authorityState,
      deletedRows,
      abortedAt: now,
    };
    const wrote = tx.db
      .prepare(
        "update execution_migrations set phase = 'aborted', activation_receipt_json = ?, updated_at = ? " +
          "where manifest_id = ? and phase = 'staged'",
      )
      .run(JSON.stringify(stored), now, manifestId) as { changes?: unknown };
    if (Number(wrote.changes) !== 1) {
      throw conflict(`manifest ${manifestId} left the staged phase while the abort ran; the abort was rolled back and nothing changed.`);
    }
    migrationFailureHook(MIGRATION_FAILURE_ENV.abort, "before-commit");
    return { manifestId, phase: "aborted" as const, replayed: false };
  });
}
