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
  type CatalogEntityInput,
  type CatalogKey,
  type CatalogLinkInput,
  type CatalogReceipt,
  type ComposedStoreRevision,
} from "./catalog.js";
import {
  advanceCollaborationRevision,
  hasPreparedCompositeIntent,
  noteOutstandingAcknowledgement,
  repairCompositeAcknowledgement,
  remoteCompositeOperationId,
  reserveCompositeIntent,
  runCollaborationComposite,
  type CompositeIntent,
  type CompositeKey,
} from "./collaboration-operations.js";
import { openCollaborationStore, readCollaborationAuthority, readRemoteCacheAuthority, type CollaborationStamp } from "./collaboration-store.js";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import { prepareRemoteProjectWrite } from "./collaboration-remote.js";
import {
  assertRegisteredCompassDocument,
  assertRegisteredPlanDocuments,
  bindingInputOf,
  canonicalRegistrationIdentity,
  normalizeIterationPlanPaths,
  pendingRegistrationOf,
  refusePendingRegistration,
  resolveCatalogExecutionPlan,
  workflowEntryOf,
  writeBinding,
  type CatalogExecutionCatalogDelta,
  type CatalogExecutionPlan,
  type CatalogExecutionReceipt,
  type CatalogExecutionRequest,
  type CatalogExecutionWorkflow,
} from "./catalog-registration.js";
import { isPlainObject } from "./coordination-write.js";
import { readCatalogPlanSelection } from "./coordination.js";
import { canonicalRegisteredPlanPath } from "./plan-path.js";
import { relative, sep } from "node:path";
import {
  ExecutionError,
  assertActiveExecutionAuthority,
  assertExecutionToken,
  executionRootTokenOf,
  readOperationReplay,
  resolveCreateWorkflow,
  semanticRequestHash,
  withExecutionTransaction,
  writeExecutionCreation,
  writeOperationReceipt,
  type CreationCatalogSelection,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionToken,
  type ExecutionTransaction,
} from "./execution-store.js";
import { StoreError } from "./store-db.js";
import { selectSemanticFields, type SemanticSelection } from "./recovery-intent.js";
import { createHash } from "node:crypto";
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
 *
 * The intent is the request's IDENTITY form (`canonicalRegistrationIdentity`):
 * plan-row pointers are canonical exactly as the previous release hashed them,
 * while the compass keeps the caller's own spelling. Canonicalizing the compass
 * follows symlinks, so hashing its resolved form would move the identity of a
 * committed alias once its target is deleted and turn its retry into a conflict
 * (PR #578). Only the stored pointer and the new-registration proof are
 * canonical.
 */
function registrationRequestHash(caller: ExecutionCaller, request: CatalogExecutionRequest): string {
  return semanticRequestHash({
    operation: COMMIT_REGISTRATION_OPERATION,
    address: { workflow_id: request.workflow.workflowId },
    caller,
    intent: selectSemanticFields(canonicalIntent(request), REGISTRATION_SEMANTICS),
  });
}

/**
 * The fingerprint the previous release recorded for the same intent: the
 * request with the compass canonicalized too. Receipts committed before this
 * version are looked up under it as well, so an unchanged retry still replays
 * after the upgrade; a genuinely different intent matches neither form. A
 * pointer that no longer resolves (an external alias whose target was deleted)
 * cannot have produced a legacy receipt this call can match, so it contributes
 * no second fingerprint rather than refusing the retry.
 */
function legacyRegistrationRequestHash(caller: ExecutionCaller, request: CatalogExecutionRequest): string | null {
  try {
    return registrationRequestHash(caller, normalizeIterationPlanPaths(request));
  } catch {
    return null;
  }
}

/** The operation id a registration derives from its intent: the intent's stable form, hashed. */
function derivedOperationId(intent: {
  actor: string;
  workflow: CatalogExecutionWorkflow;
  delta: CatalogExecutionCatalogDelta;
}): string {
  return `op-${createHash("sha256").update(stableJson(intent), "utf8").digest("hex").slice(0, 24)}`;
}

/**
 * The derived operation id the previous release recorded for the same intent:
 * the same derivation over the LEGACY identity form (compass canonicalized too).
 * The live derivation keeps the caller's compass spelling, so a non-canonical
 * spelling now derives a DIFFERENT id than the receipt the previous release
 * committed — the retry looks its receipt up under both ids instead. Null when
 * this call has no distinct older form: a plan intent had none, and a pointer
 * that no longer resolves cannot have produced a legacy receipt this call can
 * match (same rule as `legacyRegistrationRequestHash`).
 */
/**
 * The derived operation ids previous releases recorded for the same intent: the
 * derivation over the identity forms and delta shapes those releases hashed.
 * The live derivation keeps the caller's compass spelling, so a non-canonical
 * spelling now derives a DIFFERENT id than the receipt an earlier release
 * committed — the retry looks its receipt up under every prior id instead.
 * Empty when this call has no distinct older form: a plan intent had none
 * before the delta widened, and a pointer that no longer resolves cannot have
 * produced a legacy receipt this call can match (same rule as
 * `legacyRegistrationRequestHash`).
 */
function legacyDerivedOperationIds(actor: string, identity: CatalogExecutionRequest): string[] {
  let legacy: CatalogExecutionRequest | null = null;
  try {
    legacy = normalizeIterationPlanPaths(identity);
  } catch {
    legacy = null;
  }
  const candidates: Array<{ workflow: CatalogExecutionWorkflow; delta: CatalogExecutionCatalogDelta }> = [];
  // This release widened the reviewed delta: a pre-upgrade receipt derived its
  // id over the prior, smaller delta.
  const priorIdentityDelta = priorReleaseDelta(identity.workflow);
  if (priorIdentityDelta !== null) candidates.push({ workflow: identity.workflow, delta: priorIdentityDelta });
  if (legacy !== null && legacy.workflow !== identity.workflow) {
    // The pointer-normalized identity form (compass canonicalized too) an even
    // earlier release hashed, under both delta shapes.
    candidates.push({ workflow: legacy.workflow, delta: catalogDeltaFor(legacy.workflow) });
    const priorLegacyDelta = priorReleaseDelta(legacy.workflow);
    if (priorLegacyDelta !== null) candidates.push({ workflow: legacy.workflow, delta: priorLegacyDelta });
  }
  return [...new Set(candidates.map((candidate) => derivedOperationId({ actor, ...candidate })))];
}

/**
 * The catalog delta the previous release reviewed for the same intent: an
 * iteration registration published its iteration entity and binding only —
 * plan-row membership entities, their `plan belongs-to iteration` links and the
 * project links are published by this version. The delta is part of the request
 * fingerprint and the derived operation id, so a committed pre-upgrade
 * registration must be looked up under its own prior form instead of
 * conflicting with its own retry. Null when this release introduced no delta
 * change (a plan intent).
 */
function priorReleaseDelta(workflow: CatalogExecutionWorkflow): CatalogExecutionCatalogDelta | null {
  if (workflow.kind !== "iteration") return null;
  return {
    entities: [{ kind: "iteration", id: workflow.workflowId, title: workflow.workflowId, rootKind: "iterations", relativePath: workflow.workflowId }],
    binding: { catalogKind: "iteration", catalogId: workflow.workflowId },
  };
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
 * - `catalog.registration-invalid` — a NEW iteration registration names no
 *   non-empty reviewed compass for this workflow; a committed operation id
 *   replays its receipt instead (I-000868);
 * - `plan-path.*` — a NEW iteration registration names a plan row whose
 *   document is missing, unreadable or not that plan's; same replay rule;
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
  // §4.1 identity BEFORE the pointers are resolved: plan-row pointers are
  // canonical (the previous release's hash) while the compass keeps the
  // caller's committed spelling, because canonicalization follows symlinks and
  // hashing the normalized pointer would move the identity of a committed alias
  // once its target is deleted (PR #578). The stored pointer and the
  // new-registration proof below stay canonical.
  const identity = canonicalRegistrationIdentity(request);
  const requestHash = registrationRequestHash(context.caller, identity);
  const legacyRequestHash = legacyRegistrationRequestHash(context.caller, identity);

  // invariant: §4.1 semantic replay first, BEFORE the collaboration lane is touched: the
  // retry of the same reviewed intent must not be judged by a CAS — or a
  // catalog expectation — its own first attempt already advanced, and a lost
  // response must still be answered when that lane is unavailable.
  const preflight = await withExecutionTransaction(context, (tx) => {
    assertActiveExecutionAuthority(
      tx,
      `state: ${tx.execution.authorityState}; registration requires the active execution authority. ` +
        `Upgrade required: mstar store upgrade --operator <name>.`,
    );
    return readOperationReplay<CatalogExecutionReceipt>(tx, {
      operationId: identity.operationId,
      requestHash,
      legacyRequestHash,
      workflowId: identity.workflow.workflowId,
      planId: null,
      token: { kind: "root", key: [] },
    });
  });
  if (preflight !== null) {
    return noteOutstandingAcknowledgement(
      preflight.data,
      await repairCompositeAcknowledgement(context, {
        executionStoreId: preflight.storeId,
        executionEpoch: preflight.epoch,
        operationId: identity.operationId,
      }),
    );
  }

  // invariant: A `remote` registration publishes its reviewed catalog delta into ONE project
  // journal (Q2: outbox operations address one project), so the journal is resolved BEFORE any
  // reservation exists; an ambiguous or absent project refuses with nothing reserved.
  const remote = resolveCollaborationLocation(context).mode === "remote";
  const journalProject = remote ? remoteRegistrationProject(request.workflow) : null;
  if (remote && journalProject === null) {
    throw new CatalogError(
      "catalog.invalid-entity",
      "A remote registration publishes its catalog delta into one project journal, so the reviewed workflow must name " +
        "exactly one project (a plan's `project`, or one iteration project). Split a multi-project iteration into one " +
        "registration per project. Nothing was reserved.",
    );
  }
  // invariant: The witness preflight: a registration publishes the reviewed delta into the
  // repository's collaboration lane, so that lane must be the ACTIVE one this
  // operation freezes as its target.
  const target = await collaborationStamp(context);
  const prepared = await withExecutionTransaction(context, (tx) => {
    // why: Only the CURRENT epoch's committed receipt replays, so an authority that
    // changed generation under this call is re-resolved instead of being served
    // (or written to) under a generation that no longer exists.
    const replayed = readOperationReplay<CatalogExecutionReceipt>(tx, {
      operationId: identity.operationId,
      requestHash,
      legacyRequestHash,
      workflowId: identity.workflow.workflowId,
      planId: null,
      token: { kind: "root", key: [] },
    });
    if (replayed !== null) return { kind: "replay" as const, receipt: replayed };

    // §3.1 only a NEW registration normalizes the pointers (canonical stored
    // form, containment) and proves the reviewed documents: the committed
    // attempt already proved them, so its receipt replays even when they have
    // since been removed, edited or left behind as a dangling alias (I-000868,
    // PR #578).
    const plan = resolveCatalogExecutionPlan(context, request);
    const operationId = plan.request.operationId;
    // The entry/snapshot pair the review describes: the identity anchors, the
    // new/unbound/unleased requirement and the plan rows' own seals are the C3
    // creation gates, reused verbatim.
    const creation = resolveCreateWorkflow(context.caller, workflowEntryOf(plan, plan.snapshot), plan.snapshot, operationId);
    if (remote) {
      // invariant: A plan row's catalog pin names a LOCAL catalog store identity; a remote
      // registration has no such store, so a pinned row is refused before anything is reserved.
      const pinned = creation.plans.filter((entry) => entry.pin !== null);
      if (pinned.length > 0) {
        throw new StoreError(
          "collaboration.mode-unavailable",
          `Plan ${pinned.map((entry) => entry.planId).join(", ")} carries a catalog pin from a local catalog store, which a ` +
            `remote registration cannot satisfy. Re-register these plans against the provider project, or drop the pin. ` +
            `Nothing was reserved.`,
        );
      }
    }
    assertRegisteredCompassDocument(plan.request.workflow);
    assertRegisteredPlanDocuments(plan.request.workflow);

    // §3.1 CAS: the parent (root) token of THIS store, epoch and revision.
    assertExecutionToken(request.expected, {
      kind: "root",
      storeId: tx.storeId,
      epoch: tx.epoch,
      key: [],
      revision: tx.execution.revision,
    });

    // invariant: A legacy operation still in flight must be settled explicitly before this
    // registration can commit; it never adopts legacy journal state.
    const pending = pendingRegistrationOf(tx.db, plan.workflowId);
    if (pending !== null) refusePendingRegistration(plan.workflowId, pending);

    // Create-only admission: a workflow identity another lifecycle already
    // holds is a deterministic conflict, so it is refused BEFORE the catalog
    // delta publishes. `writeExecutionCreation` remains the authoritative check
    // at finalization; admitting it here is what keeps a duplicate from
    // publishing an effect and then reporting an unresumable partial. The
    // wording is kept identical to that guard deliberately.
    // simplify: a second copy of the create-only guard, not yet composable
    // because execution-store keeps `assertWorkflowIdentityIsNew` private.
    // upgrade: export `assertWorkflowIdentityIsNew` from execution-store and
    // compose the guard, or when a third copy would be required.
    const existing = tx.db
      .prepare("select revision from execution_workflows where workflow_id = ?")
      .get(plan.workflowId) as { revision?: unknown } | undefined;
    if (existing !== undefined) {
      throw new ExecutionError(
        "execution.not-empty",
        `execution_workflows already holds workflow ${plan.workflowId} (revision ${String(existing.revision)}). A workflow ` +
          `identity is create-only: re-creating it never restores registry membership, resets revisions or rewrites its ` +
          `rows. Nothing was created.`,
      );
    }

    const key: CompositeKey = { executionStoreId: tx.storeId, executionEpoch: tx.epoch, operationId };
    // why: The reviewed catalog expectation is a transport constraint, not business
    // intent: a resumed reservation keeps the value its FIRST attempt admitted,
    // so an interruption that already published the delta still resumes under
    // the revision the delta was reviewed against.
    const expectedCatalogRevision = frozenCatalogExpectation(tx, key) ?? plan.request.expectedCatalogRevision;
    const intent: CompositeIntent = {
      key,
      kind: "execution-register",
      requestHash,
      target,
      scope: { workflowId: plan.workflowId, planId: null },
      actor: plan.request.actor,
      expectedExecution: executionRootTokenOf(tx),
      // invariant: The frozen payload IS the resume identity: the reviewed workflow, its
      // delta and the catalog revision they were reviewed against. A changed
      // document or expectation cannot reinterpret a pending registration.
      frozenPayload: stableJson({
        operationId,
        actor: plan.request.actor,
        workflow: plan.request.workflow,
        delta: plan.request.delta,
        expectedCatalogRevision,
      }),
    };
    // note: The reservation spends none of the execution facts: the creation is
    // create-only and commits at finalization.
    const reservation = reserveCompositeIntent(tx, intent, { revision: tx.execution.revision });
    return {
      kind: "reserved" as const,
      intent: { ...intent, requestHash: reservation.requestHash },
      plan,
      creation,
      expectedCatalogRevision,
    };
  });
  if (prepared.kind === "replay") {
    return noteOutstandingAcknowledgement(
      prepared.receipt.data,
      await repairCompositeAcknowledgement(context, {
        executionStoreId: prepared.receipt.storeId,
        executionEpoch: prepared.receipt.epoch,
        operationId: identity.operationId,
      }),
    );
  }

  const { plan, creation, expectedCatalogRevision } = prepared;
  // invariant: The pinned catalog identities live on the collaboration lane: read them
  // BEFORE the composite's execution finalization, so no cross-file read runs
  // inside a write transaction. Entities this delta publishes join the evidence
  // deterministically (the apply transaction publishes exactly them).
  const pinnedPlanIds = [...new Set(creation.plans.filter((entry) => entry.pin !== null).map((entry) => entry.planId))];
  const selection = remote ? { storeId: null, planIds: [] } : await readCatalogPlanSelection(context.harnessDir, pinnedPlanIds);
  const reviewedPlanIds = (plan.request.delta.entities ?? [])
    .filter((entity) => entity.kind === "plan")
    .map((entity) => entity.id);
  const creationCatalog: CreationCatalogSelection = {
    storeId: selection.storeId,
    planIds: [...new Set([...selection.planIds, ...reviewedPlanIds])],
  };
  return runCollaborationComposite<CatalogExecutionReceipt>(context, prepared.intent, {
    apply(handle) {
      // why: §7 the reviewed catalog expectation, re-read under the writer lock so no
      // concurrent catalog write can move it between the review and the publish.
      const before = readCatalogStoreVersionsOn(handle.db);
      if (before.catalogRevision !== expectedCatalogRevision) {
        throw new CatalogError(
          "catalog.revision-conflict",
          `the reviewed delta expects catalog revision ${expectedCatalogRevision}, but the collaboration catalog is at ` +
            `${before.catalogRevision}; nothing was registered.`,
        );
      }
      // why: §3.1 ONE collaboration revision advance for the whole effect transaction:
      // every published row joins it instead of moving the counter again.
      const composed: ComposedStoreRevision = { committedStoreRevision: advanceCollaborationRevision(handle) };
      const entities: PublishedRegistrationEntity[] = [];
      for (const [index, entity] of plan.request.delta.entities.entries()) {
        const receipt = registerCatalogEntityOn(
          handle.db,
          context,
          entity,
          { operationId: `${plan.request.operationId}:entity:${index}`, actor: plan.request.actor },
          composed,
        );
        entities.push({
          reviewed: { kind: entity.kind, id: entity.id },
          published: { kind: receipt.kind, id: receipt.id, revision: receipt.revision },
        });
      }
      for (const [index, link] of (plan.request.delta.links ?? []).entries()) {
        linkCatalogEntitiesOn(
          handle.db,
          context,
          link,
          { operationId: `${plan.request.operationId}:link:${index}`, actor: plan.request.actor },
          composed,
        );
      }
      // invariant: The reviewed catalog EFFECT facts the execution half must pin: the exact
      // committed catalog revision and the row each reviewed entity resolved to
      // (a location collision attaches to an existing id instead of a new one).
      return stableJson({ catalogRevision: readCatalogStoreVersionsOn(handle.db).catalogRevision, entities });
    },
    async remote(context) {
      // invariant: The provider journal IS the remote catalog. The reviewed delta is frozen as one
      // project-replace against the observed journal head; portable identity, metadata and
      // lifecycle publish, while checkout-only location facts stay out of the document.
      const operationId = remoteCompositeOperationId(prepared.intent.key);
      return prepareRemoteProjectWrite(context, {
        projectId: journalProject as string,
        operationId,
        executionKey: { ...prepared.intent.key, operationId },
        reservation: prepared.intent.key,
        next: (current) => {
          const entities = current.catalogEntities as Array<Record<string, unknown>>;
          const nextEntities = [...entities];
          for (const entity of plan.request.delta.entities) {
            const desired = portableCatalogRow(entity);
            const existing = nextEntities.find((row) => row.kind === entity.kind && row.id === entity.id);
            if (existing !== undefined) {
              // invariant: An observed row that ALREADY carries exactly the reviewed portable
              // content is the same published outcome, so it is adopted: a correction after a
              // partially settled repair publishes only what is missing instead of replaying (or
              // silently overwriting) settled rows. Different content is another write, not a
              // duplicate of this review, and is refused.
              if (!samePortableCatalogRow(existing, desired)) {
                throw new CatalogError(
                  "catalog.duplicate",
                  `${entity.kind} ${entity.id} is already registered in the observed project with different content; ` +
                    `nothing was enqueued. Settle the reviewed field first with its own remote catalog write ` +
                    `(\`mstar catalog update ${entity.kind} ${entity.id} --project ${journalProject as string} ` +
                    `--expect <observed-revision> --operation-id <uuid> --actor <role>\`), dispatch and confirm that ` +
                    `journal write, re-observe, then reissue this SAME registration: the settled row is adopted ` +
                    `identically instead of rewritten.`,
                );
              }
              continue;
            }
            nextEntities.push(desired);
          }
          const known = new Set(nextEntities.map((row) => `${String(row.kind)}:${String(row.id)}`));
          const nextLinks = [...(current.catalogLinks as Array<Record<string, unknown>>)];
          for (const link of plan.request.delta.links ?? []) {
            for (const endpoint of [link.from, link.to]) {
              if (!known.has(`${endpoint.kind}:${endpoint.id}`)) {
                throw new CatalogError(
                  "catalog.link-refused",
                  `${endpoint.kind} ${endpoint.id} is not registered in the observed project; a dangling link is never published.`,
                );
              }
            }
            const desired = portableCatalogLink(link);
            if (!nextLinks.some((row) => samePortableCatalogLink(row, desired))) nextLinks.push(desired);
          }
          return { ...current, catalogEntities: nextEntities, catalogLinks: nextLinks };
        },
        origin: {
          verb: "execution-register",
          request: { projectId: journalProject, delta: plan.request.delta },
        },
      });
    },
    finalize(tx, receipt) {
      const facts = remote
        ? remoteRegistrationFacts(receipt.facts, plan.request.delta, journalProject as string)
        : registrationEffectFacts(receipt.facts);
      const binding = plan.request.delta.binding;
      const bound = facts.entities.find(
        (entity) => entity.reviewed.kind === binding.catalogKind && entity.reviewed.id === binding.catalogId,
      );
      if (bound === undefined) {
        throw new StoreError(
          "store.corrupt",
          `the committed catalog effect of registration ${JSON.stringify(prepared.intent.key.operationId)} carries no ` +
            `published row for its binding entity ${binding.catalogKind} ${JSON.stringify(binding.catalogId)}; the binding is ` +
            `not written from a guessed identity.`,
        );
      }
      const now = new Date().toISOString();
      writeExecutionCreation(tx, { caller: context.caller, creation, catalog: creationCatalog, now });
      // invariant: The binding records the row the catalog effect COMMITTED, pinned to the
      // exact catalog revision in that receipt — never a later re-read state.
      writeBinding(
        tx.db,
        plan,
        bound.published.id,
        { ...bindingInputOf(plan), id: bound.published.id },
        receipt.catalogRevision,
      );
      const result: CatalogExecutionReceipt = {
        operationId: plan.request.operationId,
        workflowId: plan.workflowId,
        catalogRevision: receipt.catalogRevision,
        recovered: false,
      };
      writeOperationReceipt(tx, {
        operationId: plan.request.operationId,
        requestHash: prepared.intent.requestHash,
        workflowId: plan.workflowId,
        planId: null,
        now,
        receipt: { data: result, token: executionRootTokenOf(tx), storeId: tx.storeId, epoch: tx.epoch },
        allowReservedIntent: true,
      });
      return result;
    },
    remoteIds: () => [remoteCompositeOperationId(prepared.intent.key)],
  });
}

/** note: One reviewed catalog entity and the catalog row the effect committed for it. */
type PublishedRegistrationEntity = Readonly<{
  reviewed: CatalogKey;
  published: Readonly<{ kind: string; id: string; revision: number }>;
}>;

/** note: The recorded catalog expectation of a pending reservation, or null for a new admission. */
function frozenCatalogExpectation(tx: ExecutionTransaction, key: CompositeKey): number | null {
  const row = tx.db
    .prepare(
      "select frozen_payload from execution_collaboration_intents where execution_store_id = ? and execution_epoch = ? " +
        "and operation_id = ? and phase = 'prepared'",
    )
    .get(key.executionStoreId, key.executionEpoch, key.operationId) as { frozen_payload?: unknown } | undefined;
  if (typeof row?.frozen_payload !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(row.frozen_payload);
    return isPlainObject(parsed) && typeof parsed.expectedCatalogRevision === "number"
      ? parsed.expectedCatalogRevision
      : null;
  } catch {
    return null;
  }
}

/** note: The committed catalog effect facts a finalization pins, validated before use. */
function registrationEffectFacts(facts: string): { catalogRevision: number; entities: PublishedRegistrationEntity[] } {
  const parsed: unknown = JSON.parse(facts);
  if (!isPlainObject(parsed) || typeof parsed.catalogRevision !== "number" || !Array.isArray(parsed.entities)) {
    throw new StoreError("store.corrupt", "the committed registration effect carries no readable catalog facts");
  }
  return parsed as unknown as { catalogRevision: number; entities: PublishedRegistrationEntity[] };
}

/**
 * note: The ONE project journal a remote registration addresses. A plan names its project
 * directly; an iteration names exactly one project for a remote registration, since one outbox
 * operation addresses one journal. Null means the reviewed workflow does not decide it.
 */
function remoteRegistrationProject(workflow: CatalogExecutionWorkflow): string | null {
  if (workflow.kind === "plan") {
    const project = workflow.options.project;
    return typeof project === "string" && project.trim() !== "" ? project.trim() : null;
  }
  const declared = workflow.options.projects ?? (workflow.options.project === undefined ? [] : [workflow.options.project]);
  const projects = [...new Set(declared.filter((entry) => typeof entry === "string" && entry.trim() !== ""))];
  return projects.length === 1 ? projects[0]! : null;
}

/** note: One reviewed catalog entity as the PORTABLE row a remote project journal publishes. */
function portableCatalogRow(entity: CatalogEntityInput): Record<string, unknown> {
  return {
    kind: entity.kind,
    id: entity.id,
    title: entity.title,
    description: entity.description ?? null,
    documentKind: entity.documentKind ?? null,
    lifecycle: entity.lifecycle ?? "active",
    revision: 1,
  };
}

/** note: One reviewed link as the portable journal row (an absent ordinal is the journal's 0). */
function portableCatalogLink(link: CatalogLinkInput): Record<string, unknown> {
  return {
    fromKind: link.from.kind,
    fromId: link.from.id,
    relation: link.relation,
    toKind: link.to.kind,
    toId: link.to.id,
    ordinal: link.ordinal ?? 0,
  };
}

/**
 * invariant: The portable content of one journal row, compared field by field: the metadata and
 * lifecycle a registration publishes, at the journal's own normalization (`description` and
 * `documentKind` null, `lifecycle` active). The row's own revision is not reviewed content.
 * Checkout-only location facts (`rootKind`, `relativePath`) are never part of the journal.
 */
function samePortableCatalogRow(row: Record<string, unknown>, desired: Record<string, unknown>): boolean {
  const field = (value: unknown): unknown => value ?? null;
  return (
    row.kind === desired.kind &&
    row.id === desired.id &&
    row.title === desired.title &&
    field(row.description) === desired.description &&
    field(row.documentKind) === desired.documentKind &&
    (row.lifecycle ?? "active") === desired.lifecycle
  );
}

/** note: Whether one journal link row is exactly the reviewed relation (ordinal absent means 0). */
function samePortableCatalogLink(row: Record<string, unknown>, desired: Record<string, unknown>): boolean {
  return (
    row.fromKind === desired.fromKind &&
    row.fromId === desired.fromId &&
    row.relation === desired.relation &&
    row.toKind === desired.toKind &&
    row.toId === desired.toId &&
    (row.ordinal ?? 0) === desired.ordinal
  );
}

/**
 * invariant: The refusal of a settled remote effect that does not carry the reviewed business
 * outcome. It names the operation and record the provider actually settled and a supported
 * same-outcome correction: a re-observed, NEW registration of the SAME workflow adopts the rows
 * the settlement already carries identically and publishes only what is missing, so settled work
 * is never re-sent or overwritten. A settlement that CHANGED a reviewed field is not corrected by
 * reissuing alone — that reissue meets `catalog.duplicate` — so the caller supplies that field's
 * own reviewed settlement as the ONE ordered route, addressed at the SAME project journal.
 */
function remoteEffectMismatch(
  settled: ReadonlyArray<{ operationId: string; recordId: string | null }>,
  what: string,
  details: Record<string, unknown>,
  recovery?: string,
): StoreError {
  const operations = settled.map((entry) => entry.operationId).join(", ") || "(unrecorded)";
  const records = settled.map((entry) => entry.recordId).filter((id): id is string => id !== null);
  const route =
    recovery ??
    `Inspect the settled effect with \`mstar store collaboration remote outbox-show --harness <abs> --operation ` +
      `${settled[0]?.operationId ?? "<uuid>"}\`, then re-observe the project with ` +
      `\`mstar store collaboration remote observe --harness <abs> --input <file|->\` and reissue this SAME registration ` +
      `for the SAME workflow under a NEW operation id: rows the settlement already carries identically are adopted, only ` +
      `the missing work is published, and the settled effect is never re-sent.`;
  return new StoreError(
    "remote.effect-mismatch",
    `the confirmed provider effect ${operations}${records.length === 0 ? "" : ` (record ${records.join(", ")})`} ${what}, ` +
      `so the reviewed registration's business outcome never fully landed and the execution binding is not written from ` +
      `a guessed identity. ${route}`,
    {
      settled_operations: settled.map((entry) => entry.operationId),
      settled_records: records,
      // invariant: The settled provider work is DURABLE; a replayed decline names it so the
      // operator never re-sends it while the execution acknowledgement stays unapplied.
      confirmed_components: settled.map((entry) => `provider:${entry.operationId}`),
      recovery: route,
      ...details,
    },
  );
}

/**
 * invariant: The effect facts a REMOTE registration's finalization pins. The confirmed EVENT each
 * receipt names is the published content — the original event, or the confirmed repair's own
 * replacement — so the reviewed delta's NORMALIZED PORTABLE FIELDS and LINKS must all be readable
 * in one of those journals before any binding is written from them. Presence of a `(kind, id)` is
 * never enough: a settlement that alters a reviewed title/lifecycle or drops a `belongs-to` link is
 * disclosed and declined (`remote.effect-mismatch`), never finalized from the original request. The
 * portable document holds no catalog revision, so the pinned revision is 0 rather than a local
 * counter.
 */
function remoteRegistrationFacts(
  facts: string,
  delta: CatalogExecutionCatalogDelta,
  projectId: string,
): { catalogRevision: number; entities: PublishedRegistrationEntity[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(facts);
  } catch {
    parsed = null;
  }
  if (!isPlainObject(parsed) || !("remote" in parsed) || !Array.isArray(parsed.remote)) {
    throw new StoreError(
      "store.corrupt",
      "the committed remote registration effect carries no readable remote facts",
    );
  }
  const rows = new Map<string, Record<string, unknown>>();
  const links: Array<Record<string, unknown>> = [];
  const settled: Array<{ operationId: string; recordId: string | null }> = [];
  for (const entry of parsed.remote) {
    if (!isPlainObject(entry) || !isPlainObject(entry.event)) {
      throw new StoreError(
        "collaboration.unreadable",
        "the confirmed remote registration effect carries no readable provider event, so it proves no published row",
      );
    }
    const change = entry.event.change;
    if (
      !isPlainObject(change) ||
      change.kind !== "project-replace" ||
      !isPlainObject(change.project) ||
      !Array.isArray(change.project.catalogEntities)
    ) {
      throw new StoreError(
        "collaboration.unreadable",
        "the confirmed remote registration effect is not a readable project journal with catalog rows",
      );
    }
    settled.push({
      operationId: typeof entry.operationId === "string" ? entry.operationId : "(unrecorded)",
      recordId: typeof entry.recordId === "string" ? entry.recordId : null,
    });
    for (const row of change.project.catalogEntities) {
      if (!isPlainObject(row) || typeof row.kind !== "string" || typeof row.id !== "string") continue;
      rows.set(`${row.kind}:${row.id}`, row);
    }
    for (const link of Array.isArray(change.project.catalogLinks) ? change.project.catalogLinks : []) {
      if (isPlainObject(link)) links.push(link);
    }
  }
  for (const entity of delta.entities) {
    const row = rows.get(`${entity.kind}:${entity.id}`);
    if (row === undefined) {
      throw remoteEffectMismatch(settled, `publishes no ${entity.kind} ${JSON.stringify(entity.id)} row`, {
        missing_entity: { kind: entity.kind, id: entity.id },
      });
    }
    if (!samePortableCatalogRow(row, portableCatalogRow(entity))) {
      throw remoteEffectMismatch(
        settled,
        `publishes ${entity.kind} ${JSON.stringify(entity.id)} with different portable content than the reviewed delta`,
        { mismatched_entity: { kind: entity.kind, id: entity.id } },
        `Inspect the settled effect with \`mstar store collaboration remote outbox-show --harness <abs> --operation ` +
          `${settled[0]?.operationId ?? "<uuid>"}\`; re-observe the settled project with ` +
          `\`mstar store collaboration remote observe --harness <abs> --input <file|->\`; settle the reviewed field in ` +
          `that journal with \`mstar catalog update ${entity.kind} ${entity.id} --project ${projectId} ` +
          `--expect <observed-revision> --operation-id <uuid> --actor <role>\` plus the reviewed ` +
          `--title/--description/--document-kind/--lifecycle; dispatch and confirm that write with ` +
          `\`mstar store collaboration remote outbox-dispatch\` and \`outbox-receipt\`; re-observe the confirmed journal ` +
          `again; then reissue this SAME registration for the SAME workflow under a NEW operation id: the settled row ` +
          `is adopted identically and is never rewritten.`,
      );
    }
  }
  for (const link of delta.links ?? []) {
    const desired = portableCatalogLink(link);
    if (!links.some((row) => samePortableCatalogLink(row, desired))) {
      throw remoteEffectMismatch(
        settled,
        `publishes no ${link.from.kind} ${JSON.stringify(link.from.id)} ${link.relation} ${link.to.kind} ` +
          `${JSON.stringify(link.to.id)} link`,
        {
          missing_link: {
            from: { kind: link.from.kind, id: link.from.id },
            relation: link.relation,
            to: { kind: link.to.kind, id: link.to.id },
          },
        },
      );
    }
  }
  return {
    catalogRevision: 0,
    entities: delta.entities.map((entity) => {
      const row = rows.get(`${entity.kind}:${entity.id}`) as Record<string, unknown>;
      return {
        reviewed: { kind: entity.kind, id: entity.id },
        published: {
          kind: entity.kind,
          id: entity.id,
          revision: typeof row.revision === "number" ? row.revision : 1,
        },
      };
    }),
  };
}

/** note: The frozen collaboration target stamp of this repository's ACTIVE lane. */
async function collaborationStamp(context: ExecutionContext): Promise<CollaborationStamp> {
  // invariant: A `remote` checkout's registration publishes its catalog delta into the provider
  // journal, so its stamp is the private cache's own identity, never a local lane.
  if (resolveCollaborationLocation(context).mode === "remote") {
    const authority = await readRemoteCacheAuthority(context);
    return { repoKey: authority.repoKey, mode: "remote", storeId: authority.storeId, epoch: authority.epoch };
  }
  // invariant: WRITE admission: the binding must hold before this verb reserves an intent,
  // so an unbound checkout refuses here instead of after the reservation.
  const handle = await openCollaborationStore(context, "write");
  try {
    return {
      repoKey: handle.authority.repoKey,
      mode: handle.authority.mode,
      storeId: handle.authority.storeId,
      epoch: handle.authority.epoch,
    };
  } finally {
    handle.close();
  }
}

/**
 * Derive the catalog delta from the ACTIVE workflow intent: a plan entity
 * follows its workflow options, an iteration entity its workflow id. The
 * binding follows the workflow's primary association.
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
  // C2/C4: the registration delta is the catalog projection of the reviewed
  // intent — the iteration's plan rows become catalog plan entities with one
  // `plan belongs-to iteration` link each (a catalog relation may not dangle,
  // so the link requires the entity), and every declared project gets one
  // `iteration belongs-to project` link. Plan locations derive from the row
  // pointers WITHOUT reading the documents, so a committed operation still
  // replays after its files are gone (I-000868).
  const planEntities = workflow.options.rows.map((row) => {
    // One resolver for both halves: the catalog location is the plan document's
    // path relative to the plan dir THE RESOLVER derives (same canonical root),
    // never a second plan-dir spelling of the caller's harnessDir.
    const resolved = canonicalRegisteredPlanPath({
      harnessRoot: workflow.options.harnessDir,
      planId: row.id,
      file: row.file,
    });
    return {
      kind: "plan" as const,
      id: row.id,
      title: row.title,
      rootKind: "plans" as const,
      relativePath: relative(resolved.planDir, resolved.planPath).split(sep).join("/"),
    };
  });
  const projects = [...new Set(workflow.options.projects ?? (workflow.options.project === undefined ? [] : [workflow.options.project]))];
  return {
    entities: [
      { kind: "iteration", id: workflow.workflowId, title: workflow.workflowId, rootKind: "iterations", relativePath: workflow.workflowId },
      ...planEntities,
    ],
    links: [
      ...planEntities.map((plan) => ({
        from: { kind: "plan" as const, id: plan.id },
        relation: "belongs-to" as const,
        to: { kind: "iteration" as const, id: workflow.workflowId },
      })),
      ...projects.map((project) => ({
        from: { kind: "iteration" as const, id: workflow.workflowId },
        relation: "belongs-to" as const,
        to: { kind: "project" as const, id: project },
      })),
    ],
    binding: { catalogKind: "iteration", catalogId: workflow.workflowId },
  };
}
/**
 * Register a shipped workflow on the ACTIVE store. The reviewed catalog
 * revision is read from the repository's ACTIVE collaboration lane (the catalog
 * moved there), the root token from one execution transaction, and
 * `commitExecutionRegistration` rechecks both under its own composite.
 *
 * §4.1 the recorded receipt is resolved BEFORE the optional supplied
 * expectations are enforced: an identical retry after a lost response
 * re-presents the tokens its own first attempt already advanced, so it must
 * replay rather than be judged stale. A supplied expectation is a constraint on
 * a NEW registration attempt, never a veto over an already-recorded operation.
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
  // The operation id (supplied or derived) and the request fingerprint are
  // taken from the request's IDENTITY form: plan-row pointers canonical, as the
  // previous release hashed them, and the compass in the caller's own spelling,
  // so a re-spelled plan pointer keeps its derived id and a dangling alias
  // still replays (I-000868, PR #578). The stored pointer and the
  // new-registration proof stay canonical below.
  const drafted = canonicalRegistrationIdentity({
    actor: input.actor,
    operationId: input.operationId ?? "request-derived",
    expectedCatalogRevision: 0,
    workflow: input.workflow,
    delta: initialDelta,
  });
  const intent = { actor: input.actor, workflow: drafted.workflow, delta: catalogDeltaFor(drafted.workflow) };
  const operationId = input.operationId ?? derivedOperationId(intent);
  const request: CatalogExecutionRequest = {
    ...intent,
    operationId,
    expectedCatalogRevision: 0,
  };
  const identity = canonicalRegistrationIdentity(request);
  const requestHash = registrationRequestHash(context.caller, identity);
  const legacyRequestHash = legacyRegistrationRequestHash(context.caller, identity);
  // This release widened the reviewed delta (iteration plan-row membership and
  // project links), which moved the fingerprint: a receipt committed before the
  // upgrade carries the prior, smaller delta's fingerprint, so the replay
  // lookup matches the prior release's forms too (the identity form, and the
  // pointer-normalized form an even earlier release hashed) and an unchanged
  // retry still replays.
  const priorDelta = priorReleaseDelta(input.workflow);
  let normalizedForm: CatalogExecutionRequest | null = null;
  try {
    normalizedForm = normalizeIterationPlanPaths(identity);
  } catch {
    normalizedForm = null;
  }
  const replayHashes = [
    legacyRequestHash,
    priorDelta === null ? null : registrationRequestHash(context.caller, { ...identity, delta: priorDelta }),
    normalizedForm !== null && priorDelta !== null
      ? registrationRequestHash(context.caller, { ...normalizedForm, delta: priorDelta })
      : null,
  ].filter((entry, index, all): entry is string => entry !== null && !all.slice(0, index).includes(entry));
  // Only a DERIVED id moved with the identity and delta forms: a caller-supplied
  // id keeps its single lookup plus the legacy fingerprints.
  const legacyOperationIds =
    input.operationId === undefined ? legacyDerivedOperationIds(input.actor, identity) : [];
  const replay = await withExecutionTransaction<
    { replayed: CatalogExecutionReceipt } | { expected: ExecutionToken; resuming: boolean }
  >(
    context,
    (tx) => {
      const expected = executionRootTokenOf(tx);
      // invariant: §4.1 resolve the recorded receipt FIRST: a retry that re-presents the
      // constraints its own first attempt advanced must replay through
      // `readOperationReplay` (the one idempotency rule) instead of being judged
      // stale before the lookup. Only a genuinely new attempt is constrained.
      const replayed = readOperationReplay<CatalogExecutionReceipt>(tx, {
        operationId: identity.operationId,
        requestHash,
        legacyRequestHash: replayHashes,
        workflowId: identity.workflow.workflowId,
        planId: null,
        token: { kind: "root", key: [] },
      });
      if (replayed !== null) return { replayed: replayed.data };
      for (const legacyOperationId of legacyOperationIds) {
        // invariant: A previous release addressed this same intent by a derived id this
        // version no longer computes: its receipt replays here instead of the
        // retry being judged a NEW registration (which would refuse
        // `execution.not-empty`).
        const legacyReplayed = readOperationReplay<CatalogExecutionReceipt>(tx, {
          operationId: legacyOperationId,
          requestHash,
          legacyRequestHash: replayHashes,
          workflowId: identity.workflow.workflowId,
          planId: null,
          token: { kind: "root", key: [] },
        });
        if (legacyReplayed !== null) return { replayed: legacyReplayed.data };
      }
      // A NEW shipped registration normalizes the pointers (canonical stored
      // form, containment) and proves its reviewed documents here; the replayed
      // operation id above already proved them and keeps its receipt (I-000868,
      // PR #578).
      const canonical = resolveCatalogExecutionPlan(context, request);
      assertRegisteredCompassDocument(canonical.request.workflow);
      assertRegisteredPlanDocuments(canonical.request.workflow);
      if (input.expected !== undefined) {
        // why: The ADDRESS half keeps its own precise refusal; the REVISION half is
        // compared below so this seam can name the recovery for a stale root
        // expectation instead of the bare shared message.
        assertExecutionToken(input.expected, {
          kind: "root",
          storeId: tx.storeId,
          epoch: tx.epoch,
          key: [],
        });
        if (input.expected !== expected) {
          throw new ExecutionError(
            "execution.stale-token",
            "the supplied root expectation is not this store's current execution token. Re-read the current root token " +
              "with `mstar status validate` (output field data.token) and retry with it; an operation id already committed " +
              "for this intent replays instead of being refused.",
          );
        }
      }
      // why: An operation whose catalog effect committed while its finalization was
      // interrupted is RESOLVED here (the reservation is the durable record), so
      // the composite adopts the expectation that attempt froze instead of the
      // retry being judged a new attempt against the moved catalog.
      const resuming = hasPreparedCompositeIntent(tx, {
        executionStoreId: tx.storeId,
        executionEpoch: tx.epoch,
        operationId: identity.operationId,
      });
      return { expected, resuming };
    },
  );
  if ("replayed" in replay) return replay.replayed;
  // why: The reviewed catalog revision belongs to the repository's ACTIVE
  // collaboration lane, not to this execution store: a NEW attempt pins the
  // revision it is reviewed against, and the published delta then joins it. A
  // resumed operation keeps the expectation its first attempt admitted. A
  // `remote` checkout's lane is its private cache — `readCollaborationAuthority`
  // refuses the local lane outright.
  const authority =
    resolveCollaborationLocation(context).mode === "remote"
      ? await readRemoteCacheAuthority(context)
      : await readCollaborationAuthority(context);
  if (!replay.resuming && input.expectedCatalogRevision !== undefined && input.expectedCatalogRevision !== authority.catalogRevision) {
    throw new CatalogError(
      "catalog.revision-conflict",
      `the supplied catalog expectation is ${input.expectedCatalogRevision}, but the collaboration catalog is at ` +
        `${authority.catalogRevision}. Read the current store and catalog revisions (the ACTIVE catalog-revisions read), ` +
        "or omit the catalog expectation on the shipped registration so it derives the current revision, then retry.",
    );
  }
  return commitExecutionRegistration(context, {
    ...request,
    expectedCatalogRevision: replay.resuming
      ? input.expectedCatalogRevision ?? authority.catalogRevision
      : authority.catalogRevision,
    expected: replay.expected,
  });
}
