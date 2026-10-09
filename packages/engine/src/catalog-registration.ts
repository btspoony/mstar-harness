/**
 * Shared catalog-registration derivations, binding writers, pending-journal
 * guards, and recovery operations for journals created before the ACTIVE-only
 * registration cutover. New execution registrations are committed by
 * `commitExecutionRegistration` in `execution-registration.ts`; this module
 * does not create or finish journaled file registrations.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { promotedAuditSnapshot, type AuditWorkflowOptions } from "./audit.js";
import {
  CatalogError,
  catalogRootDir,
  type CatalogEntityInput,
  type CatalogEntityKind,
  type CatalogLinkInput,
  type CatalogRelation,
  type CatalogRootKind,
} from "./catalog.js";
import { isPlainObject } from "./coordination-write.js";
import { assertSafePathComponent } from "./path.js";
import { resolveRegisteredPlanFile } from "./plan-path.js";
import { openStore, type StoreContext, type StoreDb } from "./store-db.js";
import {
  findRegisteredWorkflow,
  rowPlanIds,
  withWorkflowPurgeLocks,
  validateWorkflowEntry,
  type WorkflowEntry,
} from "./status.js";
import {
  assertDeliveryRegistrationCoherence,
  derivePlanRegistration,
  iterationWorkflowSnapshot,
  normalizeIterationCompassRef,
  planWorkflowSnapshot,
  stableJson,
  type RegisterIterationWorkflowOptions,
  type RegisterPlanWorkflowOptions,
  type WorkflowDeliveryKind,
  type WorkflowSnapshot,
} from "./workflow.js";

/** Journal version retained for recovery of records created before cutover. */
export const CATALOG_REGISTRATION_JOURNAL_VERSION = 1;

// ---------------------------------------------------------------------------
// Vocabulary (contract §3)
// ---------------------------------------------------------------------------

/** The three workflow kinds accepted by the ACTIVE execution composer. */
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
 * The workflow intent accepted by the ACTIVE execution composer. Plan and
 * iteration carry their workflow id and producer options; audit carries the
 * selected plan directory and declared workflow options.
 */
export type CatalogExecutionWorkflow =
  | { kind: "plan"; workflowId: string; options: RegisterPlanWorkflowOptions }
  | { kind: "iteration"; workflowId: string; options: RegisterIterationWorkflowOptions }
  | { kind: "audit"; outDir: string; selected: readonly string[]; options: AuditWorkflowOptions };

/**
 * One execution registration: actor, workflow and reviewed catalog delta, plus
 * its replay id and the revision against which the delta was reviewed.
 */
export type CatalogExecutionRequest = {
  /** Stable across retries: reusing it with a different request refuses. */
  operationId: string;
  /** Actor attributed to catalog writes and the execution receipt. */
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
  /** Retained on historical journal receipts; ACTIVE registration returns false. */
  recovered: boolean;
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
  | "catalog.registration-pending"
  | "catalog.reconcile-conflict"
  | "catalog.purge-not-found"
  | "catalog.purge-identity-mismatch"
  | "catalog.purge-binding-present";

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

/** Shape gate over one reviewed request before ACTIVE registration commits it. */
function validateRequest(request: unknown): CatalogExecutionRequest {
  if (!isPlainObject(request)) invalid("a catalog execution request object is required");
  const operationId = requireText(request.operationId, "request.operationId");
  const actor = requireText(request.actor, "request.actor");
  const expectedCatalogRevision = request.expectedCatalogRevision;
  if (typeof expectedCatalogRevision !== "number" || !Number.isSafeInteger(expectedCatalogRevision) || expectedCatalogRevision < 0) {
    invalid("request.expectedCatalogRevision must be the nonnegative catalog revision the delta was reviewed against");
  }
  const workflow = request.workflow;
  if (!isPlainObject(workflow)) invalid("request.workflow is required (kind + workflow options)");

  let validated: CatalogExecutionWorkflow;
  switch (workflow.kind) {
    case "plan": {
      const options = workflow.options;
      if (!isPlainObject(options)) invalid("request.workflow.options (RegisterPlanWorkflowOptions) is required");
      requireAbsoluteDir(options.harnessDir, "request.workflow.options.harnessDir");
      if (!isPlainObject(options.plan)) invalid("request.workflow.options.plan is required (the selected plan document)");
      // `file` is the selected document; an omitted `id`/`title` is derived
      // from it (R1) — the resolved producer call still demands both, so the
      // sparse intent never reaches the snapshot definition undefined.
      requireText((options.plan as Record<string, unknown>).file, "request.workflow.options.plan.file");
      for (const field of ["id", "title"] as const) {
        const value = (options.plan as Record<string, unknown>)[field];
        if (value !== undefined) requireText(value, `request.workflow.options.plan.${field}`);
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
      if (!isPlainObject(options)) invalid("request.workflow.options (AuditWorkflowOptions) is required");
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
        options: options as unknown as AuditWorkflowOptions,
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
 * Canonicalize selected iteration plan and compass pointers before deriving
 * the snapshot or deterministic operation id. Plan and audit inputs are unchanged.
 */
function normalizeIterationWorkflow(workflow: CatalogExecutionWorkflow): CatalogExecutionWorkflow {
  if (!isPlainObject(workflow) || workflow.kind !== "iteration") return workflow;
  const options: unknown = workflow.options;
  if (!isPlainObject(options)) return workflow;
  const rows = options.rows;
  const harnessDir = options.harnessDir;
  const compassRef = options.compassRef;
  if (
    !Array.isArray(rows) ||
    typeof harnessDir !== "string" ||
    !isAbsolute(harnessDir) ||
    typeof compassRef !== "string" ||
    compassRef.trim() === ""
  ) return workflow;
  const normalizedCompassRef = normalizeIterationCompassRef(
    compassRef,
    harnessDir,
    (detail) => new CatalogRegistrationError("catalog.registration-invalid", detail),
  );
  let changed = normalizedCompassRef !== compassRef;
  const resolvedRows = rows.map((row) => {
    if (!isPlainObject(row)) return row;
    const id = row.id;
    const file = row.file;
    if (typeof id !== "string" || id.trim() === "" || typeof file !== "string" || file.trim() === "") return row;
    const planPath = resolveRegisteredPlanFile({ harnessRoot: harnessDir, planId: id, file }).planPath;
    if (planPath === file) return row;
    changed = true;
    return { ...row, file: planPath };
  });
  if (!changed) return workflow;
  return {
    ...workflow,
    options: { ...options, compassRef: normalizedCompassRef, rows: resolvedRows },
  } as unknown as CatalogExecutionWorkflow;
}

function normalizeIterationPlanPaths(request: CatalogExecutionRequest): CatalogExecutionRequest {
  if (!isPlainObject(request)) return request;
  const workflow = request.workflow;
  if (!isPlainObject(workflow) || workflow.kind !== "iteration") return request;
  const normalized = normalizeIterationWorkflow(workflow);
  if (normalized === workflow) return request;
  return { ...request, workflow: normalized };
}

/**
 * The shared per-kind coherence rule the producers enforce (contract §1): the
 * delivery kind is declared, never inferred, and `development` /
 * `verification/report-only` carry their required evidence. Applied here so an
 * incomplete declaration refuses before the ACTIVE transaction begins.
 */
function assertDeliveryRegistrationFor(options: Record<string, unknown>, kind: "plan" | "audit", at: string): void {
  const deliveryKind = options.deliveryKind;
  if (typeof deliveryKind !== "string" || (deliveryKind !== "development" && deliveryKind !== "verification/report-only")) {
    invalid(`${at}.options.deliveryKind must be development | verification/report-only \u2014 got ${JSON.stringify(deliveryKind)}`);
  }
  try {
    assertDeliveryRegistrationCoherence(deliveryKind as WorkflowDeliveryKind, options, "workflow registration");
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
// The pure execution derivation shared by the ACTIVE composer and commit.

export type CatalogExecutionPlan = {
  kind: CatalogExecutionKind;
  workflowId: string;
  harnessDir: string;
  /** In-memory snapshot to commit together with the catalog delta. */
  snapshot: WorkflowSnapshot;
  request: CatalogExecutionRequest;
};

function executionPlanFor(context: StoreContext, request: CatalogExecutionRequest): CatalogExecutionPlan {
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
    snapshot,
    request,
  };
}

/**
 * Validate and canonicalize one shipped workflow request, derive its in-memory
 * snapshot, and check catalog destinations against their declared roots. This
 * pure derivation leaves the ACTIVE registration composer to commit the result.
 */
export function resolveCatalogExecutionPlan(context: StoreContext, request: unknown): CatalogExecutionPlan {
  return executionPlanFor(context, validateRequest(normalizeIterationPlanPaths(request as CatalogExecutionRequest)));
}

/**
 * The root `WorkflowEntry` this ACTIVE transaction derives from its in-memory
 * snapshot. It is validated before creation and never writes a file.
 */
export function workflowEntryOf(plan: CatalogExecutionPlan, snapshot: WorkflowSnapshot): WorkflowEntry {
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
  return entry;
}

/**
 * The binding write's input: the workflow's catalog identity as the delta
 * published it, pinned with the ACTIVE registration transaction.
 */
export type CatalogExecutionBindingInput = {
  kind: CatalogEntityKind;
  id: string;
  rootKind: CatalogRootKind;
  relativePath: string;
  documentKind: string | null;
  sourceHash: string | null;
};

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

const JOURNAL_COLUMNS =
  "operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at";

function nowRfc3339(): string {
  return new Date().toISOString();
}


/**
 * One short connection and one short `BEGIN IMMEDIATE` transaction (contract
 * §2). The connection is opened in `write` mode even for reads: this module is
 * a writer, and the read-only open path adds nothing (P2 recorded a
 * long-lived-process read-open flake on an idle store).
 */
async function withJournalWrite<T>(context: StoreContext, fn: (db: StoreDb) => T | Promise<T>): Promise<T> {
  const handle = await openStore(context, "write");
  try {
    assertStoreActive(handle.db);
    handle.db.exec("begin immediate");
    try {
      const result = await fn(handle.db);
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
    throw new CatalogError("store.not-active", "store_meta is missing; the store cannot accept an execution registration. Run mstar store upgrade --operator <name> (one-command minimal activation) or mstar store activate --manifest <migration.json> --attestation <file.json>, then retry.");
  }
  if (row.authority_state !== "active") {
    throw new CatalogError(
      "store.not-active",
      `The catalog store is ${row.authority_state}; registering an execution publishes catalog rows and therefore requires an active store. Run mstar store upgrade --operator <name> (one-command minimal activation) or mstar store activate --manifest <migration.json> --attestation <file.json>, then retry.`,
    );
  }
}

function readJournalVersions(db: StoreDb): { storeRevision: number; catalogRevision: number } {
  const row = db.prepare("select revision, catalog_revision from store_meta where id = 1").get() as
    | { revision?: unknown; catalog_revision?: unknown }
    | undefined;
  if (!row || typeof row.revision !== "number" || typeof row.catalog_revision !== "number") {
    throw new CatalogError("store.not-active", "store_meta is missing; the store cannot accept an execution registration. Run mstar store upgrade --operator <name> (one-command minimal activation) or mstar store activate --manifest <migration.json> --attestation <file.json>, then retry.");
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
 * The non-committed legacy journal row for one workflow, read by the ACTIVE
 * registration guard and recovery surface. `execution-written` is reported as
 * itself and every other non-committed row as `prepared`; committed or aborted
 * rows are not pending.
 */
export function pendingRegistrationOf(
  db: StoreDb,
  workflowId: string,
): { operationId: string; phase: "prepared" | "execution-written" } | null {
  const row = pendingRows(db).find((candidate) => parseJournalWorkflowId(candidate) === workflowId);
  if (row === undefined) return null;
  return { operationId: row.operation_id, phase: row.phase === "execution-written" ? "execution-written" : "prepared" };
}

function recordAborted(db: StoreDb, operationId: string, reason: string): void {
  db.prepare("update catalog_operations set phase = 'aborted', result_json = ?, updated_at = ? where operation_id = ?").run(
    JSON.stringify({ aborted: true, reason }),
    nowRfc3339(),
    operationId,
  );
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

/**
 * The frozen input the binding records: the workflow's own catalog identity as
 * this operation published it (id, location, revision, body hash). It is
 * history + the pin P4's prepare readers consume (`catalog_pin`), never an
 * execution status copy.
 */
export function bindingInputOf(plan: CatalogExecutionPlan): CatalogExecutionBindingInput {
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

/**
 * The committed `catalog_execution_bindings` row records the workflow's
 * association against the revision the ACTIVE transaction published. A
 * different operation cannot replace an existing binding.
 */
export function writeBinding(
  db: StoreDb,
  plan: CatalogExecutionPlan,
  bindingInput: CatalogExecutionBindingInput,
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
          `by operation ${JSON.stringify(String(row.operation_id))}; this operation cannot replace that binding. Inspect the existing workflow and catalog binding, and use a new workflow id for a distinct registration.`,
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


/** What an explicit abort reports. */
export type CatalogExecutionAbort = {
  operationId: string;
  workflowId: string;
  phase: "aborted";
};

/**
 * Abandon a legacy pending registration that wrote no execution bytes. Records
 * with a snapshot or root entry refuse; use the identity-checked
 * `mstar catalog purge-registration` recovery for a recorded failed snapshot.
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
        "leave a half-registered workflow \u2014 settle it with identity-checked purge or handle it through its existing lifecycle",
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
 * The ONE refusal a pending registration produces, verbatim for the dispatch
 * gate, the handle-taking gate and the active DB registration route.
 */
export function refusePendingRegistration(
  workflowId: string,
  pending: { operationId: string; phase: "prepared" | "execution-written" },
): never {
  throw new CatalogRegistrationError(
    "catalog.registration-pending",
    `workflow ${JSON.stringify(workflowId)} is root-visible but its catalog registration is ${pending.phase}, not committed ` +
      `(operation ${JSON.stringify(pending.operationId)}); registration must refuse until the legacy journal is settled. ` +
      `Use "mstar catalog reconcile --abort" for an unwritten journal, or "mstar catalog purge-registration" for its recorded failed snapshot.`,
  );
}

/**
 * The registration gate for an ACTIVE execution transaction through its own
 * handle: registry visibility and pending catalog operations are read from the
 * same store.db under the caller's lock. A registered workflow whose catalog
 * operation is not committed refuses `catalog.registration-pending`; no file
 * registration route is consulted.
 * The pending verdict stays defined once, by `pendingRegistrationOf`.
 *
 * Store-state tolerances stay with the handle owner: a missing store never gets
 * here (the opener refuses `store.not-initialized`), and a `store_meta` that is
 * not ACTIVE keeps the pre-activation exclusion (§7) — a staged store is not a
 * catalog verdict, so it passes through and is never retro-refused here.
 */
export function assertCatalogExecutionCommittedOn(db: StoreDb, workflowId: string): void {
  const id = requireText(workflowId, "workflowId");
  const meta = db.prepare("select authority_state from store_meta where id = 1").get() as
    | { authority_state?: unknown }
    | undefined;
  if (meta?.authority_state !== "active") return;
  if (db.prepare("select workflow_id from execution_registry where workflow_id = ?").get(id) === undefined) return;
  const pending = pendingRegistrationOf(db, id);
  if (pending === null) return;
  refusePendingRegistration(id, pending);
}

/**
 * Async handle-taking gate. Its remaining callers are OUTSIDE this change's
 * Files list — `coordination.ts:871` (the retained prepare/bind registration
 * gate) and `packages/dsh/src/gates/workflow-selection.ts:869` — so the wrapper
 * and those callers are handed to T21 with the terminal veto sweep rather than
 * cut here (T6 owns only this module's own fixtures).
 */
// T21: coordination.ts prepare/bind gate + dsh workflow-selection gate still call this wrapper.
export async function assertCatalogExecutionCommitted(context: StoreContext, workflowId: string): Promise<void> {
  const handle = await openStore(context, "read");
  try {
    assertCatalogExecutionCommittedOn(handle.db, workflowId);
  } finally {
    handle.close();
  }
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

export type PurgeCatalogRegistrationReceipt = {
  workflowId: string;
  purgedDigest: string;
  actor: string;
  timestamp: string;
};

/** Purge only the exact producer-written bytes recorded at the identity refusal. */
export async function purgeCatalogRegistration(
  context: StoreContext,
  input: {
    workflowId: string;
    operationId: string;
    expectedCatalogRevision: number;
    actor: string;
    testHooks?: {
      afterEligibility?: () => Promise<void>;
      beforeRootAbsentSnapshotLock?: () => void;
    };
  },
): Promise<PurgeCatalogRegistrationReceipt> {
  const workflowId = requireText(input.workflowId, "workflowId");
  const operationId = requireText(input.operationId, "operationId");
  const actor = requireText(input.actor, "actor");
  const recorded = await withJournalWrite(context, (db) => {
    const row = readRow(db, operationId);
    if (row === undefined || parseJournalWorkflowId(row) !== workflowId) {
      throw new CatalogRegistrationError("catalog.purge-not-found", `no failed registration record exists for workflow ${JSON.stringify(workflowId)}`);
    }
    if (readJournalVersions(db).catalogRevision !== input.expectedCatalogRevision) {
      throw new CatalogError("catalog.revision-conflict", `expected catalog revision ${input.expectedCatalogRevision}; current revision differs`);
    }
    let after: unknown;
    try { after = JSON.parse(row.after_versions_json); } catch { after = undefined; }
    const failure = isPlainObject(after) ? after.failure : undefined;
    if (!isPlainObject(failure) ||
      failure.workflow_id !== workflowId ||
      typeof failure.snapshot_path !== "string" ||
      typeof failure.snapshot_content_sha256 !== "string" ||
      typeof failure.reviewed_identity !== "string") {
      throw new CatalogRegistrationError("catalog.purge-not-found", `operation ${JSON.stringify(operationId)} has no identity-failure record for this workflow`);
    }
    const binding = db.prepare("select workflow_id from catalog_execution_bindings where workflow_id = ?").get(workflowId);
    if (binding !== undefined) throw new CatalogRegistrationError("catalog.purge-binding-present", `workflow ${JSON.stringify(workflowId)} has a catalog binding`);
    return {
      snapshotPath: failure.snapshot_path,
      recordedDigest: failure.snapshot_content_sha256,
    };
  });
  const timestamp = nowRfc3339();
  return await withWorkflowPurgeLocks(
    join(context.harnessDir, "status.json"),
    workflowId,
    recorded.snapshotPath,
    async (_snapshot, rootPresent, removeRoot) => await withJournalWrite(context, async (db) => {
      const row = readRow(db, operationId);
      if (row === undefined || parseJournalWorkflowId(row) !== workflowId) {
        throw new CatalogRegistrationError("catalog.purge-not-found", `failed registration record disappeared for ${JSON.stringify(workflowId)}`);
      }
      const current = readJournalVersions(db).catalogRevision;
      if (current !== input.expectedCatalogRevision) {
        throw new CatalogError(
          "catalog.revision-conflict",
          `expected catalog revision ${input.expectedCatalogRevision}; current revision is ${current}`,
        );
      }
      let after: unknown;
      try { after = JSON.parse(row.after_versions_json); } catch { after = undefined; }
      const failure = isPlainObject(after) ? after.failure : undefined;
      if (!isPlainObject(failure) ||
        failure.workflow_id !== workflowId ||
        failure.snapshot_path !== recorded.snapshotPath ||
        // hash-gate: authorized — digest mismatch prevents purging an altered snapshot.
        failure.snapshot_content_sha256 !== recorded.recordedDigest ||
        typeof failure.reviewed_identity !== "string") {
        throw new CatalogRegistrationError("catalog.purge-not-found", `operation ${JSON.stringify(operationId)} has no matching identity-failure record`);
      }
      const binding = db.prepare("select workflow_id from catalog_execution_bindings where workflow_id = ?").get(workflowId);
      if (binding !== undefined) throw new CatalogRegistrationError("catalog.purge-binding-present", `workflow ${JSON.stringify(workflowId)} has a catalog binding`);
      if (rootPresent && !existsSync(recorded.snapshotPath)) {
        throw new CatalogRegistrationError("catalog.purge-identity-mismatch", "snapshot is missing while its root entry is still registered");
      }
      if (existsSync(recorded.snapshotPath)) {
        const observedDigest = createHash("sha256").update(readFileSync(recorded.snapshotPath)).digest("hex");
        // hash-gate: authorized — digest mismatch blocks deletion of a wrong snapshot.
        if (observedDigest !== recorded.recordedDigest) {
          throw new CatalogRegistrationError(
            "catalog.purge-identity-mismatch",
            `snapshot digest changed (observed ${observedDigest}, recorded ${recorded.recordedDigest}); human disposition required`,
          );
        }
      }
      await input.testHooks?.afterEligibility?.();
      await removeRoot();
      rmSync(recorded.snapshotPath, { force: true });
      const receipt: PurgeCatalogRegistrationReceipt = {
        workflowId,
        purgedDigest: recorded.recordedDigest,
        actor,
        timestamp,
      };
      db.prepare("update catalog_operations set phase = 'aborted', result_json = ?, updated_at = ? where operation_id = ?")
        .run(JSON.stringify(receipt), timestamp, operationId);
      return receipt;
    }),
    { beforeRootAbsentSnapshotLock: input.testHooks?.beforeRootAbsentSnapshotLock },
  );
}
