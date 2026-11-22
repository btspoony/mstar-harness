/**
 * note: The strict JSON document shapes the remote/outbox `--input` flags carry, declared
 * here so `mstar schema --command <id>` publishes them (`payloadSchemas`) and the option
 * help can name the document per verb. This module is the ONE owner of those shapes: the
 * frozen event, its project/issue subject and every history row are typed members taken from
 * the engine's own vocabularies, never loose maps, so discovery describes the document the
 * engine actually accepts. The engine's DTO validators stay the runtime authority, and this
 * module never enforces what only the engine can judge (frozen-event equality, capability
 * proof, scope freshness, a semantic key's quality, portable-text fidelity).
 *
 * The descriptor key `inputDocument` deliberately names no input field: the CLI value of
 * `--input` stays a file path (or `-` for stdin), so composition and payload decoding
 * have nothing to reshape and only discovery sees the schema.
 */
import {
  ISSUE_DISPOSITIONS,
  ISSUE_KINDS,
  ISSUE_PROVENANCE_KINDS,
  ISSUE_RELATIONS,
  ISSUE_SEVERITIES,
} from "@mstar-harness/engine";
import { z } from "zod";

const gitObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "a Git object id");
const providerId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "a lowercase UUID");
const rfc3339 = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, "a UTC RFC 3339 instant");
const sha256Digest = z.string().regex(/^[0-9a-f]{64}$/, "a canonical lowercase SHA-256 digest");
const issueRef = z.string().regex(/^mstar:issue:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "a portable mstar:issue:<uuid> reference");

const providerScope = z.object({
  provider: z.literal("linear"),
  workspaceId: providerId,
  teamId: providerId,
  projectId: providerId,
}).strict();

const providerIssueIdentity = providerScope.extend({ issueId: providerId });

const scopeCapabilities = z.object({
  fullRead: z.boolean(),
  appendOnly: z.boolean(),
  exactLookup: z.boolean(),
  fieldFidelity: z.boolean(),
  privateAudience: z.boolean(),
}).strict();

const scopeOutcome = z.union([
  z.object({
    kind: z.literal("verified"),
    readerId: z.string(),
    writerId: z.string().nullable(),
    capabilities: scopeCapabilities,
  }).strict(),
  z.object({ kind: z.enum(["unavailable", "scope-mismatch", "denied", "revoked", "unsafe-fidelity"]) }).strict(),
]);

const scopeCheck = z.object({
  projectId: z.string(),
  scope: providerScope,
  journalIssueId: providerId,
  checkedAt: rfc3339,
  outcome: scopeOutcome,
}).strict();

/** `fields`: exactly the contract's domain fields, from the issue module's own vocabularies. */
const mstarSubjectFields = z.object({
  title: z.string(),
  kind: z.enum(ISSUE_KINDS),
  severity: z.enum(ISSUE_SEVERITIES),
  disposition: z.enum(ISSUE_DISPOSITIONS),
  impact: z.string(),
  acceptance: z.string(),
  owner: z.string().nullish(),
  registeredAt: rfc3339.nullish(),
  closedAt: rfc3339.nullish(),
  closureNote: z.string().nullish(),
  createdAt: rfc3339,
  updatedAt: rfc3339,
  revision: z.number().int().positive(),
  milestoneId: z.string().nullish(),
}).strict();

/** note: One occurrence row: its business fields plus a stable event UUID, never a row id. */
const occurrenceRecord = z.object({
  eventId: providerId.describe("the history row's stable event UUID"),
  occurrenceKey: z.string(),
  sourceKind: z.string(),
  sourceIdentity: z.string(),
  rootCauseKey: z.string(),
  acceptanceKey: z.string(),
  location: z.string(),
  observedBehavior: z.string(),
  evidence: z.array(z.string()),
  discoveredAt: rfc3339.nullish(),
  recordedAt: rfc3339,
  imported: z.boolean(),
}).strict();

/** note: The closure document a non-imported transition records; every member is optional. */
const closureEvidence = z.object({
  reason: z.string().nullish(),
  scope: z.string().nullish(),
  references: z.array(z.string()).optional(),
  canonicalIssueId: z.string().nullish(),
  alignmentRef: z.string().nullish(),
}).strict();

/** note: The reviewed portable legacy register row, under either spelling the engine accepts. */
const importedRecordSpellings = [
  "legacyId", "id",
  "title",
  "severity",
  "source",
  "scope",
  "decision",
  "owner",
  "target",
  "tracking",
  "detailDoc", "detail_doc",
  "lifecycle",
  "closedAt", "closed_at",
  "closureNote", "closure_note",
  "closureEvidence", "closure_evidence",
  "supersededBy", "superseded_by",
  "sourcePlan", "source_plan",
  "registeredAt", "registered_at",
] as const;

const importedRecord = z
  .object(Object.fromEntries(importedRecordSpellings.map((key) => [key, z.string().nullish()])))
  .strict()
  .refine((record) => Object.keys(record).length > 0, "must carry the imported record's business fields")
  .describe(
    "the reviewed portable legacy register row: one spelling per field, and at least one field",
  );

const transitionRecord = z.object({
  eventId: providerId.describe("the history row's stable event UUID"),
  fromDisposition: z.enum(ISSUE_DISPOSITIONS),
  toDisposition: z.enum(ISSUE_DISPOSITIONS),
  actor: z.string().nullish(),
  occurredAt: rfc3339.nullish(),
  recordedAt: rfc3339,
  reason: z.string(),
  evidence: z
    .union([closureEvidence, importedRecord])
    .describe("the closure document normally; the reviewed legacy register row when imported is true"),
  issueRevision: z.number().int().nonnegative(),
  imported: z.boolean(),
}).strict();

/** note: A dangling target stays as the spellable reference; the read boundary renders it unresolved. */
const relationRecord = z.object({
  relation: z.enum(ISSUE_RELATIONS),
  target: issueRef,
}).strict();

const provenanceKinds = [...ISSUE_PROVENANCE_KINDS, "capture", "migration"] as const;

/** note: Provenance never carries the raw legacy JSON: `legacyJson` is parsed into `legacyRecord` by the engine. */
const provenanceRecord = z.object({
  eventId: providerId.describe("the history row's stable event UUID"),
  kind: z.enum(provenanceKinds),
  target: z.string(),
  sourceHash: sha256Digest,
  origin: z.enum(["scoped", "unscoped"]),
  legacyProject: z.string().nullish(),
  legacyBucket: z.string().nullish(),
  legacyEntryId: z.string().nullish(),
  legacyJson: z.string().nullish().describe("the legacy row's JSON text; mutually exclusive with legacyRecord"),
  legacyRecord: importedRecord.nullish(),
  importedAt: rfc3339.nullish(),
}).strict();

const projectMoveRecord = z.object({
  eventId: providerId.describe("the history row's stable event UUID"),
  fromProject: z.string(),
  toProject: z.string(),
  actor: z.string(),
  reason: z.string(),
  occurredAt: rfc3339,
  issueRevision: z.number().int().nonnegative(),
}).strict();

/** note: The six members every complete subject carries; each list is that member's typed history. */
const subjectHistory = {
  occurrences: z.array(occurrenceRecord),
  transitions: z.array(transitionRecord),
  relations: z.array(relationRecord),
  provenance: z.array(provenanceRecord),
  projectMoves: z.array(projectMoveRecord),
};

/** note: The event's issue subject: the complete normalized document minus the derived `head`. */
const issueSubject = z.object({ fields: mstarSubjectFields, ...subjectHistory }).strict();

/**
 * note: The complete portable subject a snapshot carries: exactly the shape the engine's
 * `mstarIssue` parser requires, `fields` included, so the descriptor accepts every marked
 * observation the runtime accepts.
 */
const portableSubject = z
  .object({ issueRef, head: z.array(sha256Digest), fields: mstarSubjectFields, ...subjectHistory })
  .strict()
  .describe("the complete portable subject the snapshot carries");

const remoteIssue = z
  .object({
    identity: providerIssueIdentity,
    nativeTitle: z.string(),
    nativeStatus: z.string(),
    providerUpdatedAt: rfc3339,
    mstar: portableSubject.nullable(),
  })
  .strict();

const milestoneDocument = z.object({
  milestoneId: z.string(),
  name: z.string(),
  target: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a YYYY-MM-DD date").nullable(),
  status: z.enum(["planned", "active", "delivered", "dropped"]),
  ordinal: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  createdAt: rfc3339,
  updatedAt: rfc3339,
}).strict();

const roadmapDocument = z.object({ contentMarkdown: z.string(), revision: z.number().int().positive(), updatedAt: rfc3339 }).strict();

const catalogEntityDocument = z.object({
  kind: z.enum(["project", "iteration", "plan", "document"]),
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  documentKind: z.string().nullable(),
  lifecycle: z.enum(["active", "archived", "superseded"]),
  revision: z.number().int().positive(),
}).strict();

const catalogLinkDocument = z.object({
  fromKind: z.enum(["project", "iteration", "plan", "document"]),
  fromId: z.string(),
  relation: z.enum(["belongs-to", "documents", "spec-ref", "knowledge-ref", "derived-from", "supersedes"]),
  toKind: z.enum(["project", "iteration", "plan", "document"]),
  toId: z.string(),
  ordinal: z.number().int().nonnegative().nullable(),
}).strict();

const projectDocument = z.object({
  projectId: z.string(),
  milestones: z.array(milestoneDocument),
  roadmap: roadmapDocument.nullable(),
  catalogEntities: z.array(catalogEntityDocument),
  catalogLinks: z.array(catalogLinkDocument),
}).strict();

const remoteSnapshot = z
  .object({
    asOf: rfc3339,
    coverage: z.union([
      z.object({ kind: z.literal("complete") }).strict(),
      z.object({
        kind: z.literal("partial"),
        stream: z.enum(["issues", "comments", "journal"]),
        nextCursor: z.string().nullable(),
        code: z.string(),
      }).strict(),
    ]),
    project: projectDocument.extend({ head: z.array(sha256Digest).nullable(), binding: providerScope }).strict(),
    issues: z.array(remoteIssue),
  })
  .strict();

/**
 * note: The frozen event the host appends. `change` closes both arms: a project replacement
 * carries the project document (no derived `head`, no `binding`), and every issue change
 * carries the complete typed subject. A replacement cites the heads it replaces; that
 * minimum is the engine's judgement on the event it freezes.
 */
const frozenEvent = z
  .object({
    version: z.literal(1),
    repoKey: z.string(),
    projectId: z.string(),
    operationId: providerId,
    parents: z.array(sha256Digest).describe("sorted unique content digests of the heads this event replaces"),
    change: z.union([
      z.object({ kind: z.literal("project-replace"), project: projectDocument }).strict(),
      z
        .object({
          kind: z.enum(["issue-create", "issue-adopt", "issue-replace"]),
          issueRef,
          mstar: issueSubject,
        })
        .strict(),
    ]),
  })
  .strict();

/** `remote bind --input`: one verification batch over the checked selector generation. */
export const remoteBindDocumentSchema = z
  .object({
    version: z.literal(1),
    selectorCommit: gitObjectId,
    generation: z.number().int().positive(),
    checks: z.array(scopeCheck),
  })
  .strict();

/** `remote observe --input`: one verification plus at most one whole-project snapshot. */
export const remoteObserveDocumentSchema = z
  .object({
    version: z.literal(1),
    selectorCommit: gitObjectId,
    generation: z.number().int().positive(),
    check: scopeCheck,
    expectRevision: z.number().int().nonnegative(),
    snapshot: remoteSnapshot.nullable(),
  })
  .strict();

/** `remote adopt-issue --input`: a `new` capture (title/project come from the provider) or a `retain` subject. */
export const remoteAdoptionDocumentSchema = z
  .union([
    z
      .object({
        version: z.literal(1),
        kind: z.literal("new"),
        capture: z
          .object({
            kind: z.enum(ISSUE_KINDS),
            severity: z.enum(ISSUE_SEVERITIES),
            impact: z.string(),
            acceptance: z.string(),
            owner: z.string().optional(),
            sourceIdentity: z.string(),
            rootCauseKey: z.string(),
            acceptanceKey: z.string(),
            occurrenceKey: z.string(),
            sourceKind: z.string(),
            location: z.string(),
            observedBehavior: z.string(),
            evidence: z.array(z.string()),
            discoveredAt: z.string(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        version: z.literal(1),
        kind: z.literal("retain"),
        sourceIssue: z
          .object({ issueRef, fields: mstarSubjectFields, ...subjectHistory })
          .strict()
          .describe("the reviewed complete MStar subject (no head: that is an event-chain fact)"),
      })
      .strict(),
  ]);

const confirmedOutcome = z
  .object({ kind: z.literal("confirmed"), identity: providerIssueIdentity, recordId: providerId, event: frozenEvent })
  .strict();

const unconfirmedOutcome = z
  .object({ kind: z.literal("unconfirmed"), reason: z.enum(["no-response", "not-found", "ambiguous", "provider-unavailable"]) })
  .strict();

const conflictOutcome = z
  .object({
    kind: z.literal("conflict"),
    expectedHeads: z.array(sha256Digest),
    observedHeads: z.array(sha256Digest),
    observedRecords: z.array(z.object({ identity: providerIssueIdentity, recordId: providerId, event: frozenEvent }).strict()),
  })
  .strict();

const notSentOutcome = z.object({ kind: z.literal("not-sent"), code: z.string() }).strict();

const receiptEnvelopeFields = {
  version: z.literal(1),
  selectorCommit: gitObjectId,
  generation: z.number().int().positive(),
  projectId: z.string(),
  operationId: providerId,
  attemptId: providerId,
  requestHash: sha256Digest,
  observedAt: rfc3339,
};

/** `outbox-receipt --input`: the envelope plus one outcome arm, `not-sent` included. */
export const remoteReceiptDocumentSchema = z
  .object({
    ...receiptEnvelopeFields,
    outcome: z.union([confirmedOutcome, unconfirmedOutcome, conflictOutcome, notSentOutcome]),
  })
  .strict();

/**
 * `outbox-reconcile --input`: read-only recovery evidence under the attempt's original binding.
 * A reconciliation reports what a lookup SAW, so its document has no `not-sent` arm at all:
 * only the original host's own receipt can prove an attempt was never sent.
 */
export const remoteReconcileDocumentSchema = z
  .object({
    ...receiptEnvelopeFields,
    outcome: z.union([confirmedOutcome, unconfirmedOutcome, conflictOutcome]),
  })
  .strict();

/** `outbox-resolve --input`: the reviewed replacement of one conflicted intent. */
export const remoteResolutionDocumentSchema = z
  .object({
    operationId: providerId,
    operator: z.string(),
    reason: z.string(),
    event: frozenEvent.describe(
      "the replacement event in the frozen event's own shape, with a NEW operation id and parents citing every fork head",
    ),
  })
  .strict();

/** `outbox-dispatch --input`: the host-attested fork traversal a reviewed resolution's dispatch must carry. */
export const remoteForkObservationDocumentSchema = z
  .object({
    version: z.literal(1),
    selectorCommit: gitObjectId,
    generation: z.number().int().positive(),
    projectId: z.string(),
    conflictOperationId: providerId,
    asOf: rfc3339,
    coverage: z.literal("complete"),
    heads: z
      .array(z.object({ recordId: providerId, issueRef, head: sha256Digest }).strict())
      .min(1),
  })
  .strict();
