/**
 * note: The strict JSON document shapes the remote/outbox `--input` flags carry, declared
 * here so `mstar schema --command <id>` publishes them (`payloadSchemas`) and the option
 * help can name the document per verb. These are the TRANSPORT description: the engine's
 * DTO validators stay the runtime authority, and this module never enforces what only
 * the engine can judge (frozen-event equality, capability proof, scope freshness).
 *
 * The descriptor key `inputDocument` deliberately names no input field: the CLI value of
 * `--input` stays a file path (or `-` for stdin), so composition and payload decoding
 * have nothing to reshape and only discovery sees the schema.
 */
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

const subjectRecord = z
  .record(z.string(), z.unknown())
  .describe("one history row: its business fields plus a stable event UUID, validated field-by-field by the engine");

const portableSubject = z
  .object({
    issueRef,
    head: z.array(sha256Digest),
    fields: z.record(z.string(), z.unknown()).describe("the issue's domain fields (title, kind, severity, disposition, impact, acceptance, owner, registeredAt, closedAt, closureNote, createdAt, updatedAt, revision, milestoneId)"),
    occurrences: z.array(subjectRecord),
    transitions: z.array(subjectRecord),
    relations: z.array(subjectRecord),
    provenance: z.array(subjectRecord),
    projectMoves: z.array(subjectRecord),
  })
  .strict()
  .describe("the complete portable subject the engine validates field-by-field");

const remoteIssue = z
  .object({
    identity: providerIssueIdentity,
    nativeTitle: z.string(),
    nativeStatus: z.string(),
    providerUpdatedAt: rfc3339,
    mstar: portableSubject.nullable(),
  })
  .strict();

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
    project: z
      .object({
        projectId: z.string(),
        head: z.array(sha256Digest).nullable(),
        binding: providerScope,
        milestones: z
          .array(
            z
              .object({
                milestoneId: z.string(),
                name: z.string(),
                target: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a YYYY-MM-DD date").nullable(),
                status: z.enum(["planned", "active", "delivered", "dropped"]),
                ordinal: z.number().int().nonnegative(),
                revision: z.number().int().positive(),
                createdAt: rfc3339,
                updatedAt: rfc3339,
              })
              .strict(),
          ),
        roadmap: z.object({ contentMarkdown: z.string(), revision: z.number().int().positive(), updatedAt: rfc3339 }).strict().nullable(),
        catalogEntities: z.array(
          z
            .object({
              kind: z.enum(["project", "iteration", "plan", "document"]),
              id: z.string(),
              title: z.string(),
              description: z.string().nullable(),
              documentKind: z.string().nullable(),
              lifecycle: z.enum(["active", "archived", "superseded"]),
              revision: z.number().int().positive(),
            })
            .strict(),
        ),
        catalogLinks: z.array(
          z
            .object({
              fromKind: z.enum(["project", "iteration", "plan", "document"]),
              fromId: z.string(),
              relation: z.enum(["belongs-to", "documents", "spec-ref", "knowledge-ref", "derived-from", "supersedes"]),
              toKind: z.enum(["project", "iteration", "plan", "document"]),
              toId: z.string(),
              ordinal: z.number().int().nonnegative().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
    issues: z.array(remoteIssue),
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
            kind: z.enum(["bug", "risk", "improvement", "request", "decision", "review-obligation"]),
            severity: z.enum(["critical", "high", "medium", "low", "nit"]),
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
          .object({
            issueRef,
            fields: z.record(z.string(), z.unknown()),
            occurrences: z.array(z.record(z.string(), z.unknown())),
            transitions: z.array(z.record(z.string(), z.unknown())),
            relations: z.array(z.record(z.string(), z.unknown())),
            provenance: z.array(z.record(z.string(), z.unknown())),
            projectMoves: z.array(z.record(z.string(), z.unknown())),
          })
          .strict()
          .describe("the reviewed complete MStar subject (no head: that is an event-chain fact)"),
      })
      .strict(),
  ]);

const frozenEvent = z
  .record(z.string(), z.unknown())
  .describe("the exact provider event the caller decoded back, in the frozen event's own shape (version, repoKey, projectId, operationId, parents, change)");

/** `outbox-receipt` / `outbox-reconcile --input`: the envelope plus one outcome arm. */
export const remoteReceiptDocumentSchema = z
  .object({
    version: z.literal(1),
    selectorCommit: gitObjectId,
    generation: z.number().int().positive(),
    projectId: z.string(),
    operationId: providerId,
    attemptId: providerId,
    requestHash: sha256Digest,
    observedAt: rfc3339,
    outcome: z.union([
      z.object({ kind: z.literal("confirmed"), identity: providerIssueIdentity, recordId: providerId, event: frozenEvent }).strict(),
      z.object({ kind: z.literal("unconfirmed"), reason: z.enum(["no-response", "not-found", "ambiguous", "provider-unavailable"]) }).strict(),
      z
        .object({
          kind: z.literal("conflict"),
          expectedHeads: z.array(sha256Digest),
          observedHeads: z.array(sha256Digest),
          observedRecords: z.array(z.object({ identity: providerIssueIdentity, recordId: providerId, event: frozenEvent }).strict()),
        })
        .strict(),
      z.object({ kind: z.literal("not-sent"), code: z.string() }).strict(),
    ]),
  })
  .strict();

/** `outbox-resolve --input`: the reviewed replacement of one conflicted intent. */
export const remoteResolutionDocumentSchema = z
  .object({
    operationId: providerId,
    operator: z.string(),
    reason: z.string(),
    event: z.record(z.string(), z.unknown()).describe("the replacement event in the frozen event's own shape, with a NEW operation id and parents citing every fork head"),
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
