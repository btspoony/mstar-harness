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
 * - writes NO JSON registration file — not a snapshot, not a root entry, not a
 *   session envelope. The DB is the execution authority in active mode, and the
 *   `execution.direct-write-refused` guards on the file writers are the fence
 *   behind that promise, not the promise itself;
 * - generates NO `prepared` / `execution-written` phase. Those phases exist to
 *   describe a half-finished FILE registration; in DB mode nothing is ever
 *   half-finished, and an operation that refuses leaves no trace at all;
 * - NEVER adopts pending file work. A legacy `catalog_operations` row that is
 *   still `prepared` / `execution-written` refuses through the SAME verdict the
 *   legacy gate uses (`pendingRegistrationOf` + `refusePendingRegistration`),
 *   because adopting it here would mean trusting file-protocol state — a
 *   snapshot and a root entry this transaction did not write — as this store's
 *   registration;
 * - is idempotent by operation id: an identical retry returns the RECORDED
 *   receipt without re-evaluating the CAS the first attempt advanced, and a
 *   reused id with any other payload refuses `execution.operation-conflict`.
 *
 * Both halves of the request are consumed through the SAME derivations as the
 * legacy route (`resolveCatalogExecutionPlan`, `workflowEntryOf`, the catalog
 * domain's own handle-taking verbs), so "what this registration is" is defined
 * once and the two routes cannot drift into disagreeing about identity, the
 * reviewed delta, or the frozen catalog binding.
 */
import { createHash } from "node:crypto";
import {
  CatalogError,
  linkCatalogEntitiesOn,
  readCatalogStoreVersionsOn,
  registerCatalogEntityOn,
} from "./catalog.js";
import {
  bindingInputOf,
  pendingRegistrationOf,
  refusePendingRegistration,
  resolveCatalogExecutionPlan,
  workflowEntryOf,
  writeBinding,
  type CatalogExecutionReceipt,
  type CatalogExecutionRequest,
} from "./catalog-registration.js";
import {
  ExecutionError,
  assertExecutionToken,
  executionRootTokenOf,
  readOperationReplay,
  resolveCreateWorkflow,
  withExecutionTransaction,
  writeExecutionCreation,
  writeOperationReceipt,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionToken,
} from "./execution-store.js";
import { stableJson } from "./workflow.js";

/** §3.1: the operation kind this verb hashes its request under. */
const COMMIT_REGISTRATION_OPERATION = "commitExecutionRegistration";

/**
 * §3.1 the registration's request hash: operation kind, the exact root CAS, the
 * trusted caller and the whole reviewed request (producer call, catalog delta,
 * actor, catalog expectation), in the stable canonical form the legacy journal
 * hashes its own request with. Two requests sharing an operation id collide only
 * when they are the same request — anything else is an idempotency-key misuse
 * and refuses instead of replaying a foreign receipt.
 */
function registrationRequestHash(
  caller: ExecutionCaller,
  workflowId: string,
  request: CatalogExecutionRequest,
  expected: ExecutionToken,
): string {
  return createHash("sha256")
    .update(
      stableJson({
        operation: COMMIT_REGISTRATION_OPERATION,
        workflow_id: workflowId,
        expected,
        caller: {
          session_id: caller.sessionId,
          role: caller.role,
          workflow_id: caller.workflowId,
          plan_id: caller.planId,
        },
        request,
      }),
      "utf8",
    )
    .digest("hex");
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
 * Refusals, in the order they are evaluated:
 *
 * - `execution.not-active` — the execution authority is not active (a legacy or
 *   staged store, or a store predating the execution schema keeps the file
 *   route);
 * - `execution.operation-conflict` — this operation id is already committed for
 *   a different request;
 * - `execution.token-kind` / `execution.scope-mismatch` / `store.stale-epoch` /
 *   `execution.stale-token` — `expected` is not this store's CURRENT root token;
 * - `catalog.revision-conflict` — the catalog moved past the revision the delta
 *   was reviewed against (nothing was published);
 * - `catalog.registration-pending` — a legacy registration operation for this
 *   workflow is still `prepared` / `execution-written`: it must be settled on
 *   the file route first, never adopted or overwritten here;
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
  const requestHash = registrationRequestHash(context.caller, plan.workflowId, plan.request, request.expected);

  return withExecutionTransaction(context, (tx) => {
    if (tx.execution.authorityState !== "active") {
      throw new ExecutionError(
        "execution.not-active",
        `the execution authority is ${tx.execution.authorityState}; the DB registration route requires an active authority. ` +
          `A legacy or staged store registers through the file journal until activation.`,
      );
    }
    // Idempotent replay first: the identical retry must not be judged by a CAS
    // its own first attempt already advanced.
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

    // §7 a legacy operation that is still in flight is settled on the file route
    // BEFORE this store can register anything; the DB route never adopts the
    // file protocol's partial state.
    const pending = pendingRegistrationOf(tx.db, plan.workflowId);
    if (pending !== null) refusePendingRegistration(plan.workflowId, pending);

    const now = new Date().toISOString();
    writeExecutionCreation(tx, { caller: context.caller, creation, now });

    for (const [index, entity] of plan.request.delta.entities.entries()) {
      registerCatalogEntityOn(tx.db, context, entity, {
        operationId: `${operationId}:entity:${index}`,
        actor: plan.request.actor,
      });
    }
    for (const [index, link] of (plan.request.delta.links ?? []).entries()) {
      linkCatalogEntitiesOn(tx.db, context, link, {
        operationId: `${operationId}:link:${index}`,
        actor: plan.request.actor,
      });
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
      // The DB route has no orphan-file recovery and no pending adoption: this
      // call created exactly the lifecycle the review describes.
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
