/**
 * execution-registration.ts — the ACTIVE registration route: the ONE verb that
 * publishes a reviewed catalog delta together with the execution lifecycle it
 * registers, on the DB authority (primary spec §7).
 *
 * Why this file exists next to `catalog-registration.ts`: SQLite cannot commit a
 * filesystem JSON write, so the pre-activation route is an ordered, recoverable
 * journal (`prepared` → `execution-written` → `committed`) whose intermediate
 * states are visible to every reader. The DB route has no such constraint: the
 * workflow header, its registry membership, its plan rows and sealed inputs, the
 * catalog delta and the committed receipt are all rows in one database, so they
 * commit in ONE `BEGIN IMMEDIATE` transaction and there is no window in which
 * either half is visible alone.
 *
 * Therefore this verb:
 *
 * - writes NO JSON registration file; ACTIVE execution authority is the store;
 * - records no journal phases. A transaction either commits the lifecycle and
 *   catalog delta together or leaves no partial ACTIVE registration;
 * - NEVER adopts legacy journal work. A `prepared` / `execution-written` row
 *   refuses through `pendingRegistrationOf` + `refusePendingRegistration`;
 *   recovery is explicit `catalog reconcile --abort` or identity-checked
 *   `catalog purge-registration`, never file-effect adoption;
 * - is idempotent by operation id SEMANTICALLY: a retry of the same reviewed
 *   intent returns the RECORDED receipt without re-evaluating the CAS the first
 *   attempt advanced and without re-reading the catalog revision, even when the
 *   caller re-read the store and re-presented fresh tokens after a lost response
 *   (see `REGISTRATION_SEMANTICS`), while a reused id for any other producer call
 *   or delta refuses `execution.operation-conflict`.
 *
 * Both halves of the request are consumed through the SAME derivations as the
 * legacy route (`resolveCatalogExecutionPlan`, `workflowEntryOf`, the catalog
 * domain's own handle-taking verbs), so "what this registration is" is defined
 * once and the two routes cannot drift into disagreeing about identity, the
 * reviewed delta, or the frozen catalog binding.
 */
import {
  CatalogError,
  linkCatalogEntitiesOn,
  readCatalogStoreVersionsOn,
  registerCatalogEntityOn,
  type ComposedStoreRevision,
} from "./catalog.js";
import {
  bindingInputOf,
  pendingRegistrationOf,
  refusePendingRegistration,
  resolveCatalogExecutionPlan,
  workflowEntryOf,
  writeBinding,
  CatalogRegistrationError,
  type CatalogExecutionCatalogDelta,
  type CatalogExecutionPlan,
  type CatalogExecutionReceipt,
  type CatalogExecutionRequest,
  type CatalogExecutionWorkflow,
} from "./catalog-registration.js";
import { isPlainObject } from "./coordination-write.js";
import {
  ExecutionError,
  assertExecutionToken,
  executionRootTokenOf,
  readOperationReplay,
  resolveCreateWorkflow,
  semanticRequestHash,
  withExecutionTransaction,
  writeExecutionCreation,
  writeOperationReceipt,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionToken,
} from "./execution-store.js";
import { selectSemanticFields, type SemanticSelection } from "./recovery-intent.js";
import { createHash } from "node:crypto";
import { promotedAuditPlanRows } from "./audit.js";
import { derivePlanRegistration, stableJson } from "./workflow.js";

/** §3.1: the operation kind this verb hashes its request under. */
const COMMIT_REGISTRATION_OPERATION = "commitExecutionRegistration";

/**
 * §4.2 the semantic selection of one registration intent: the reviewed workflow,
 * catalog delta and actor attributed to every published row.
 *
 * `operationId` is the replay address; root and catalog expectations are
 * checked constraints rather than business intent. The fingerprint therefore
 * remains actor + canonical workflow + catalog delta. Retries with that same
 * intent replay; a changed intent conflicts (A13).
 */
const REGISTRATION_SEMANTICS: SemanticSelection = ["actor", "workflow", "delta"];

/**
 * §3.1/§4.2 the canonical envelope of one semantic selection. E01's published
 * rule for a selected path is "a path that is absent or `undefined` contributes
 * nothing; a path present with any other value — `null` included — is part of
 * the selection"; this applies that rule at every depth of the whole-subtree
 * paths this verb selects.
 *
 * It matters on the sparse route: a transport that builds the producer call
 * field-by-field from optional inputs (`plan.id`/`plan.title`) may pass an
 * explicit `undefined`, and `derivePlanRegistration` derives exactly that field.
 * Without this step the same omission would be ACCEPTED by the derivation and
 * REFUSED by the fingerprint as `execution.canonical-value`, i.e. one route
 * answering one intent two ways. A non-plain object and an `undefined` ARRAY
 * element are left exactly as they are, so a class instance, a `Date` or a hole
 * in the reviewed delta still refuses as a non-canonical value instead of being
 * silently rewritten into a different request.
 */
function canonicalIntent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalIntent);
  if (!isPlainObject(value)) return value;
  const envelope: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) envelope[key] = canonicalIntent(entry);
  }
  return envelope;
}

/**
 * §3.1/§4.2 the registration's request fingerprint: the operation kind, the
 * workflow it registers, the trusted caller and the reviewed selection above, in
 * the DB authority's own canonical form (`semanticRequestHash`). One fingerprint
 * definition for the frames, so "the same intent" means one thing on this store.
 */
function registrationRequestHash(caller: ExecutionCaller, plan: CatalogExecutionPlan): string {
  return semanticRequestHash({
    operation: COMMIT_REGISTRATION_OPERATION,
    address: { workflow_id: plan.workflowId },
    caller,
    intent: selectSemanticFields(canonicalIntent(plan.request), REGISTRATION_SEMANTICS),
  });
}

/**
 * §7 register one execution lifecycle together with its reviewed catalog delta,
 * atomically, on an ACTIVE execution authority.
 *
 * ONE transaction publishes all of it: the workflow header, its registry
 * membership, its plan rows, their sealed frozen inputs, every reviewed catalog
 * entity and relation, the workflow's committed catalog binding, and the
 * operation receipt. A failure anywhere — a catalog domain refusal, a foreign
 * identity, a `SQLITE_BUSY` timeout, a process crash — rolls back the whole
 * thing, so neither the catalog nor the execution lifecycle is ever visible
 * without the other, and nothing reports success for a half-written
 * registration.
 *
 * §3.1 the accepted multi-domain transaction advances the SHARED
 * `store_meta.revision` exactly once, however many catalog rows the delta
 * publishes: the catalog rows join the transaction's single advance and the
 * catalog revision advances once per published row. A retry of the same reviewed
 * intent advances none of them and returns its recorded receipt.
 *
 * Refusals, in the order they are evaluated:
 *
 * - `execution.not-active` — the execution authority is not active;
 * - `execution.operation-conflict` — this operation id is already committed for
 *   a different reviewed intent (another producer call, delta or actor);
 * - `execution.token-kind` / `execution.scope-mismatch` / `store.stale-epoch` /
 *   `execution.stale-token` — `expected` is not this store's CURRENT root token;
 * - `catalog.revision-conflict` — the catalog moved past the revision the delta
 *   was reviewed against (nothing was published);
 * - `catalog.registration-pending` — a legacy journal is still prepared or
 *   execution-written; settle it through abort/purge recovery before retrying;
 * - `execution.not-empty` — the workflow identity already exists (a lifecycle is
 *   create-only), or the supplied snapshot already carries a binding, a lease or
 *   delivery evidence;
 * - `coordination.invalid-input` / `coordination.*` — the producer call or the
 *   caller's scope does not describe a new lifecycle;
 * - the catalog domain's own refusals at publish (`catalog.duplicate`,
 *   `catalog.path-refused`, `catalog.link-refused`, `store.operation-conflict`)
 *   and `catalog.registration-invalid` for a malformed request or delta.
 */
export async function commitExecutionRegistration(
  context: ExecutionContext,
  request: CatalogExecutionRequest & { expected: ExecutionToken },
): Promise<CatalogExecutionReceipt> {
  const plan = resolveCatalogExecutionPlan(context, request);
  const operationId = plan.request.operationId;
  // The entry/snapshot pair the review describes, resolved before the
  // transaction: the identity anchors, the new/unbound/unleased requirement and
  // the plan rows' own seals are the C3 creation gates, reused verbatim.
  const creation = resolveCreateWorkflow(context.caller, workflowEntryOf(plan, plan.snapshot), plan.snapshot, operationId);
  const requestHash = registrationRequestHash(context.caller, plan);

  return withExecutionTransaction(context, (tx) => {
    if (tx.execution.authorityState !== "active") {
      throw new ExecutionError(
        "execution.not-active",
        `state: ${tx.execution.authorityState}; registration requires the active execution authority. ` +
          `Upgrade required: mstar store upgrade --operator <name>.`,
      );
    }
    // §4.1 semantic replay first: the retry of the same reviewed intent must not
    // be judged by a CAS — or a catalog expectation — its own first attempt
    // already advanced, whatever tokens the caller re-read after the lost
    // response. Only the CURRENT epoch's committed receipt replays, so an
    // authority that changed generation under this call is re-resolved instead
    // of being served (or written to) under a generation that no longer exists.
    const replayed = readOperationReplay<CatalogExecutionReceipt>(tx, {
      operationId,
      requestHash,
      workflowId: plan.workflowId,
      planId: null,
      token: { kind: "root", key: [] },
    });
    if (replayed !== null) return replayed.data;

    // §3.1 CAS: the parent (root) token of THIS store, epoch and revision.
    assertExecutionToken(request.expected, {
      kind: "root",
      storeId: tx.storeId,
      epoch: tx.epoch,
      key: [],
      revision: tx.execution.revision,
    });

    // §7 the reviewed catalog expectation, read on THIS transaction's handle so
    // no concurrent catalog write can move it between this check and the
    // publish below.
    const versions = readCatalogStoreVersionsOn(tx.db);
    if (versions.catalogRevision !== plan.request.expectedCatalogRevision) {
      throw new CatalogError(
        "catalog.revision-conflict",
        `the reviewed delta expects catalog revision ${plan.request.expectedCatalogRevision}, but the store is at ` +
          `${versions.catalogRevision}; nothing was registered.`,
      );
    }

    // A legacy operation still in flight must be settled explicitly before this
    // ACTIVE transaction can register; it never adopts legacy journal state.
    const pending = pendingRegistrationOf(tx.db, plan.workflowId);
    if (pending !== null) refusePendingRegistration(plan.workflowId, pending);

    const now = new Date().toISOString();
    writeExecutionCreation(tx, { caller: context.caller, creation, now });
    // §3.1 the ONE shared store revision this accepted multi-domain transaction
    // advances has already run inside the creation write above, so each reviewed
    // catalog row JOINS it: the delta's row count never moves
    // `store_meta.revision`, while the catalog revision keeps advancing once per
    // published row (that counter is the catalog domain's own).
    const composed: ComposedStoreRevision = { committedStoreRevision: readCatalogStoreVersionsOn(tx.db).storeRevision };

    for (const [index, entity] of plan.request.delta.entities.entries()) {
      registerCatalogEntityOn(
        tx.db,
        context,
        entity,
        {
          operationId: `${operationId}:entity:${index}`,
          actor: plan.request.actor,
        },
        composed,
      );
    }
    for (const [index, link] of (plan.request.delta.links ?? []).entries()) {
      linkCatalogEntitiesOn(
        tx.db,
        context,
        link,
        {
          operationId: `${operationId}:link:${index}`,
          actor: plan.request.actor,
        },
        composed,
      );
    }

    // The binding is written against the revision the delta just published: it
    // is registration history plus the pin the plan readers consume, never a
    // pointer that a later catalog edit may move.
    const published = readCatalogStoreVersionsOn(tx.db);
    writeBinding(tx.db, plan, bindingInputOf(plan), published.catalogRevision);

    const receipt: CatalogExecutionReceipt = {
      operationId,
      workflowId: plan.workflowId,
      catalogRevision: published.catalogRevision,
      // ACTIVE creation and catalog publication committed in this transaction.
      recovered: false,
    };
    writeOperationReceipt(tx, {
      operationId,
      requestHash,
      workflowId: plan.workflowId,
      planId: null,
      now,
      receipt: { data: receipt, token: executionRootTokenOf(tx), storeId: tx.storeId, epoch: tx.epoch },
    });
    return receipt;
  });
}

/**
 * Derive the catalog delta from the ACTIVE workflow intent: plan and iteration
 * entities follow their workflow options; audit entities follow selected plan
 * documents, whose bodies supply the titles. The binding follows the workflow's
 * primary association.
 */
function catalogDeltaFor(workflow: CatalogExecutionWorkflow): CatalogExecutionCatalogDelta {
  if (workflow.kind === "plan") {
    // The plan entity's identity, title and catalog LOCATION are derived from
    // the selected document (R1) through the same derivation the snapshot row
    // uses: the reviewed delta states the catalog spelling (plans-root-relative)
    // while the registered row keeps the §4 canonical pointer, and the two can
    // never disagree about which document this registration is.
    const selected = derivePlanRegistration({ harnessDir: workflow.options.harnessDir, plan: workflow.options.plan });
    return {
      entities: [
        {
          kind: "plan",
          id: selected.plan.id,
          title: selected.plan.title,
          rootKind: "plans",
          relativePath: selected.catalogRelativePath,
        },
      ],
      binding: { catalogKind: "plan", catalogId: selected.plan.id },
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
    throw new CatalogRegistrationError(
      "catalog.registration-invalid",
      "an audit promotion selects no plan rows; there is no catalog delta to register",
    );
  }
  const entities: CatalogExecutionCatalogDelta["entities"] = [];
  for (const row of rows) {
    if (typeof row.id !== "string" || typeof row.title !== "string" || typeof row.file !== "string") {
      throw new CatalogRegistrationError("catalog.registration-invalid", "an audit plan row is missing its catalog identity or path");
    }
    entities.push({ kind: "plan", id: row.id, title: row.title, rootKind: "plans", relativePath: row.file });
  }
  return {
    entities,
    binding: { catalogKind: "plan", catalogId: entities[0]!.id },
  };
}
/**
 * Register a shipped workflow on the ACTIVE store. Expectations are read from
 * one transaction so the root token and catalog revision describe one snapshot;
 * commitExecutionRegistration rechecks both under its own atomic write.
 */
export async function registerShippedCatalogExecution(
  context: ExecutionContext,
  input: {
    actor: string;
    workflow: CatalogExecutionWorkflow;
    operationId?: string;
    expected?: ExecutionToken;
    expectedCatalogRevision?: number;
  },
): Promise<CatalogExecutionReceipt> {
  const initialDelta = catalogDeltaFor(input.workflow);
  const canonical = resolveCatalogExecutionPlan(context, {
    actor: input.actor,
    operationId: input.operationId ?? "request-derived",
    expectedCatalogRevision: 0,
    workflow: input.workflow,
    delta: initialDelta,
  });
  const workflow = canonical.request.workflow;
  const delta = catalogDeltaFor(workflow);
  const intent = { actor: input.actor, workflow, delta };
  const operationId =
    input.operationId ?? `op-${createHash("sha256").update(stableJson(intent), "utf8").digest("hex").slice(0, 24)}`;
  const request: CatalogExecutionRequest = {
    ...intent,
    operationId,
    expectedCatalogRevision: 0,
  };
  const read = await withExecutionTransaction(context, (tx) => {
    const versions = readCatalogStoreVersionsOn(tx.db);
    const expected = executionRootTokenOf(tx);
    if (input.expected !== undefined) {
      assertExecutionToken(input.expected, {
        kind: "root",
        storeId: tx.storeId,
        epoch: tx.epoch,
        key: [],
        revision: tx.execution.revision,
      });
      if (input.expected !== expected) {
        throw new ExecutionError("execution.stale-token", "the supplied root expectation is not the current execution token");
      }
    }
    if (input.expectedCatalogRevision !== undefined && input.expectedCatalogRevision !== versions.catalogRevision) {
      throw new CatalogError(
        "catalog.revision-conflict",
        `the supplied catalog expectation is ${input.expectedCatalogRevision}, but the store is at ${versions.catalogRevision}`,
      );
    }
    return { expected, catalogRevision: versions.catalogRevision };
  });
  request.expectedCatalogRevision = read.catalogRevision;
  return commitExecutionRegistration(context, { ...request, expected: read.expected });
}
