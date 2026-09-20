/**
 * catalog-registration.ts — the registration journal: the ONE service that
 * joins an execution registration (snapshot + root active-workflow entry, the
 * JSON execution authority) to its catalog rows (store.db, the catalog
 * authority) without ever reporting a half-registered workflow as success
 * (state-projection-contract §3).
 *
 * Why a journal at all: SQLite cannot commit a filesystem JSON write, so the
 * three writes — snapshot, root entry, catalog rows — are not one atomic unit.
 * Contract §3 therefore mandates an explicit recoverable operation, under the
 * existing **root then workflow locks** (never DB-lock then file-lock):
 *
 * 1. validate the request, the catalog expectation, the execution identity and
 *    the pending delta's input paths, then write `catalog_operations.prepared`
 *    with that delta. A pending row is authority for NOTHING: it is not
 *    visible catalog metadata and it is not an execution registration.
 * 2. write the snapshot + root entry through the existing authorized producers
 *    (`registerPlanWorkflow` / `registerIterationWorkflow` /
 *    `promoteAuditPlans`), keeping their create-only, orphan and rollback
 *    semantics intact, then record the resulting file versions as
 *    `execution-written`.
 * 3. verify the on-disk identities still match and publish the catalog delta
 *    through the catalog DOMAIN verbs (P1) — entities, then relations, then
 *    the historical workflow association in `catalog_execution_bindings`,
 *    which commits together with the receipt in one journal transaction.
 * 4. `reconcileCatalogExecution` finishes exactly the writes the operation
 *    owns and is idempotent; anything it cannot finish without destroying or
 *    wrongly adopting bytes refuses visibly as `catalog.reconcile-conflict`.
 *    The ONE automatic abort is the provably unrecoverable state (a reviewed
 *    delta whose catalog expectation moved while nothing was written); every
 *    other abandonment is an explicit operator act (`abortCatalogExecution`,
 *    `mstar catalog reconcile --abort`), which itself refuses once execution
 *    bytes exist.
 *
 * Boundaries this module does not cross:
 *
 * - It never writes execution state by hand. Phase/progress/status/leases stay
 *   the existing JSON protocol; the only files it touches go through the
 *   producers above or the root writer `registerWorkflowEntryLocked`, and only
 *   to FINISH a write the operation already owns (`execution-written`).
 * - It never replaces, repairs or deletes foreign execution bytes. A snapshot
 *   whose registration identity is not this reviewed request refuses; a root
 *   entry whose snapshot is gone refuses (a stale entry is never re-pointed).
 * - It is not a second catalog writer: the reviewed delta is supplied by the
 *   caller and published verbatim through the P1 domain verbs, so every write
 *   keeps the store's epoch/role/idempotency/transaction rules.
 * - It never reports success for a pending operation. Readers of a
 *   root-visible workflow call `assertCatalogExecutionCommitted` and refuse
 *   `catalog.registration-pending` (contract §3 step 3: "a pending operation
 *   is `catalog.registration-pending`, never an empty or valid workspace").
 *
 * Crash states (contract §3 step 4), all expressible from the journal row:
 *
 * | crash point                       | journal row        | recovery                          |
 * |-----------------------------------|--------------------|-----------------------------------|
 * | before any file write             | `prepared`         | reconcile re-drives the request   |
 * | after the snapshot, before the    | `prepared` + bytes | reconcile finishes the root entry |
 * | root entry (or after a producer   |                    | (only when the identity matches)  |
 * | rollback that could not complete) |                    |                                   |
 * | after the root entry              | `execution-written`| reconcile re-verifies + publishes |
 * | after the catalog publish         | `execution-written`| reconcile re-publishes idempotent |
 * |                                   |                    | (domain operation ids) + commits  |
 * | never (the request cannot work)   | `aborted`          | re-register with a fresh id       |
 *
 * The caller must pin the artifact store to the harness root first
 * (`setArtifactStore(createFsStore(harnessDir))`) when the active store's root
 * could differ — the producers write through the active `ArtifactStore` with
 * fail-loud path agreement, exactly as they do today.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { promotedAuditSnapshot, promoteAuditPlans, promotedAuditPlanRows, type PromoteAuditPlansOptions } from "./audit.js";
import {
  CatalogError,
  catalogRootDir,
  linkCatalogEntities,
  registerCatalogEntity,
  type CatalogEntityInput,
  type CatalogEntityKind,
  type CatalogLinkInput,
  type CatalogRelation,
  type CatalogRootKind,
} from "./catalog.js";
import { isPlainObject, readArtifactBytes } from "./coordination-write.js";
import { withStatusWriteLock } from "./lease.js";
import { assertSafePathComponent } from "./path.js";
import { openStore, type StoreContext, type StoreDb } from "./store-db.js";
import { findRegisteredWorkflow, registerWorkflowEntryLocked, validateWorkflowEntry, type WorkflowEntry } from "./status.js";
import {
  WORKFLOW_SNAPSHOT_FILE,
  assertDeliveryRegistrationCoherence,
  iterationWorkflowRegistrationIdentity,
  iterationWorkflowSnapshot,
  planWorkflowRegistrationIdentity,
  planWorkflowSnapshot,
  readWorkflowSnapshot,
  registerIterationWorkflow,
  registerPlanWorkflow,
  stableJson,
  type RegisterIterationWorkflowOptions,
  type RegisterPlanWorkflowOptions,
  type WorkflowDeliveryKind,
  type WorkflowSnapshot,
} from "./workflow.js";

/** Transport version of the stored journal delta (reconcile reads it back). */
export const CATALOG_REGISTRATION_JOURNAL_VERSION = 1;

// ---------------------------------------------------------------------------
// Vocabulary (contract §3)
// ---------------------------------------------------------------------------

/** The three execution producers that register through this journal. */
export type CatalogExecutionKind = "plan" | "iteration" | "audit";

/** Journal phases (contract §2 `catalog_operations.phase`). */
export type CatalogExecutionPhase = "prepared" | "execution-written" | "committed" | "aborted";

/** The catalog families a workflow can be bound to (`catalog_execution_bindings`). */
export type CatalogExecutionBindingKind = "plan" | "iteration";

/** The workflow's own catalog identity, recorded at publish (§1/§2). */
export type CatalogExecutionBinding = {
  catalogKind: CatalogExecutionBindingKind;
  catalogId: string;
};

/**
 * The reviewed catalog delta: what the operation publishes AFTER the execution
 * registration matches. `entities` are created/attached in order through the
 * domain verbs, `links` are recorded once every entity exists, and `binding`
 * names the entity this workflow is associated with (one binding per workflow).
 */
export type CatalogExecutionCatalogDelta = {
  entities: CatalogEntityInput[];
  links?: CatalogLinkInput[];
  binding: CatalogExecutionBinding;
};

/**
 * The execution side of the request: the existing producer call, unchanged.
 * `plan`/`iteration` carry their producer's own workflow id (both producers
 * take it as their first argument); `audit` carries `promoteAuditPlans`'
 * `outDir` + selection, whose workflow id defaults to the audit dir basename
 * exactly as the producer resolves it.
 */
export type CatalogExecutionWorkflow =
  | { kind: "plan"; workflowId: string; options: RegisterPlanWorkflowOptions }
  | { kind: "iteration"; workflowId: string; options: RegisterIterationWorkflowOptions }
  | { kind: "audit"; outDir: string; selected: readonly string[]; options: PromoteAuditPlansOptions };

/**
 * One execution registration: the reviewed producer call, the reviewed catalog
 * delta, and the two fields the journal owns — the idempotency key and the
 * catalog revision the delta was reviewed against (contract §3 step 1).
 */
export type CatalogExecutionRequest = {
  /** Stable across retries: reusing it with a different request refuses. */
  operationId: string;
  /** Actor recorded on the journal row and on every catalog domain write. */
  actor: string;
  /** The store's catalog revision the reviewed delta was computed against. */
  expectedCatalogRevision: number;
  workflow: CatalogExecutionWorkflow;
  delta: CatalogExecutionCatalogDelta;
};

/** What a completed registration reports (contract §3 step 3). */
export type CatalogExecutionReceipt = {
  operationId: string;
  workflowId: string;
  /** Catalog revision AFTER the delta published (the registration's revision). */
  catalogRevision: number;
  /**
   * True when the call completed a registration whose execution bytes already
   * existed (an orphan produced by an earlier attempt of this operation) or
   * when it recovered a pending operation; false only for a fresh registration
   * that created its own snapshot.
   */
  recovered: boolean;
};

/** Current catalog-registration view of one workflow. */
export type CatalogRegistrationState = {
  workflowId: string;
  /** status.json shows an active root entry for this workflow. */
  rootVisible: boolean;
  /** A NON-committed journal operation recorded for this workflow, if any. */
  pending: { operationId: string; phase: "prepared" | "execution-written" } | null;
  /** The committed catalog association, if any (`catalog_execution_bindings`). */
  binding: { catalogKind: CatalogExecutionBindingKind; catalogId: string; catalogRevision: number } | null;
};

/** One pending operation as `mstar catalog reconcile --list` reports it. */
export type PendingCatalogRegistration = {
  operationId: string;
  workflowId: string;
  kind: CatalogExecutionKind;
  phase: "prepared" | "execution-written";
  createdAt: string;
  updatedAt: string;
  /** The root already shows this workflow, so a dispatch reader must refuse. */
  rootVisible: boolean;
};

/** Current store/catalog revisions — what a caller records as the expectation. */
export type CatalogRevisions = { storeRevision: number; catalogRevision: number };

/** Stable refusal codes; `store.*` / `catalog.not-found` are the shared ones. */
export type CatalogRegistrationErrorCode =
  | "catalog.registration-invalid"
  | "catalog.registration-conflict"
  | "catalog.registration-pending"
  | "catalog.registration-aborted"
  | "catalog.reconcile-conflict";

export class CatalogRegistrationError extends Error {
  readonly code: CatalogRegistrationErrorCode;

  constructor(code: CatalogRegistrationErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "CatalogRegistrationError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Request validation (contract §3 step 1: everything that can refuse, refuses
// before the first write of any kind)
// ---------------------------------------------------------------------------

const ENTITY_KINDS: Record<CatalogEntityKind, true> = {
  project: true,
  iteration: true,
  plan: true,
  document: true,
};

const ROOT_KINDS: Record<CatalogRootKind, true> = {
  repository: true,
  harness: true,
  plans: true,
  iterations: true,
  specs: true,
  knowledge: true,
  projects: true,
};

const DOCUMENT_KINDS: Record<string, true> = {
  spec: true,
  knowledge: true,
  guide: true,
  compass: true,
  plan: true,
  roadmap: true,
  review: true,
  other: true,
};

const RELATIONS: Record<CatalogRelation, true> = {
  "belongs-to": true,
  documents: true,
  "spec-ref": true,
  "knowledge-ref": true,
  "derived-from": true,
  supersedes: true,
};

function invalid(detail: string): never {
  throw new CatalogRegistrationError("catalog.registration-invalid", detail);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") invalid(`${field} must be a non-empty string`);
  return (value as string).trim();
}

function requireAbsoluteDir(value: unknown, field: string): string {
  const text = requireText(value, field);
  if (!text.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(text)) {
    invalid(`${field} must be an absolute path (the harness dir that contains status.json + workflows/)`);
  }
  return text;
}

/**
 * The lexical half of the location rule (contract §2): `/` separators, no NUL,
 * never absolute, no `..`. The authoritative containment/uniqueness/symlink
 * checks stay the catalog domain's, at publish — this gate exists so an
 * obviously hostile input path refuses BEFORE any execution file is written.
 */
function requireRelativePath(value: unknown, field: string): string {
  const raw = requireText(value, field);
  if (raw.includes("\0")) invalid(`${field} contains a NUL byte`);
  const unified = raw.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) invalid(`${field} must be relative to its declared root kind`);
  for (const segment of unified.split("/")) {
    if (segment === "..") invalid(`${field} contains a parent ("..") segment`);
  }
  return raw;
}

function requireKind(value: unknown, allowed: Record<string, true>, field: string): string {
  const text = requireText(value, field);
  if (!Object.hasOwn(allowed, text)) invalid(`${field} must be one of ${Object.keys(allowed).join(" | ")} \u2014 got ${JSON.stringify(text)}`);
  return text;
}

/**
 * The reviewed catalog delta. Shape only: identity, location authority,
 * relation pairs and uniqueness are the domain verbs' refusals at publish
 * (this module is not a second catalog validator). What IS enforced here is
 * what makes the operation a single registration rather than a split success:
 * at least one entity, and a binding that names one of this delta's entities
 * of the workflow's own kind.
 */
function validateDelta(delta: unknown, kind: CatalogExecutionKind): CatalogExecutionCatalogDelta {
  if (!isPlainObject(delta)) invalid("request.delta is required (the reviewed catalog delta: entities, links, binding)");
  const rawEntities = delta.entities;
  if (!Array.isArray(rawEntities) || rawEntities.length === 0) {
    invalid("request.delta.entities must be a non-empty array \u2014 a registration with no catalog delta would publish nothing");
  }
  const seenKeys = new Set<string>();
  const seenLocations = new Set<string>();
  const entities = rawEntities.map((raw, index) => {
    const at = `request.delta.entities[${index}]`;
    if (!isPlainObject(raw)) invalid(`${at} must be an object`);
    const entityKind = requireKind(raw.kind, ENTITY_KINDS, `${at}.kind`) as CatalogEntityKind;
    const id = requireText(raw.id, `${at}.id`);
    const title = requireText(raw.title, `${at}.title`);
    const rootKind = requireKind(raw.rootKind, ROOT_KINDS, `${at}.rootKind`) as CatalogRootKind;
    const relativePath = requireRelativePath(raw.relativePath, `${at}.relativePath`);
    if (entityKind === "document") {
      requireKind(raw.documentKind, DOCUMENT_KINDS, `${at}.documentKind`);
    } else if (raw.documentKind !== undefined && raw.documentKind !== null) {
      invalid(`${at}.documentKind is a document-row field only (kind=${entityKind})`);
    }
    if (raw.lifecycle !== undefined && !["active", "archived", "superseded"].includes(String(raw.lifecycle))) {
      invalid(`${at}.lifecycle must be active | archived | superseded`);
    }
    if (raw.sourceHash !== undefined && raw.sourceHash !== null && typeof raw.sourceHash !== "string") {
      invalid(`${at}.sourceHash must be a string when given`);
    }
    const key = `${entityKind}\u0000${id}`;
    if (seenKeys.has(key)) invalid(`${at} repeats the identity ${entityKind} ${JSON.stringify(id)} inside one delta`);
    seenKeys.add(key);
    const location = `${entityKind}\u0000${rootKind}\u0000${relativePath}`;
    if (seenLocations.has(location)) {
      invalid(`${at} repeats the location ${rootKind}/${relativePath} inside one delta \u2014 one id per location within a registration`);
    }
    seenLocations.add(location);
    return raw as unknown as CatalogEntityInput;
  });

  const rawLinks = delta.links;
  if (rawLinks !== undefined && !Array.isArray(rawLinks)) invalid("request.delta.links must be an array when given");
  const links = (rawLinks ?? []).map((raw, index) => {
    const at = `request.delta.links[${index}]`;
    if (!isPlainObject(raw)) invalid(`${at} must be an object`);
    for (const end of ["from", "to"] as const) {
      const key = raw[end];
      if (!isPlainObject(key)) invalid(`${at}.${end} must be { kind, id }`);
      requireKind(key.kind, ENTITY_KINDS, `${at}.${end}.kind`);
      requireText(key.id, `${at}.${end}.id`);
    }
    requireKind(raw.relation, RELATIONS, `${at}.relation`);
    return raw as unknown as CatalogLinkInput;
  });

  const rawBinding = delta.binding;
  if (!isPlainObject(rawBinding)) invalid("request.delta.binding is required (the workflow's own catalog identity)");
  const expectedBindingKind: CatalogExecutionBindingKind = kind === "iteration" ? "iteration" : "plan";
  const catalogKind = requireKind(rawBinding.catalogKind, { plan: true, iteration: true }, "request.delta.binding.catalogKind");
  if (catalogKind !== expectedBindingKind) {
    invalid(
      `request.delta.binding.catalogKind must be ${JSON.stringify(expectedBindingKind)} for a ${kind} workflow \u2014 ` +
        `a ${kind} registration binds its own catalog family, never another one`,
    );
  }
  const catalogId = requireText(rawBinding.catalogId, "request.delta.binding.catalogId");
  const bound = entities.some((entity) => entity.kind === catalogKind && entity.id === catalogId);
  if (!bound) {
    invalid(
      `request.delta.binding names ${catalogKind} ${JSON.stringify(catalogId)}, which this delta does not register \u2014 ` +
        "the binding must be one of the entities the operation publishes",
    );
  }

  return {
    entities,
    ...(links.length > 0 ? { links } : {}),
    binding: { catalogKind: expectedBindingKind, catalogId },
  };
}

type ValidatedRequest = {
  operationId: string;
  actor: string;
  expectedCatalogRevision: number;
  workflow: CatalogExecutionWorkflow;
  delta: CatalogExecutionCatalogDelta;
};

/** Shape gate over the reviewed request. The producers still validate authoritatively. */
function validateRequest(request: unknown): ValidatedRequest {
  if (!isPlainObject(request)) invalid("a catalog execution request object is required");
  const operationId = requireText(request.operationId, "request.operationId");
  const actor = requireText(request.actor, "request.actor");
  const expectedCatalogRevision = request.expectedCatalogRevision;
  if (typeof expectedCatalogRevision !== "number" || !Number.isSafeInteger(expectedCatalogRevision) || expectedCatalogRevision < 0) {
    invalid("request.expectedCatalogRevision must be the nonnegative catalog revision the delta was reviewed against");
  }
  const workflow = request.workflow;
  if (!isPlainObject(workflow)) invalid("request.workflow is required (kind + the producer call)");

  let validated: CatalogExecutionWorkflow;
  switch (workflow.kind) {
    case "plan": {
      const options = workflow.options;
      if (!isPlainObject(options)) invalid("request.workflow.options (RegisterPlanWorkflowOptions) is required");
      requireAbsoluteDir(options.harnessDir, "request.workflow.options.harnessDir");
      if (!isPlainObject(options.plan)) invalid("request.workflow.options.plan is required (id, title, file)");
      for (const field of ["id", "title", "file"] as const) {
        requireText((options.plan as Record<string, unknown>)[field], `request.workflow.options.plan.${field}`);
      }
      assertDeliveryRegistrationFor(options, "plan", "request.workflow");
      validated = { kind: "plan", workflowId: requireText(workflow.workflowId, "request.workflow.workflowId"), options: options as unknown as RegisterPlanWorkflowOptions };
      break;
    }
    case "iteration": {
      const options = workflow.options;
      if (!isPlainObject(options)) invalid("request.workflow.options (RegisterIterationWorkflowOptions) is required");
      requireAbsoluteDir(options.harnessDir, "request.workflow.options.harnessDir");
      requireText(options.compassRef, "request.workflow.options.compassRef");
      if (!isPlainObject(options.branch)) invalid("request.workflow.options.branch is required (base, integration, target)");
      for (const anchor of ["base", "integration", "target"] as const) {
        requireText((options.branch as Record<string, unknown>)[anchor], `request.workflow.options.branch.${anchor}`);
      }
      const rows = options.rows;
      if (!Array.isArray(rows) || rows.length === 0) {
        invalid("request.workflow.options.rows must be a non-empty array of { id, title, file }");
      }
      const seenRows = new Set<string>();
      for (const [index, row] of rows.entries()) {
        if (!isPlainObject(row)) invalid(`request.workflow.options.rows[${index}] must be an object`);
        for (const field of ["id", "title", "file"] as const) {
          requireText((row as Record<string, unknown>)[field], `request.workflow.options.rows[${index}].${field}`);
        }
        const rowId = (row as Record<string, unknown>).id as string;
        if (seenRows.has(rowId)) invalid(`request.workflow.options.rows repeats the plan row id ${JSON.stringify(rowId)}`);
        seenRows.add(rowId);
        if ("status" in row) {
          invalid(
            `request.workflow.options.rows[${index}] supplies a status \u2014 rows are always registered Todo; ` +
              "a state transition is requested through the lifecycle seams, never at registration",
          );
        }
      }
      // Iterations declare no delivery kind: their rows carry the delivery
      // metadata, so the per-kind coherence rule does not apply.
      validated = {
        kind: "iteration",
        workflowId: requireText(workflow.workflowId, "request.workflow.workflowId"),
        options: options as unknown as RegisterIterationWorkflowOptions,
      };
      break;
    }
    case "audit": {
      const options = workflow.options;
      if (!isPlainObject(options)) invalid("request.workflow.options (PromoteAuditPlansOptions) is required");
      requireAbsoluteDir(options.harnessDir, "request.workflow.options.harnessDir");
      const outDir = requireAbsoluteDir(workflow.outDir, "request.workflow.outDir");
      if (!Array.isArray(workflow.selected) || workflow.selected.length === 0) {
        invalid("request.workflow.selected must be a non-empty array of audit plan ids");
      }
      for (const [index, id] of workflow.selected.entries()) {
        requireText(id, `request.workflow.selected[${index}]`);
      }
      if (options.workflowId !== undefined) requireText(options.workflowId, "request.workflow.options.workflowId");
      assertDeliveryRegistrationFor(options, "audit", "request.workflow");
      validated = {
        kind: "audit",
        outDir,
        selected: workflow.selected.map((id) => String(id).trim()),
        options: options as unknown as PromoteAuditPlansOptions,
      };
      break;
    }
    default:
      invalid(`request.workflow.kind must be one of plan | iteration | audit \u2014 got ${JSON.stringify(workflow.kind)}`);
  }

  return {
    operationId,
    actor,
    expectedCatalogRevision: expectedCatalogRevision as number,
    workflow: validated,
    delta: validateDelta(request.delta, validated.kind),
  };
}

/**
 * The shared per-kind coherence rule the producers enforce (contract §1): the
 * delivery kind is declared, never inferred, and `development` /
 * `verification/report-only` carry their required evidence. Applied here so an
 * incomplete declaration refuses before the journal row exists.
 */
function assertDeliveryRegistrationFor(options: Record<string, unknown>, kind: "plan" | "audit", at: string): void {
  const deliveryKind = options.deliveryKind;
  if (typeof deliveryKind !== "string" || (deliveryKind !== "development" && deliveryKind !== "verification/report-only")) {
    invalid(`${at}.options.deliveryKind must be development | verification/report-only \u2014 got ${JSON.stringify(deliveryKind)}`);
  }
  try {
    assertDeliveryRegistrationCoherence(deliveryKind as WorkflowDeliveryKind, options, "registerCatalogExecution");
  } catch (error) {
    invalid(`${at}.options: ${(error as Error).message}`);
  }
  if (kind === "plan" && options.coordinator !== undefined) {
    if (!isPlainObject(options.coordinator)) invalid(`${at}.options.coordinator must be { session_id, session_file }`);
    requireText((options.coordinator as Record<string, unknown>).session_id, `${at}.options.coordinator.session_id`);
    requireText((options.coordinator as Record<string, unknown>).session_file, `${at}.options.coordinator.session_file`);
  }
  if (options.startedAt !== undefined) requireText(options.startedAt, `${at}.options.startedAt`);
}

// ---------------------------------------------------------------------------
// The execution plan: one snapshot definition per kind, shared with the
// producers so the journal never re-derives "which registration is this"
// ---------------------------------------------------------------------------

type ExecutionPlan = {
  kind: CatalogExecutionKind;
  workflowId: string;
  harnessDir: string;
  /** Absolute `workflows/<id>` dir. */
  dir: string;
  snapshotPath: string;
  statusPath: string;
  /** What this request registers — the identity source, never written here. */
  snapshot: WorkflowSnapshot;
  identity: string;
  request: ValidatedRequest;
};

function executionPlanFor(context: StoreContext, request: ValidatedRequest): ExecutionPlan {
  const workflow = request.workflow;
  const harnessDir = resolve(workflow.options.harnessDir);
  if (resolve(context.harnessDir) !== harnessDir) {
    invalid(
      `the store context harness dir (${resolve(context.harnessDir)}) and the producer's harnessDir (${harnessDir}) must be the same root: ` +
        "one execution registration, one catalog root",
    );
  }
  const workflowId =
    workflow.kind === "audit"
      ? (workflow.options.workflowId ?? basename(resolve(workflow.outDir)))
      : workflow.workflowId;
  assertSafePathComponent(workflowId, "workflow id");
  const requestedStart = workflow.kind === "audit" ? undefined : workflow.options.startedAt;
  const startedAt = requestedStart ?? new Date().toISOString();
  const snapshot =
    workflow.kind === "plan"
      ? planWorkflowSnapshot(workflowId, workflow.options, startedAt)
      : workflow.kind === "iteration"
        ? iterationWorkflowSnapshot(workflowId, workflow.options, startedAt)
        : promotedAuditSnapshot(workflowId, workflow.outDir, workflow.selected, workflow.options, startedAt);
  const dir = join(harnessDir, "workflows", workflowId);
  // Input paths, before any change (contract §3 step 1): each delta location
  // must resolve inside its declared root. The authoritative containment
  // (symlink/canonical) and uniqueness checks stay the catalog domain's.
  for (const entity of request.delta.entities) {
    const root = catalogRootDir(context, entity.rootKind);
    const target = resolve(root, entity.relativePath);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      invalid(`request.delta entity ${entity.kind} ${JSON.stringify(entity.id)} resolves to ${target}, outside its ${entity.rootKind} root`);
    }
  }
  return {
    kind: workflow.kind,
    workflowId,
    harnessDir,
    dir,
    snapshotPath: join(dir, WORKFLOW_SNAPSHOT_FILE),
    statusPath: join(harnessDir, "status.json"),
    snapshot,
    identity: onDiskIdentity(workflow.kind, snapshot),
    request,
  };
}

/**
 * The comparison the producers use for orphan recovery, by registration kind.
 * Audit promotions are `type: plan` snapshots and compare through the plan
 * subset (timestamps excluded — a retry never fails because the clock moved).
 */
function onDiskIdentity(kind: CatalogExecutionKind, snapshot: WorkflowSnapshot): string {
  return kind === "iteration" ? iterationWorkflowRegistrationIdentity(snapshot) : planWorkflowRegistrationIdentity(snapshot);
}

// ---------------------------------------------------------------------------
// Journal rows — one short write transaction each, never held across a file
// lock or a catalog domain call (contract §2/§3)
// ---------------------------------------------------------------------------

type JournalDelta = {
  version: number;
  workflow: {
    kind: CatalogExecutionKind;
    workflowId: string;
    harnessDir: string;
    dir: string;
    snapshotPath: string;
    statusPath: string;
    identity: string;
  };
  execution: CatalogExecutionWorkflow;
  catalog: CatalogExecutionCatalogDelta;
  actor: string;
  expectedCatalogRevision: number;
};

type JournalRow = {
  operation_id: string;
  request_hash: string;
  phase: CatalogExecutionPhase;
  catalog_delta_json: string;
  before_versions_json: string;
  after_versions_json: string;
  result_json: string | null;
  created_at: string;
  updated_at: string;
};

type FileVersions = { snapshotVersion: string; statusVersion: string };
type JournalVersions = FileVersions & { storeRevision: number; catalogRevision: number };

const JOURNAL_COLUMNS =
  "operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at";

function nowRfc3339(): string {
  return new Date().toISOString();
}

function requestHash(request: ValidatedRequest): string {
  return createHash("sha256")
    .update(
      stableJson({
        mutation: "registerCatalogExecution",
        operationId: request.operationId,
        actor: request.actor,
        expectedCatalogRevision: request.expectedCatalogRevision,
        workflow: request.workflow,
        delta: request.delta,
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * One short connection and one short `BEGIN IMMEDIATE` transaction (contract
 * §2). The connection is opened in `write` mode even for reads: this module is
 * a writer, and the read-only open path adds nothing (P2 recorded a
 * long-lived-process read-open flake on an idle store).
 */
async function withJournalWrite<T>(context: StoreContext, fn: (db: StoreDb) => T): Promise<T> {
  const handle = await openStore(context, "write");
  try {
    assertStoreActive(handle.db);
    handle.db.exec("begin immediate");
    try {
      const result = fn(handle.db);
      handle.db.exec("commit");
      return result;
    } catch (error) {
      try {
        handle.db.exec("rollback");
      } catch {
        // nothing committed either way
      }
      throw error;
    }
  } finally {
    handle.close();
  }
}

/**
 * A staged store is read-only to the ordinary domain verbs (contract §2), and
 * a registration publishes catalog rows — so the journal refuses there too
 * rather than half-registering against a store that cannot record it.
 */
function assertStoreActive(db: StoreDb): void {
  const row = db
    .prepare("select authority_state from store_meta where id = 1")
    .get() as { authority_state?: unknown } | undefined;
  if (!row || typeof row.authority_state !== "string") {
    throw new CatalogError("store.not-active", "store_meta is missing; the store cannot accept an execution registration");
  }
  if (row.authority_state !== "active") {
    throw new CatalogError(
      "store.not-active",
      `The catalog store is ${row.authority_state}; registering an execution publishes catalog rows and therefore requires an active store.`,
    );
  }
}

function readJournalVersions(db: StoreDb): { storeRevision: number; catalogRevision: number } {
  const row = db.prepare("select revision, catalog_revision from store_meta where id = 1").get() as
    | { revision?: unknown; catalog_revision?: unknown }
    | undefined;
  if (!row || typeof row.revision !== "number" || typeof row.catalog_revision !== "number") {
    throw new CatalogError("store.not-active", "store_meta is missing; the store cannot accept an execution registration");
  }
  return { storeRevision: row.revision, catalogRevision: row.catalog_revision };
}

function readRow(db: StoreDb, operationId: string): JournalRow | undefined {
  return db.prepare(`select ${JOURNAL_COLUMNS} from catalog_operations where operation_id = ?`).get(operationId) as
    | JournalRow
    | undefined;
}

function pendingRows(db: StoreDb): JournalRow[] {
  return db
    .prepare(`select ${JOURNAL_COLUMNS} from catalog_operations where phase in ('prepared','execution-written') order by updated_at asc`)
    .all() as JournalRow[];
}

/**
 * The NON-committed operation recorded for one workflow (contract §3 step 4),
 * as BOTH the registration view and the dispatch gate read it: the journal's
 * own phases, with `execution-written` reported as itself and every other
 * non-committed row as `prepared`. `null` means no operation for this workflow
 * is in flight — a committed or aborted row is not a pending registration.
 */
function pendingRegistrationOf(
  db: StoreDb,
  workflowId: string,
): { operationId: string; phase: "prepared" | "execution-written" } | null {
  const row = pendingRows(db).find((candidate) => parseJournalWorkflowId(candidate) === workflowId);
  if (row === undefined) return null;
  return { operationId: row.operation_id, phase: row.phase === "execution-written" ? "execution-written" : "prepared" };
}

/** True once this operation has published at least one of its catalog rows. */
function hasPublishedDelta(db: StoreDb, operationId: string): boolean {
  for (const suffix of ["entity:0", "link:0"]) {
    const row = db
      .prepare("select operation_id from catalog_operations where operation_id = ? and phase = 'committed' limit 1")
      .get(`${operationId}:${suffix}`);
    if (row !== undefined) return true;
  }
  return false;
}

function insertPrepared(db: StoreDb, request: ValidatedRequest, hash: string, delta: JournalDelta, before: JournalVersions): void {
  const at = nowRfc3339();
  db.prepare(
    "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) " +
      "values (?, ?, 'prepared', ?, ?, '{}', null, ?, ?)",
  ).run(request.operationId, hash, JSON.stringify(delta), JSON.stringify(before), at, at);
}

function recordExecutionWritten(db: StoreDb, operationId: string, after: JournalVersions, identity: string): void {
  db.prepare("update catalog_operations set phase = 'execution-written', after_versions_json = ?, updated_at = ? where operation_id = ?").run(
    JSON.stringify({ ...after, identity }),
    nowRfc3339(),
    operationId,
  );
}
function recordCommitted(db: StoreDb, operationId: string, after: JournalVersions, receipt: CatalogExecutionReceipt): void {
  db.prepare(
    "update catalog_operations set phase = 'committed', after_versions_json = ?, result_json = ?, updated_at = ? where operation_id = ?",
  ).run(JSON.stringify(after), JSON.stringify(receipt), nowRfc3339(), operationId);
}

function recordAborted(db: StoreDb, operationId: string, reason: string): void {
  db.prepare("update catalog_operations set phase = 'aborted', result_json = ?, updated_at = ? where operation_id = ?").run(
    JSON.stringify({ aborted: true, reason }),
    nowRfc3339(),
    operationId,
  );
}

function journalDeltaOf(plan: ExecutionPlan, request: ValidatedRequest): JournalDelta {
  return {
    version: CATALOG_REGISTRATION_JOURNAL_VERSION,
    workflow: {
      kind: plan.kind,
      workflowId: plan.workflowId,
      harnessDir: plan.harnessDir,
      dir: plan.dir,
      snapshotPath: plan.snapshotPath,
      statusPath: plan.statusPath,
      identity: plan.identity,
    },
    execution: request.workflow,
    catalog: request.delta,
    actor: request.actor,
    expectedCatalogRevision: request.expectedCatalogRevision,
  };
}

function parseJournalDelta(row: JournalRow): JournalDelta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.catalog_delta_json);
  } catch (error) {
    return failReconcile(`journal row ${row.operation_id} has an unparseable delta: ${(error as Error).message}`);
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.workflow) || !isPlainObject(parsed.execution) || !isPlainObject(parsed.catalog)) {
    return failReconcile(`journal row ${row.operation_id} does not carry a registration delta`);
  }
  return parsed as unknown as JournalDelta;
}

function failReconcile(detail: string): never {
  throw new CatalogRegistrationError("catalog.reconcile-conflict", detail);
}

// ---------------------------------------------------------------------------
// The execution side — producer call, orphan/identity verification, root write
// ---------------------------------------------------------------------------

/** Read once, tolerantly: a missing or malformed snapshot is "not this registration". */
function readSnapshotIfPresent(dir: string): { snapshot: WorkflowSnapshot } | undefined {
  try {
    return { snapshot: readWorkflowSnapshot(dir).snapshot };
  } catch {
    return undefined;
  }
}

function readFileVersions(plan: ExecutionPlan): FileVersions {
  return {
    snapshotVersion: readArtifactBytes(plan.snapshotPath)?.version ?? "absent",
    statusVersion: readArtifactBytes(plan.statusPath)?.version ?? "absent",
  };
}

/** The execution bytes this operation owns exist (in any completeness). */
function hasExecutionBytes(plan: ExecutionPlan): boolean {
  return existsSync(plan.snapshotPath) || findRegisteredWorkflow(plan.harnessDir, plan.workflowId) !== undefined;
}

type ExecutionWrite = FileVersions & { recovered: boolean };

/**
 * Bring the execution side to "snapshot + root entry, identity verified":
 * create it through the producer, or finish the root entry of an orphan — and
 * refuse anything that is not this reviewed request. Nothing foreign is ever
 * replaced, re-pointed or deleted (contract §3 step 2/step 4).
 */
async function ensureExecutionRegistration(plan: ExecutionPlan, mode: "register" | "reconcile"): Promise<ExecutionWrite> {
  const conflictError = (detail: string): CatalogRegistrationError => {
    const suffix = " \u2014 nothing was replaced or deleted";
    return mode === "reconcile"
      ? new CatalogRegistrationError("catalog.reconcile-conflict", `${detail}${suffix}`)
      : new CatalogRegistrationError("catalog.registration-conflict", `${detail}${suffix}`);
  };
  const rootEntry = findRegisteredWorkflow(plan.harnessDir, plan.workflowId);
  const existing = readSnapshotIfPresent(plan.dir);

  if (existing !== undefined) {
    if (existing.snapshot.id !== plan.workflowId || onDiskIdentity(plan.kind, existing.snapshot) !== plan.identity) {
      throw conflictError(
        `workflow ${JSON.stringify(plan.workflowId)} already has an execution registration at ${plan.snapshotPath} ` +
          "whose identity is NOT this reviewed request",
      );
    }
    if (rootEntry === undefined) {
      await writeRootEntry(plan, existing.snapshot);
      return { ...readFileVersions(plan), recovered: true };
    }
    if (mode === "register") {
      throw conflictError(
        `workflow ${JSON.stringify(plan.workflowId)} is already registered (snapshot + root entry); registration is create-only \u2014 ` +
          "remove that workflow before registering again, or reconcile an operation you already started",
      );
    }
    return { ...readFileVersions(plan), recovered: true };
  }

  if (rootEntry !== undefined) {
    throw conflictError(
      `the root register shows workflow ${JSON.stringify(plan.workflowId)} but its snapshot ${plan.snapshotPath} is missing; ` +
        "a stale root entry is never repaired or re-pointed",
    );
  }

  const created = await createExecution(plan);
  const written = readSnapshotIfPresent(plan.dir);
  if (written === undefined) {
    throw new CatalogRegistrationError(
      "catalog.registration-invalid",
      `the producer reported success but no readable snapshot exists at ${plan.snapshotPath}`,
    );
  }
  if (written.snapshot.id !== plan.workflowId || onDiskIdentity(plan.kind, written.snapshot) !== plan.identity) {
    throw conflictError(`the snapshot written at ${plan.snapshotPath} does not carry this reviewed request's identity`);
  }
  if (findRegisteredWorkflow(plan.harnessDir, plan.workflowId) === undefined) {
    // The producer writes the root entry itself; reaching here means it was
    // removed between the two steps. Finish the write we own.
    await writeRootEntry(plan, written.snapshot);
  }
  return { ...readFileVersions(plan), recovered: created.recovered };
}

/** The one authorized root write: the entry for a snapshot this operation owns. */
async function writeRootEntry(plan: ExecutionPlan, snapshot: WorkflowSnapshot): Promise<void> {
  const entry: WorkflowEntry = {
    id: plan.workflowId,
    type: snapshot.type,
    started_at: snapshot.started_at,
    dir: `workflows/${plan.workflowId}`,
  };
  const gate = validateWorkflowEntry(entry);
  if (!gate.ok) {
    throw new CatalogRegistrationError(
      "catalog.registration-invalid",
      `refusing to register invalid workflow entry: ${gate.violations.map((v) => v.message).join("; ")}`,
    );
  }
  await withStatusWriteLock(plan.statusPath, () => registerWorkflowEntryLocked(plan.statusPath, entry));
}

/** The existing create-only producer for this kind (unchanged semantics). */
async function createExecution(plan: ExecutionPlan): Promise<{ recovered: boolean }> {
  const workflow = plan.request.workflow;
  switch (workflow.kind) {
    case "plan": {
      const result = await registerPlanWorkflow(plan.workflowId, workflow.options);
      return { recovered: result.recovered };
    }
    case "iteration": {
      const result = await registerIterationWorkflow(plan.workflowId, workflow.options);
      return { recovered: result.recovered };
    }
    case "audit":
      // `promoteAuditPlans` is run-once: it refuses an existing snapshot, so a
      // promotion that reaches the create path always created its own bytes.
      await promoteAuditPlans(workflow.outDir, workflow.selected, workflow.options);
      return { recovered: false };
  }
}

// ---------------------------------------------------------------------------
// The catalog side — published only after the execution registration matches
// ---------------------------------------------------------------------------

/**
 * Verify the execution side, then publish the delta and commit the receipt.
 * Runs under the ROOT lock (root → workflow is the documented acquisition
 * order; the file lock is taken before any DB transaction, never the other way
 * round), so a concurrent root writer cannot slip between the verification and
 * the publish.
 */
async function publishUnderRootLock(
  context: StoreContext,
  plan: ExecutionPlan,
  mode: "register" | "reconcile",
  write: ExecutionWrite,
): Promise<CatalogExecutionReceipt> {
  const conflictError = (detail: string): CatalogRegistrationError =>
    mode === "reconcile"
      ? new CatalogRegistrationError("catalog.reconcile-conflict", detail)
      : new CatalogRegistrationError("catalog.registration-conflict", detail);

  return await withStatusWriteLock(plan.statusPath, async () => {
    const rootEntry = findRegisteredWorkflow(plan.harnessDir, plan.workflowId);
    const onDisk = readSnapshotIfPresent(plan.dir);
    if (rootEntry === undefined || onDisk === undefined) {
      throw conflictError(
        `workflow ${JSON.stringify(plan.workflowId)} is no longer root-visible with its snapshot at ${plan.snapshotPath}; ` +
          "the catalog delta is not published for an execution registration that does not hold",
      );
    }
    if (onDisk.snapshot.id !== plan.workflowId || onDiskIdentity(plan.kind, onDisk.snapshot) !== plan.identity) {
      throw conflictError(
        `the execution registration at ${plan.snapshotPath} changed after this operation wrote it; ` +
          "the catalog delta describes the reviewed request, not those bytes",
      );
    }

    const state = await withJournalWrite(context, (db) => ({
      published: hasPublishedDelta(db, plan.request.operationId),
      versions: readJournalVersions(db),
    }));
    // The expectation is the revision the delta was reviewed against. Once
    // this operation has published something, the moving revision is its own.
    if (!state.published && state.versions.catalogRevision !== plan.request.expectedCatalogRevision) {
      const detail =
        `the reviewed delta expected catalog revision ${plan.request.expectedCatalogRevision}, but the store is at ` +
        `${state.versions.catalogRevision} \u2014 the catalog moved since this delta was reviewed`;
      if (mode === "reconcile") failReconcile(`${detail}; publish it against a current review instead`);
      throw new CatalogError("catalog.revision-conflict", `${detail}; nothing was published.`);
    }

    for (const [index, entity] of plan.request.delta.entities.entries()) {
      try {
        await registerCatalogEntity(context, entity, {
          operationId: `${plan.request.operationId}:entity:${index}`,
          actor: plan.request.actor,
        });
      } catch (error) {
        if (mode === "reconcile") failReconcile(`re-publishing ${entity.kind} ${JSON.stringify(entity.id)} refused: ${(error as Error).message}`);
        throw error;
      }
    }
    for (const [index, link] of (plan.request.delta.links ?? []).entries()) {
      try {
        await linkCatalogEntities(context, link, {
          operationId: `${plan.request.operationId}:link:${index}`,
          actor: plan.request.actor,
        });
      } catch (error) {
        if (mode === "reconcile") failReconcile(`re-publishing the relation refused: ${(error as Error).message}`);
        throw error;
      }
    }

    return await withJournalWrite(context, (db) => {
      const bindingInput = bindingInputOf(plan);
      const versions = readJournalVersions(db);
      writeBinding(db, plan, bindingInput, versions.catalogRevision);
      const receipt: CatalogExecutionReceipt = {
        operationId: plan.request.operationId,
        workflowId: plan.workflowId,
        catalogRevision: versions.catalogRevision,
        recovered: write.recovered || mode === "reconcile",
      };
      recordCommitted(db, plan.request.operationId, { ...write, ...versions }, receipt);
      return receipt;
    });
  });
}

/**
 * The frozen input the binding records: the workflow's own catalog identity as
 * this operation published it (id, location, revision, body hash). It is
 * history + the pin P4's prepare readers consume (`catalog_pin`), never an
 * execution status copy.
 */
function bindingInputOf(plan: ExecutionPlan): { kind: CatalogEntityKind; id: string; rootKind: CatalogRootKind; relativePath: string; documentKind: string | null; sourceHash: string | null } {
  const binding = plan.request.delta.binding;
  const entity = plan.request.delta.entities.find((candidate) => candidate.kind === binding.catalogKind && candidate.id === binding.catalogId);
  if (entity === undefined) {
    // validateDelta guarantees this; kept as a guard rather than a silent null.
    throw new CatalogRegistrationError(
      "catalog.registration-invalid",
      `the delta no longer carries its binding entity ${binding.catalogKind} ${JSON.stringify(binding.catalogId)} (${plan.workflowId})`,
    );
  }
  return {
    kind: entity.kind,
    id: entity.id,
    rootKind: entity.rootKind,
    relativePath: entity.relativePath,
    documentKind: entity.documentKind ?? null,
    sourceHash: entity.sourceHash ?? null,
  };
}

function writeBinding(
  db: StoreDb,
  plan: ExecutionPlan,
  bindingInput: { kind: CatalogEntityKind; id: string; rootKind: CatalogRootKind; relativePath: string; documentKind: string | null; sourceHash: string | null },
  catalogRevision: number,
): void {
  const binding = plan.request.delta.binding;
  const row = db
    .prepare("select operation_id, catalog_revision, input_hash from catalog_execution_bindings where workflow_id = ? and catalog_kind = ? and catalog_id = ?")
    .get(plan.workflowId, binding.catalogKind, binding.catalogId) as
    | { operation_id?: unknown; catalog_revision?: unknown; input_hash?: unknown }
    | undefined;
  const pin = stableJson(bindingInput);
  const inputHash = createHash("sha256").update(pin, "utf8").digest("hex");
  if (row !== undefined) {
    if (row.operation_id !== plan.request.operationId) {
      throw new CatalogRegistrationError(
        "catalog.reconcile-conflict",
        `workflow ${JSON.stringify(plan.workflowId)} is already bound to ${binding.catalogKind} ${JSON.stringify(binding.catalogId)} ` +
          `by operation ${JSON.stringify(String(row.operation_id))}; this operation does not overwrite another registration's binding`,
      );
    }
    // Idempotent replay of this operation's own binding.
    db.prepare(
      "update catalog_execution_bindings set catalog_revision = ?, input_hash = ?, pin_json = ? where workflow_id = ? and catalog_kind = ? and catalog_id = ?",
    ).run(catalogRevision, inputHash, pin, plan.workflowId, binding.catalogKind, binding.catalogId);
    return;
  }
  db.prepare(
    "insert into catalog_execution_bindings(workflow_id, catalog_kind, catalog_id, workflow_root_kind, workflow_relative_path, catalog_revision, input_hash, pin_json, operation_id) " +
      "values (?, ?, ?, 'harness', ?, ?, ?, ?, ?)",
  ).run(
    plan.workflowId,
    binding.catalogKind,
    binding.catalogId,
    `workflows/${plan.workflowId}`,
    catalogRevision,
    inputHash,
    pin,
    plan.request.operationId,
  );
}

// ---------------------------------------------------------------------------
// Public interface (contract §3)
// ---------------------------------------------------------------------------

/**
 * Register one execution (snapshot + root entry) together with its catalog
 * rows, through the journal above. Returns the receipt only when BOTH halves
 * landed: a failure anywhere leaves the journal row as the recovery record
 * (a pending operation, which refuses dispatch) and rethrows — a half-written
 * registration is never reported as success.
 *
 * Refusals: `catalog.registration-invalid` (request/delta shape, before any
 * write), `store.not-active` / `store.not-initialized` / the store-runtime
 * refusals, `catalog.revision-conflict` (the catalog moved past the reviewed
 * expectation), `catalog.registration-conflict` (the execution side is already
 * registered, or belongs to another request), `catalog.registration-pending`
 * (an operation for this workflow — or this operation id — is already in
 * flight), `catalog.registration-aborted` (that operation id is spent),
 * `store.operation-conflict` (the operation id was reused with a different
 * request), plus the producers' own refusals and the catalog domain verbs'
 * refusals at publish.
 */
export async function registerCatalogExecution(
  context: StoreContext,
  request: CatalogExecutionRequest,
): Promise<CatalogExecutionReceipt> {
  const validated = validateRequest(request);
  const plan = executionPlanFor(context, validated);
  const hash = requestHash(validated);

  const prepared = await withJournalWrite(context, (db) => {
    // The operation id is checked FIRST: an idempotent replay of a committed
    // operation must not depend on where the catalog has moved since — only a
    // genuinely new operation is subject to the reviewed expectation.
    const existing = readRow(db, validated.operationId);
    if (existing !== undefined) {
      if (existing.request_hash !== hash) {
        throw new CatalogError(
          "store.operation-conflict",
          "The same operationId was reused with a different request; the original registration is retained.",
        );
      }
      if (existing.phase === "committed") return { kind: "replayed" as const, receipt: receiptOfRow(existing) };
      if (existing.phase === "aborted") {
        throw new CatalogRegistrationError(
          "catalog.registration-aborted",
          `operation ${JSON.stringify(validated.operationId)} was aborted and left no writes; re-register with a fresh operation id.`,
        );
      }
      throw new CatalogRegistrationError(
        "catalog.registration-pending",
        `operation ${JSON.stringify(validated.operationId)} is still ${existing.phase} \u2014 it must be reconciled, not restarted: ` +
          `run "mstar catalog reconcile --operation-id ${validated.operationId}".`,
      );
    }
    const versions = readJournalVersions(db);
    if (versions.catalogRevision !== validated.expectedCatalogRevision) {
      throw new CatalogError(
        "catalog.revision-conflict",
        `the reviewed delta expects catalog revision ${validated.expectedCatalogRevision}, but the store is at ` +
          `${versions.catalogRevision}; nothing was registered.`,
      );
    }
    const inFlight = pendingRows(db).find((row) => parseJournalWorkflowId(row) === plan.workflowId);
    if (inFlight !== undefined) {
      throw new CatalogRegistrationError(
        "catalog.registration-pending",
        `workflow ${JSON.stringify(plan.workflowId)} has a pending registration operation ${JSON.stringify(inFlight.operation_id)} ` +
          `(${inFlight.phase}); a half-registered workflow is never re-registered \u2014 ` +
          `run "mstar catalog reconcile --operation-id ${inFlight.operation_id}".`,
      );
    }
    insertPrepared(db, validated, hash, journalDeltaOf(plan, validated), { ...readFileVersions(plan), ...versions });
    return { kind: "prepared" as const };
  });

  if (prepared.kind === "replayed") return prepared.receipt;

  // Step 2 — the file primitives. A failure here leaves the prepared row as
  // the recovery record (and any partial bytes it produced), never a receipt.
  const write = await ensureExecutionRegistration(plan, "register");
  await withJournalWrite(context, (db) => recordExecutionWritten(db, validated.operationId, { ...write, ...readJournalVersions(db) }, plan.identity));

  // Step 3 — verify + publish + commit.
  return await publishUnderRootLock(context, plan, "register", write);
}

/**
 * The catalog delta implied by a producer's own reviewed inputs (contract §3):
 * the plan/iteration registration derives its single entity from the producer
 * options, and an audit promotion derives one entity per promoted plan row
 * from the plan documents themselves (the body is the title authority). The
 * binding follows the workflow's primary association.
 */
function catalogDeltaFor(workflow: CatalogExecutionWorkflow): CatalogExecutionCatalogDelta {
  if (workflow.kind === "plan") {
    return {
      entities: [
        { kind: "plan", id: workflow.options.plan.id, title: workflow.options.plan.title, rootKind: "plans", relativePath: workflow.options.plan.file },
      ],
      binding: { catalogKind: "plan", catalogId: workflow.options.plan.id },
    };
  }
  if (workflow.kind === "iteration") {
    return {
      entities: [{ kind: "iteration", id: workflow.workflowId, title: workflow.workflowId, rootKind: "iterations", relativePath: workflow.workflowId }],
      binding: { catalogKind: "iteration", catalogId: workflow.workflowId },
    };
  }
  const rows = promotedAuditPlanRows(workflow.outDir, workflow.selected);
  if (rows.length === 0) {
    invalid("an audit promotion selects no plan rows; there is no catalog delta to register");
  }
  return {
    entities: rows.map((row) => ({
      kind: "plan" as const,
      id: requireText(row.id, "promoted plan row id"),
      title: requireText(row.title, `promoted plan row ${String(row.id)} title`),
      rootKind: "plans" as const,
      relativePath: requireText(row.file, `promoted plan row ${String(row.id)} file`),
    })),
    binding: { catalogKind: "plan", catalogId: requireText(rows[0].id, "promoted plan row id") },
  };
}

/**
 * The shipped registration transport (contract §3): every CLI registration
 * entry point goes through `registerCatalogExecution` with the catalog delta
 * implied by its producer inputs, the CURRENT catalog revision as the reviewed
 * expectation, and a deterministic operation id derived from the request — so
 * a CLI retry replays idempotently instead of double-registering. Success is
 * reported only from the committed receipt; a failure leaves the journal row
 * as the recovery record for `catalog reconcile`.
 */
export async function registerShippedCatalogExecution(
  context: StoreContext,
  input: {
    /** Actor recorded on the journal row and on every catalog domain write. */
    actor: string;
    workflow: CatalogExecutionWorkflow;
    /** Defaults to a request-derived id; pass one to pin a retry identity. */
    operationId?: string;
  },
): Promise<CatalogExecutionReceipt> {
  const workflow = input.workflow;
  const delta = catalogDeltaFor(workflow);
  const operationId =
    input.operationId ??
    `op-${createHash("sha256").update(stableJson({ actor: input.actor, workflow, delta })).digest("hex").slice(0, 24)}`;
  const { catalogRevision } = await readCatalogRevisions(context);
  return await registerCatalogExecution(context, {
    operationId,
    actor: input.actor,
    expectedCatalogRevision: catalogRevision,
    workflow,
    delta,
  });
}

/**
 * Finish a pending registration: re-check the exact request identity and the
 * recorded byte versions, complete the writes the operation owns, publish and
 * commit. Idempotent — a committed operation returns its recorded receipt and
 * writes nothing; an operation that cannot be finished without destroying or
 * wrongly adopting execution bytes refuses `catalog.reconcile-conflict` and
 * leaves everything in place (contract §3 step 4).
 */
export async function reconcileCatalogExecution(
  context: StoreContext,
  operationId: string,
): Promise<CatalogExecutionReceipt> {
  const id = requireText(operationId, "operationId");
  const loaded = await withJournalWrite(context, (db) => readRow(db, id));
  if (loaded === undefined) {
    throw new CatalogError("catalog.not-found", `No catalog registration operation ${JSON.stringify(id)} is recorded in this store.`);
  }
  if (loaded.phase === "committed") return receiptOfRow(loaded);
  if (loaded.phase === "aborted") {
    throw new CatalogRegistrationError(
      "catalog.registration-aborted",
      `operation ${JSON.stringify(id)} was aborted and left no writes; nothing was recovered \u2014 re-register with a fresh operation id.`,
    );
  }

  const journal = parseJournalDelta(loaded);
  const request: CatalogExecutionRequest = {
    operationId: id,
    actor: journal.actor,
    expectedCatalogRevision: journal.expectedCatalogRevision,
    workflow: journal.execution,
    delta: journal.catalog,
  };
  const validated = validateRequest(request);
  const plan = executionPlanFor(context, validated);
  if (requestHash(validated) !== loaded.request_hash) {
    failReconcile(
      `operation ${JSON.stringify(id)} records a request hash that does not match its stored delta \u2014 the journal row was altered; ` +
        "reconcile refuses to re-drive it",
    );
  }
  if (plan.workflowId !== journal.workflow.workflowId || plan.identity !== journal.workflow.identity) {
    failReconcile(
      `operation ${JSON.stringify(id)} was prepared for workflow ${JSON.stringify(journal.workflow.workflowId)}, but the stored ` +
        `request now resolves to ${JSON.stringify(plan.workflowId)} \u2014 the reviewed inputs changed since it was prepared`,
    );
  }

  const state = await withJournalWrite(context, (db) => ({
    published: hasPublishedDelta(db, id),
    versions: readJournalVersions(db),
  }));
  if (!state.published && state.versions.catalogRevision !== validated.expectedCatalogRevision) {
    const detail =
      `operation ${JSON.stringify(id)} was prepared against catalog revision ${validated.expectedCatalogRevision}, but the store is ` +
      `at ${state.versions.catalogRevision}`;
    if (hasExecutionBytes(plan)) {
      failReconcile(
        `${detail}; its execution registration is already on disk, so the pending delta is NOT dropped \u2014 resolve or remove that ` +
          "workflow explicitly, then re-register against a current review",
      );
    }
    await withJournalWrite(context, (db) => recordAborted(db, id, "catalog expectation is stale and nothing was written"));
    throw new CatalogRegistrationError(
      "catalog.reconcile-conflict",
      `${detail} and nothing of this operation was written; the pending delta was aborted (no files, no catalog rows) \u2014 ` +
        "re-register with a fresh operation id against a current catalog revision.",
    );
  }

  let write: ExecutionWrite;
  try {
    write = await ensureExecutionRegistration(plan, "reconcile");
  } catch (error) {
    if (error instanceof CatalogRegistrationError) throw error;
    // A re-drive failure (IO, a store-root mismatch, a producer refusal) is NOT
    // proof that the request is unrecoverable: the pending row is KEPT, and the
    // operator either fixes the reported condition and reconciles again, or
    // abandons the operation explicitly (`abortCatalogExecution`). Silently
    // dropping a recoverable operation here would lose a registration that a
    // fixed environment could still complete (contract §3 step 4).
    failReconcile(
      `operation ${JSON.stringify(id)} could not be re-driven (${(error as Error).message}); ` +
        `${hasExecutionBytes(plan) ? `its execution registration is at ${plan.dir}` : "nothing of it was written"}, so the pending row ` +
        'is kept \u2014 fix the reported condition and reconcile again, or abandon the operation explicitly ("catalog reconcile --abort")',
    );
  }

  await withJournalWrite(context, (db) => recordExecutionWritten(db, id, { ...write, ...readJournalVersions(db) }, plan.identity));
  return await publishUnderRootLock(context, plan, "reconcile", write);
}

/** What an explicit abort reports. */
export type CatalogExecutionAbort = {
  operationId: string;
  workflowId: string;
  phase: "aborted";
};

/**
 * Abandon a pending registration ON PURPOSE. Only an operation that wrote
 * nothing may be aborted (contract §3 step 4: "reconcile may abort pending
 * delta without changing files") — an operation whose snapshot or root entry
 * is on disk refuses `catalog.reconcile-conflict`, because abandoning it would
 * leave exactly the half-registered workflow the journal exists to prevent.
 *
 * The row becomes `aborted`: terminal for that operation id (a later register
 * with it refuses `catalog.registration-aborted`) and invisible to the pending
 * gate, so the workflow id is free to register again under a fresh id. This is
 * the explicit escape hatch reconcile never takes on its own — the automatic
 * abort is restricted to the one provably unrecoverable state (a stale
 * reviewed expectation with nothing written).
 */
export async function abortCatalogExecution(
  context: StoreContext,
  operationId: string,
  reason?: string,
): Promise<CatalogExecutionAbort> {
  const id = requireText(operationId, "operationId");
  const loaded = await withJournalWrite(context, (db) => readRow(db, id));
  if (loaded === undefined) {
    throw new CatalogError("catalog.not-found", `No catalog registration operation ${JSON.stringify(id)} is recorded in this store.`);
  }
  const journal = parseJournalDelta(loaded);
  if (loaded.phase === "aborted") {
    return { operationId: id, workflowId: journal.workflow.workflowId, phase: "aborted" };
  }
  if (loaded.phase === "committed") {
    failReconcile(
      `operation ${JSON.stringify(id)} is committed (workflow ${JSON.stringify(journal.workflow.workflowId)} is registered); ` +
        "a completed registration is never aborted \u2014 remove that workflow through its own lifecycle instead",
    );
  }
  if (existsSync(journal.workflow.snapshotPath) || findRegisteredWorkflow(journal.workflow.harnessDir, journal.workflow.workflowId) !== undefined) {
    failReconcile(
      `operation ${JSON.stringify(id)} already wrote its execution registration (${journal.workflow.snapshotPath}); abandoning it would ` +
        "leave a half-registered workflow \u2014 resolve or remove that workflow explicitly, then re-register",
    );
  }
  await withJournalWrite(context, (db) => recordAborted(db, id, reason ?? "abandoned by the operator"));
  return { operationId: id, workflowId: journal.workflow.workflowId, phase: "aborted" };
}

/** The current store/catalog revisions: what a caller records as the expectation. */
export async function readCatalogRevisions(context: StoreContext): Promise<CatalogRevisions> {
  return await withJournalWrite(context, (db) => readJournalVersions(db));
}

/**
 * The catalog-registration view of one workflow: whether the root shows it,
 * the NON-committed operation recorded for it (the recovery record) and the
 * committed catalog association. `catalog_execution_bindings` is the
 * per-workflow lookup, so this never scans committed journal rows.
 */
export async function resolveCatalogRegistrationState(
  context: StoreContext,
  workflowId: string,
): Promise<CatalogRegistrationState> {
  const id = requireText(workflowId, "workflowId");
  const rootVisible = findRegisteredWorkflow(resolve(context.harnessDir), id) !== undefined;
  return await withJournalWrite(context, (db) => {
    const bindingRow = db
      .prepare("select catalog_kind, catalog_id, catalog_revision, operation_id from catalog_execution_bindings where workflow_id = ?")
      .get(id) as { catalog_kind?: unknown; catalog_id?: unknown; catalog_revision?: unknown } | undefined;
    return {
      workflowId: id,
      rootVisible,
      pending: pendingRegistrationOf(db, id),
      binding:
        bindingRow !== undefined && (bindingRow.catalog_kind === "plan" || bindingRow.catalog_kind === "iteration")
          ? {
              catalogKind: bindingRow.catalog_kind,
              catalogId: String(bindingRow.catalog_id),
              catalogRevision: typeof bindingRow.catalog_revision === "number" ? bindingRow.catalog_revision : 0,
            }
          : null,
    };
  });
}

/**
 * The dispatch gate (contract §3 step 3): a root-visible workflow whose
 * catalog registration is not committed refuses — a pending operation is never
 * a valid workspace. A workflow with NO journal operation is left to the
 * activation-completeness rule (§7 of the issue contract: pre-activation
 * registers are excluded/reloaded by the cutover, not retro-refused here).
 *
 * Requires an initialized ACTIVE store: a missing store refuses
 * `store.not-initialized` and a staged one `store.not-active` — a missing
 * database is never an empty catalog and never a silent pass.
 */
export async function assertCatalogExecutionCommitted(context: StoreContext, workflowId: string): Promise<void> {
  const state = await resolveCatalogRegistrationState(context, workflowId);
  if (!state.rootVisible || state.pending === null) return;
  refusePendingRegistration(state.workflowId, state.pending);
}

/** The ONE refusal a pending registration produces, verbatim for both handles. */
function refusePendingRegistration(
  workflowId: string,
  pending: { operationId: string; phase: "prepared" | "execution-written" },
): never {
  throw new CatalogRegistrationError(
    "catalog.registration-pending",
    `workflow ${JSON.stringify(workflowId)} is root-visible but its catalog registration is ${pending.phase}, not committed ` +
      `(operation ${JSON.stringify(pending.operationId)}); dispatch must refuse until it is reconciled: ` +
      `run "mstar catalog reconcile --operation-id ${pending.operationId}".`,
  );
}

/**
 * The SAME registration gate through a handle the caller ALREADY owns: a
 * root-visible workflow whose catalog operation is recorded but not committed
 * refuses `catalog.registration-pending`. The execution transaction opens one
 * handle on the same `store.db`, so a DB `prepare` enforces its registration
 * admission under its own write lock through this function instead of opening
 * a second connection — exactly as `catalogPinFactsOn` reads a pin — and the
 * "pending" verdict stays defined once, by `pendingRegistrationOf`.
 *
 * Store-state tolerances stay with the handle owner: a missing store never gets
 * here (the opener refuses `store.not-initialized`), and a `store_meta` that is
 * not ACTIVE keeps the pre-activation exclusion (§7) — a staged store is not a
 * catalog verdict, so it passes through and is never retro-refused here.
 */
export function assertCatalogExecutionCommittedOn(db: StoreDb, harnessDir: string, workflowId: string): void {
  const id = requireText(workflowId, "workflowId");
  const meta = db.prepare("select authority_state from store_meta where id = 1").get() as
    | { authority_state?: unknown }
    | undefined;
  if (meta?.authority_state !== "active") return;
  if (findRegisteredWorkflow(resolve(harnessDir), id) === undefined) return;
  const pending = pendingRegistrationOf(db, id);
  if (pending === null) return;
  refusePendingRegistration(id, pending);
}

/** Every pending registration operation, oldest first (recovery discovery). */
export async function listPendingCatalogRegistrations(context: StoreContext): Promise<PendingCatalogRegistration[]> {
  const harnessDir = resolve(context.harnessDir);
  return await withJournalWrite(context, (db) =>
    pendingRows(db).flatMap((row) => {
      const workflowId = parseJournalWorkflowId(row);
      if (workflowId === undefined) return [];
      let kind: CatalogExecutionKind = "plan";
      try {
        const parsed = JSON.parse(row.catalog_delta_json) as { workflow?: { kind?: unknown } };
        const raw = parsed?.workflow?.kind;
        if (raw === "plan" || raw === "iteration" || raw === "audit") kind = raw;
      } catch {
        // An unparseable delta is still reported as a pending operation.
      }
      return [
        {
          operationId: row.operation_id,
          workflowId,
          kind,
          phase: row.phase === "execution-written" ? ("execution-written" as const) : ("prepared" as const),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          rootVisible: findRegisteredWorkflow(harnessDir, workflowId) !== undefined,
        },
      ];
    }),
  );
}

/** The workflow id a journal row was prepared for, or undefined when unreadable. */
function parseJournalWorkflowId(row: JournalRow): string | undefined {
  try {
    const parsed = JSON.parse(row.catalog_delta_json) as { workflow?: { workflowId?: unknown } };
    const id = parsed?.workflow?.workflowId;
    return typeof id === "string" && id.trim() !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}

function receiptOfRow(row: JournalRow): CatalogExecutionReceipt {
  if (row.result_json === null) {
    failReconcile(`operation ${JSON.stringify(row.operation_id)} is ${row.phase} without a recorded receipt`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.result_json);
  } catch (error) {
    return failReconcile(`operation ${JSON.stringify(row.operation_id)} has an unparseable receipt: ${(error as Error).message}`);
  }
  if (!isPlainObject(parsed) || typeof parsed.workflowId !== "string" || typeof parsed.catalogRevision !== "number") {
    return failReconcile(`operation ${JSON.stringify(row.operation_id)} does not carry a receipt`);
  }
  return {
    operationId: row.operation_id,
    workflowId: parsed.workflowId,
    catalogRevision: parsed.catalogRevision,
    recovered: parsed.recovered === true,
  };
}
