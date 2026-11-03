/**
 * issue-sync/push.ts — the one-way push direction over the sync ledger.
 *
 * What this module owns, and what it deliberately refuses to claim:
 *
 * - CANDIDATES are the bound project's local issues (`provider = 'local'`).
 *   Each is normalized through the shared field mapping into one provider
 *   payload and hashed. The hash is the SKIP RULE — equal hash means the remote
 *   content is already what local says, so nothing is written. It is NOT an
 *   exactly-once proof: the hash is computed from local content, and only a
 *   confirmed receipt (or an operator `--adopt`) ever records an external id.
 * - A CONFIRMED create/update is the only thing that writes `external_id`.
 *   `ambiguous` leaves the row `pending` with no id: the caller must reconcile.
 * - AMBIGUOUS CREATE RECOVERY is marker equality, never prose. Every pushed
 *   description ends with `<!-- mstar-sync: <workspace>/<team>/<storeId>/<localId> -->`;
 *   the store id is the pushing store's random `store_meta.store_id`, so two
 *   harness stores mirroring one team never adopt each other's rows. A unique
 *   title+description match proves nothing about ownership and is never adopted.
 * - The listing is used ONLY for reconciliation. A run with no ambiguous
 *   residue issues zero listing calls.
 *
 * Credential-free by construction: the provider is injected and carries its own
 * transport; nothing here reads a token.
 */
import { createHash } from "node:crypto";
import type { StoreDb } from "../store-db.js";
import type { Disposition, IssueKind, Severity } from "../issue.js";
import type { LinearFacetMapping } from "../mstarc.js";
import { SyncError, claimItem, markApplied, markFailed, markUnconfirmed, planItem, readItem, recordRefusal, type SyncItem } from "../issue-sync.js";
import { defaultStateOfDisposition, providerPayloadFields } from "./field-mapping.js";
import type { IssueProvider, ProviderWrite, ProviderWritePayload } from "./provider.js";

/** The only direction this module drives. */
export const PUSH_DIRECTION = "push" as const;

/**
 * The `.mstarc` connection facts the marker is composed from, plus the store
 * identity. `workspace` is omitted from the marker when unset.
 */
export type PushBinding = { workspace: string; team: string };

/** Everything one item push needs that is not local content. */
export type PushContext = {
  /** `"linear:<project_id>"`, the ledger's binding key. */
  bindingId: string;
  binding: PushBinding;
  /** The pushing store's stable identity (`store_meta.store_id`). */
  storeId: string;
  mapping?: LinearFacetMapping;
  /**
   * The label names the workspace really has, discovered once per run. Only a
   * name in this set is ever sent; a mapped name outside it refuses the ITEM.
   */
  labels: ReadonlySet<string>;
  /**
   * The workflow state names the bound team really has, discovered once per
   * run alongside the labels. Push never creates or renames a state, so a
   * mapped name outside it refuses the ITEM here instead of every item failing
   * at the provider.
   */
  states: ReadonlySet<string>;
  /** Operator confirmed remote absence for this one item (`--force-create`). */
  forceCreate?: boolean;
};

export type PushOutcomeKind = "created" | "updated" | "skipped" | "unresolved" | "failed";

export type PushOutcome = {
  localId: string;
  outcome: PushOutcomeKind;
  externalId: string | null;
  /** Credential-free cause for `unresolved` / `failed`. */
  cause?: string;
};

/** One local issue, with the content a payload needs. */
export type PushCandidate = {
  localId: string;
  title: string;
  kind: IssueKind;
  severity: Severity;
  disposition: Disposition;
  impact: string;
  acceptance: string;
};

/**
 * The bound project's pushable issues: local captures, never imported mirrors.
 * An imported row's `provider` is `linear`, so the import direction can never
 * echo its own mirror back as a create.
 */
export function selectPushCandidates(db: StoreDb, bindingId: string): PushCandidate[] {
  const projectId = projectIdOf(bindingId);
  return db
    .prepare(
      "select id as localId, title, kind, severity, disposition, impact, acceptance from issues" +
        " where project_id = ? and provider = 'local' order by id",
    )
    .all(projectId) as PushCandidate[];
}

/** `"<provider>:<project_id>"` → the store project id (`sync.invalid-input` otherwise). */
function projectIdOf(bindingId: string): string {
  const prefix = "linear:";
  if (typeof bindingId !== "string" || !bindingId.startsWith(prefix) || bindingId.length === prefix.length) {
    throw new Error(`[sync.invalid-input] bindingId must be "linear:<project_id>"; push drives one Linear binding`);
  }
  return bindingId.slice(prefix.length);
}

/**
 * The mstar-owned correlation marker. Application identity only: no token, no
 * path, nothing that exists solely on this machine.
 */
export function correlationMarker(binding: PushBinding, storeId: string, localId: string): string {
  const parts = [binding.workspace, binding.team, storeId, localId].filter((part) => part.trim() !== "");
  return `<!-- mstar-sync: ${parts.join("/")} -->`;
}

/** The marker one description carries, or null when it carries none. */
function markerIn(description: string): string | null {
  const match = /<!--\s*mstar-sync:\s*([^\n]*?)\s*-->/.exec(description);
  return match === null ? null : `<!-- mstar-sync: ${match[1]!.trim()} -->`;
}

/**
 * The normalized payload's hash: the skip rule's storage. Content only — the
 * removal instruction is an ownership fact, not remote content, so it is not
 * part of what "the remote already says this" means.
 */
export function requestHash(payload: ProviderWritePayload): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        payload.title,
        payload.description,
        payload.priority,
        payload.state,
        payload.labels ?? [],
      ]),
    )
    .digest("hex");
}

/** Markdown description: the two local sections that have no remote field, then the marker. */
function descriptionFor(candidate: PushCandidate, marker: string): string {
  return `## Impact\n\n${candidate.impact}\n\n## Acceptance\n\n${candidate.acceptance}\n\n${marker}`;
}

/**
 * Push one item and record exactly what the receipt proved.
 *
 * Ledger protocol (contract §"Ledger protocol"), by the row's state:
 * - no row → `claimItem` (pending, send right) → create
 * - `failed` without an id → claim the retry, then create (only a refusal or a
 *   pre-send refusal writes `failed`, so delivery was never confirmed)
 * - `pending` without an id → ambiguous residue: reconcile first; without an
 *   adoption this run reports `unresolved` and NEVER creates. This guard runs
 *   BEFORE any current-attempt preflight: a label failure now says nothing
 *   about whether the earlier request was delivered.
 * - `applied` with an id and an equal hash → `skipped`, zero write calls
 * - otherwise (an id exists) → update
 */
export async function pushItem(db: StoreDb, provider: IssueProvider, context: PushContext, candidate: PushCandidate): Promise<PushOutcome> {
  const ledger = readItem(db, { bindingId: context.bindingId, direction: PUSH_DIRECTION, localId: candidate.localId });
  const externalId = ledger?.externalId ?? null;
  // A `pending` row with no id is the residue of a create nobody confirmed. Its
  // state is the ONLY record that a remote issue may exist, so a refusal later
  // in this attempt must not consume it (see `failed`).
  const ambiguousResidue = externalId === null && ledger?.itemState === "pending";
  if (ambiguousResidue && !context.forceCreate) {
    // An ambiguous create from an earlier run. Adopting it is reconcile's job;
    // creating again could duplicate the remote issue, which is the one thing
    // this direction must never do. Checked before the label preflight so a
    // preflight failure for THIS attempt cannot erase a historical ambiguity.
    return {
      localId: candidate.localId,
      outcome: "unresolved",
      externalId: null,
      cause: "a previous create was never confirmed; the item awaits marker reconciliation (or an explicit --adopt / --force-create)",
    };
  }
  const marker = correlationMarker(context.binding, context.storeId, candidate.localId);
  const fields = providerPayloadFields(candidate, context.mapping);
  // Both mapped names are resolved against what the workspace HAS, before the
  // call. Push never creates a provider label or state, so an absent name
  // refuses this item only — and a renamed workflow state is diagnosed here
  // instead of failing every item at the provider.
  if (!context.states.has(fields.state)) {
    // The mapping key is the DEFAULT REMOTE name (`Canceled`), not the local
    // disposition: that is the key `stateOfDisposition` reads. `waived`,
    // `duplicate` and `superseded` all collapse onto it, so the message says so
    // instead of naming a key nobody reads.
    const mappingKey = defaultStateOfDisposition(candidate.disposition);
    return failed(
      db,
      context,
      candidate.localId,
      "linear.state-unresolved",
      `the team has no workflow state named ${JSON.stringify(fields.state)}; push never creates states. Create or rename it in Linear's workflow settings, or redirect it through [linear.mapping] disposition.${mappingKey}=<name>${mappingKey === candidate.disposition ? "" : ` (keyed by the default target, which ${candidate.disposition} maps to)`}.`,
      ledger,
      undefined,
      ambiguousResidue,
    );
  }
  if (!context.labels.has(fields.label)) {
    return failed(
      db,
      context,
      candidate.localId,
      "linear.label-unresolved",
      `the workspace has no label named ${JSON.stringify(fields.label)}; push never creates labels. Create it in Linear's UI, or redirect it through [linear.mapping] kind.${candidate.kind}=<name>.`,
      ledger,
      undefined,
      ambiguousResidue,
    );
  }
  const payload: ProviderWritePayload = {
    title: candidate.title,
    description: descriptionFor(candidate, marker),
    priority: fields.priority,
    state: fields.state,
    labels: [fields.label],
  };
  const hash = requestHash(payload);

  if (externalId !== null) {
    if (ledger?.itemState === "applied" && ledger.lastRequestHash === hash) {
      // The skip rule: nothing changed locally since the last confirmed write,
      // so the ledger is not touched at all.
      return { localId: candidate.localId, outcome: "skipped", externalId };
    }
    // A changed kind replaces EXACTLY the labels this tool may own. An
    // unconfirmed earlier update can leave more than one of them on the remote,
    // so every recorded label except the desired one is removed (removing an
    // absent label is a no-op). Unknown ownership (none recorded) only adds.
    const recorded = ledger?.lastKindLabels ?? [];
    const stale = recorded.filter((label) => label !== fields.label);
    if (stale.length > 0) payload.removeLabels = stale;
    return apply(db, provider, context, candidate.localId, { kind: "update", externalId, payload }, hash, fields.label, ledger, ambiguousResidue);
  }

  // No row, a retryable failure, or an operator-confirmed absence: this is a
  // create. Intent is recorded BEFORE the write so an ambiguous result leaves a
  // durable residue to reconcile against. An existing `pending` row already
  // states that intent (and `planItem` has no edge from it), so it is reused —
  // which is also what lets `--force-create` proceed past the guard above.
  //
  // The claim is what separates "I now hold the send right" from "someone else
  // already took it for this exact content and revision": an idempotent replay
  // returns the historical receipt, which two concurrent runs both treated as
  // permission to create. A caller that did not WIN the claim sends nothing.
  const entryRevision = ledger?.revision ?? 0;
  if (ledger === null || ledger.itemState === "failed") {
    const claim = claimItem(db, {
      bindingId: context.bindingId,
      direction: PUSH_DIRECTION,
      localId: candidate.localId,
      operationId: `linear-push:${context.bindingId}:${candidate.localId}:plan:${hash}:${entryRevision}`,
    });
    if (!claim.claimed) {
      return {
        localId: candidate.localId,
        outcome: "unresolved",
        externalId: claim.item.externalId,
        cause: "another push already claimed this create for the same content and revision; this attempt sent nothing and the ledger's row decides the outcome",
      };
    }
  }
  return apply(db, provider, context, candidate.localId, { kind: "create", payload }, hash, fields.label, ledger, ambiguousResidue);
}

/** Send one write and record its classification; the row's identity comes only from `confirmed`. */
async function apply(
  db: StoreDb,
  provider: IssueProvider,
  context: PushContext,
  localId: string,
  write: ProviderWrite,
  hash: string,
  kindLabel: string,
  ledger: SyncItem | null,
  ambiguousResidue: boolean,
): Promise<PushOutcome> {
  const entryRevision = ledger?.revision ?? 0;
  const opId = (step: string): string => `linear-push:${context.bindingId}:${localId}:${step}:${hash}:${entryRevision}`;
  const receipt = await provider.applyWrite(write);

  if (receipt.kind === "refused") {
    // Provably not delivered: safe to retry, so it is written as `failed`. The
    // row is re-read because a create's intent was just planned above.
    const current = readItem(db, { bindingId: context.bindingId, direction: PUSH_DIRECTION, localId }) ?? ledger;
    return failed(db, context, localId, receipt.code, receipt.cause, current, hash, ambiguousResidue);
  }
  if (receipt.kind === "ambiguous") {
    if (write.kind === "create") {
      // Deliberately NO ledger write: the row keeps its (absent) identity as
      // `pending` residue, and the next run decides by marker, never by guesswork.
      return { localId, outcome: "unresolved", externalId: null, cause: receipt.cause };
    }
    // An update the remote did not confirm: the identity stands, but the payload
    // proof does not. Dropping the hash is what stops the next pass from
    // reporting `skipped` off a fact that predates this write; the label this
    // write may have applied becomes the ownership a corrective update replaces.
    markUnconfirmed(db, {
      bindingId: context.bindingId,
      direction: PUSH_DIRECTION,
      localId,
      kindLabel,
      operationId: opId("unconfirmed"),
    });
    return { localId, outcome: "unresolved", externalId: ledger?.externalId ?? null, cause: receipt.cause };
  }
  markApplied(db, {
    bindingId: context.bindingId,
    direction: PUSH_DIRECTION,
    localId,
    externalId: receipt.externalId,
    remoteUpdatedAt: receipt.updatedAt,
    requestHash: hash,
    kindLabel,
    operationId: opId("applied"),
  });
  return { localId, outcome: write.kind === "create" ? "created" : "updated", externalId: receipt.externalId };
}

/**
 * Record a refusal (or a pre-send refusal) on the item.
 *
 * Best-effort by design: the run's report is the record of what happened, and a
 * ledger refusal here must not mask the cause that produced it. Only a genuine
 * ledger conflict reaches the catch now that every state takes a legal verb.
 *
 * Two rows must NOT take the `failed` edge, and both use `recordRefusal`, which
 * writes the error and nothing else:
 * - `ambiguousResidue`: a `pending` row with no id is an unattributed remote
 *   issue, and `failed` is invisible to `reconcilePendingCreate`. Downgrading it
 *   would let the next run create a duplicate nobody can adopt.
 * - any row that already holds an identity or a settled state (`applied`,
 *   `failed`, `skipped`): `applied → failed` is not in the contract, and the row's
 *   identity, hash and ownership are facts an earlier confirmed write proved. A
 *   refused UPDATE therefore leaves the row `applied` WITH its cause recorded,
 *   and the changed hash still makes the next run retry the write.
 */
function failed(
  db: StoreDb,
  context: PushContext,
  localId: string,
  code: string,
  cause: string,
  ledger: SyncItem | null,
  hash?: string,
  ambiguousResidue = false,
): PushOutcome {
  const message = `[${code}] ${cause}`;
  try {
    // An item that never reached the ledger still gets a row here, so the
    // operator can SEE why it is not pushed; `failed → pending` is a legal retry
    // edge, so the next run tries again once the cause is addressed.
    if (ledger === null) {
      planItem(db, {
        bindingId: context.bindingId,
        direction: PUSH_DIRECTION,
        localId,
        operationId: `linear-push:${context.bindingId}:${localId}:plan:preflight`,
      });
    }
    const current = ledger ?? readItem(db, { bindingId: context.bindingId, direction: PUSH_DIRECTION, localId });
    if (current !== null) {
      // `markFailed` is the retry edge and is legal only from `pending`.
      const retryable = !ambiguousResidue && current.itemState === "pending";
      const step = retryable ? "failed" : "refused";
      const operationId = `linear-push:${context.bindingId}:${localId}:${step}:${hash ?? "preflight"}:${current.revision}`;
      const input = { bindingId: context.bindingId, direction: PUSH_DIRECTION, localId, operationId };
      if (retryable) markFailed(db, { ...input, error: message });
      else recordRefusal(db, { ...input, error: message });
    }
  } catch {
    // The returned outcome still carries the cause.
  }
  return { localId, outcome: "failed", externalId: ledger?.externalId ?? null, cause: message };
}

export type ReconcileReport = {
  /** Rows adopted this run, with the identity marker equality proved. */
  adopted: Array<{ localId: string; externalId: string }>;
  /** Rows that could not be attributed to exactly one remote issue. */
  unresolved: Array<{ localId: string; cause: string }>;
};

/**
 * Adopt ambiguous creates by correlation marker.
 *
 * Runs a full listing scan and adopts a row ONLY when exactly one remote issue
 * carries its exact marker. Zero or several matches stay `unresolved`; this
 * function never creates, and prose equality is never evidence.
 *
 * A run with no ambiguous residue short-circuits: zero listing calls.
 */
export async function reconcilePendingCreate(
  db: StoreDb,
  provider: IssueProvider,
  context: PushContext,
): Promise<ReconcileReport> {
  const pending = db
    .prepare(
      "select local_id from issue_sync_state where binding_id = ? and direction = ? and item_state = 'pending' and external_id is null",
    )
    .all(context.bindingId, PUSH_DIRECTION) as Array<{ local_id: string }>;
  const report: ReconcileReport = { adopted: [], unresolved: [] };
  if (pending.length === 0) return report;

  const wanted = new Map<string, string>();
  for (const { local_id: localId } of pending) {
    wanted.set(correlationMarker(context.binding, context.storeId, localId), localId);
  }
  const matches = new Map<string, string[]>();
  let cursor: string | null = null;
  do {
    const page = await provider.listIssues(cursor);
    for (const item of page.items) {
      const marker = markerIn(item.description);
      if (marker === null) continue;
      const localId = wanted.get(marker);
      if (localId === undefined) continue;
      matches.set(localId, [...(matches.get(localId) ?? []), item.externalId]);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);

  for (const { local_id: localId } of pending) {
    const found = matches.get(localId) ?? [];
    if (found.length !== 1) {
      report.unresolved.push({
        localId,
        cause:
          found.length === 0
            ? "no remote issue carries this item's correlation marker; the interrupted create is not confirmed either way"
            : `${found.length} remote issues carry this item's correlation marker; adopting any of them would be a guess`,
      });
      continue;
    }
    const externalId = found[0]!;
    markApplied(db, {
      bindingId: context.bindingId,
      direction: PUSH_DIRECTION,
      localId,
      externalId,
      operationId: `linear-push:${context.bindingId}:${localId}:adopt:${externalId}`,
    });
    report.adopted.push({ localId, externalId });
  }
  return report;
}

/**
 * Operator-confirmed adoption (`--adopt <localId>=<issueUrl|externalId>`): the
 * row takes the identity verbatim and FORGETS the proof that belonged to any
 * previous identity.
 *
 * An existing row's payload hash and label ownership describe the issue that row
 * pointed at. Carrying them onto a DIFFERENT issue makes the skip rule match
 * content the new remote never received (the run would report `skipped` without
 * writing) and lets a later kind change remove a label recorded for the previous
 * issue. So a changed identity clears both, and content converges on the next
 * push of the same run. Re-confirming the id already recorded is not a change:
 * that hash and that ownership still describe the same remote issue, so they
 * stay — clearing them would let the update add the new kind label while leaving
 * the recorded one behind, unowned and unremovable.
 *
 * Replacing an ESTABLISHED identity is refused unless the operator forces it
 * (`--force-adopt`): the recorded id is a fact an earlier confirmed write proved,
 * and a mistaken edit would silently leave that remote issue behind.
 *
 * The existing row decides the composition, because the ambiguous residue this
 * recovery exists for is a `pending` row and `planItem` has no edge from
 * `pending`:
 * - absent or retryable (`failed`) → `planItem` opens the cycle, then `markApplied`
 *   closes it;
 * - already `pending` or `applied` → the confirmed identity is applied directly.
 */
export function adoptItem(
  db: StoreDb,
  bindingId: string,
  localId: string,
  reference: string,
  options: { force?: boolean } = {},
): SyncItem {
  const externalId = externalIdOf(reference);
  const existing = readItem(db, { bindingId, direction: PUSH_DIRECTION, localId });
  if (existing !== null && existing.externalId !== null && existing.externalId !== externalId && options.force !== true) {
    throw new SyncError(
      "sync.identity-conflict",
      `this item is already adopted as ${JSON.stringify(existing.externalId)}, and replacing an established remote identity is not an ordinary edit. Re-run with --force-adopt ${localId} if ${JSON.stringify(externalId)} is the right issue; nothing was written.`,
    );
  }
  // The row's revision is the generation this adoption is applied OVER, and it
  // joins the operation id. Going back to an issue this row held earlier repeats
  // every other fact of the adoption that first recorded it (same binding, local
  // id, external id, `clearProof`), so without it that receipt is replayed —
  // `markApplied` never runs and the row stays on the id being replaced while the
  // caller reports the new one. The revision advances on every apply, so each
  // re-point is a distinct operation.
  const generation = existing?.revision ?? 0;
  if (existing === null || existing.itemState === "failed") {
    planItem(db, {
      bindingId,
      direction: PUSH_DIRECTION,
      localId,
      externalId,
      operationId: `linear-push:${bindingId}:${localId}:adopt-plan:${externalId}:${generation}`,
    });
  }
  // Re-confirming the recorded id is not an identity change: its hash and label
  // ownership still describe this same remote issue.
  const keepProof = existing?.externalId === externalId;
  return markApplied(db, {
    bindingId,
    direction: PUSH_DIRECTION,
    localId,
    externalId,
    // Cleared, not carried: see the docstring above. `clearProof` is the only
    // way to say "this identity has no proof yet", because an omitted hash
    // means "keep the row's".
    ...(keepProof ? {} : { clearProof: true as const }),
    // A confirm and a re-point are different requests, so they cannot share one
    // receipt; re-reading the SAME receipt would refuse the second as a conflict.
    // Only a re-point needs the generation: going back to an issue this row held
    // earlier repeats every other fact of the adoption that first recorded it.
    operationId: `linear-push:${bindingId}:${localId}:${keepProof ? "adopt-confirm" : "adopt-apply"}:${externalId}${keepProof ? "" : `:${generation}`}`,
  });
}

/**
 * A `linear.app` issue URL's last path segment is the identifier; anything else
 * is taken verbatim. A URL from another host is refused rather than mined for a
 * guess.
 */
export function externalIdOf(reference: string): string {
  const raw = reference.trim();
  if (raw === "") {
    throw new Error("[sync.invalid-input] the adopted reference is empty; pass <localId>=<issueUrl|externalId>");
  }
  if (!/^https?:\/\//i.test(raw)) return raw;
  const url = new URL(raw);
  if (url.hostname !== "linear.app" && !url.hostname.endsWith(".linear.app")) {
    throw new Error(`[sync.invalid-input] ${url.hostname} is not a Linear host; pass a linear.app issue URL or the issue identifier`);
  }
  // A Linear issue URL is `/<workspace>/issue/<identifier>/<slug…>`: the
  // identifier follows `issue`, and the trailing slug is not it.
  const segments = url.pathname.split("/").filter((part) => part !== "");
  const issueAt = segments.indexOf("issue");
  const identifier = issueAt === -1 ? undefined : segments[issueAt + 1];
  if (identifier === undefined) {
    throw new Error(`[sync.invalid-input] ${raw} is not a Linear issue URL (expected /<workspace>/issue/<identifier>/...); pass the issue identifier instead`);
  }
  return identifier;
}
