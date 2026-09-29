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
  type CatalogExecutionPlan,
  type CatalogExecutionReceipt,
  type CatalogExecutionRequest,
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

/** §3.1: the operation kind this verb hashes its request under. */
const COMMIT_REGISTRATION_OPERATION = "commitExecutionRegistration";

/**
 * §4.2 the SEMANTIC selection of one registration intent: the reviewed producer
 * call, the reviewed catalog delta and the actor every published row is
 * attributed to — the facts that make "which registration is this" true.
 *
 * Deliberately NOT selected: `operationId` is the idempotency key the receipt is
 * looked up BY, `expected` is the root CAS the caller happened to have read, and
 * `expectedCatalogRevision` is the catalog freshness the delta was reviewed
 * against. A repeat after a lost response is the same intent even when the
 * caller re-read the store and re-presented both tokens (design §4.2/R6/R7), so
 * the fingerprint must not move with them — the same rule E06a applies to the
 * file route's own journal fingerprint, where the reviewed expectation stays in
 * the journal payload and is enforced at reconcile instead of being hashed as
 * intent. A different producer call or delta still moves the fingerprint and
 * stays an operation conflict (A13).
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
 * catalog revision advances once per published row, as it does on the file
 * route. A retry of the same reviewed intent advances none of them, and
 * re-evaluates neither this store's CAS nor the catalog expectation the first
 * attempt already consumed — it returns the receipt the committed transaction
 * recorded (A05/A28: an interruption before this call committed leaves nothing,
 * and an interruption after it committed converges on that one recorded
 * registration, never on a second one).
 *
 * Refusals, in the order they are evaluated:
 *
 * - `execution.not-active` — the execution authority is not active (a legacy or
 *   staged store, or a store predating the execution schema keeps the file
 *   route);
 * - `execution.operation-conflict` — this operation id is already committed for
 *   a different reviewed intent (another producer call, delta or actor);
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
  const requestHash = registrationRequestHash(context.caller, plan);

  return withExecutionTransaction(context, (tx) => {
    if (tx.execution.authorityState !== "active") {
      throw new ExecutionError(
        "execution.not-active",
        `the execution authority is ${tx.execution.authorityState}; the DB registration route requires an active authority. ` +
          `A legacy or staged store registers through the file journal until activation.`,
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

    // §7 a legacy operation that is still in flight is settled on the file route
    // BEFORE this store can register anything; the DB route never adopts the
    // file protocol's partial state.
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
