export type { RoadmapContent } from "./roadmap-content.js";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import {
  openCollaborationStore,
  readCollaborationObservation,
  withCollaborationWrite,
  type CompleteCollaborationObservation,
} from "./collaboration-store.js";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import {
  openRemoteReadView,
  remoteCollaborationObservation,
  remoteRoadmapRead,
} from "./collaboration-remote-read.js";
import type { RemoteIntent } from "./collaboration-remote.js";
import { type StoreContext, type StoreDb, StoreError } from "./store-db.js";
import { parseRoadmapContent, type RoadmapContent, validateRoadmapContent } from "./roadmap-content.js";

export type RoadmapExpected = number | "absent";
export type RoadmapOperation = { operationId: string; actor?: string };
export type RoadmapRecord = {
  projectId: string;
  revision: number;
  contentHash: string;
  updatedAt: string;
  contentMarkdown: string;
};
/**
 * One roadmap read. The present arm carries the read's own validated parse of
 * the stored Markdown, so a present read parses once; it is a projection of
 * `roadmap`, never a second authority and never written back.
 */
export type RoadmapRead =
  | { projectId: string; projectRevision: number; roadmap: null }
  | { projectId: string; projectRevision: number; roadmap: RoadmapRecord; content: RoadmapContent };
export type RoadmapWriteReceipt = { projectId: string; revision: number; contentHash: string; storeRevision: number };
export type RoadmapImportReview = {
  version: 1;
  projectId: string;
  expectedProjectRevision: number;
  expectedRoadmapRevision: RoadmapExpected;
  sourcePath: string;
  sourceHash: string;
};

type RoadmapErrorCode =
  | "roadmap.schema-outdated"
  | "roadmap.store-not-active"
  | "roadmap.project-not-found"
  | "roadmap.project-mismatch"
  | "roadmap.revision-conflict"
  | "roadmap.operation-conflict"
  | "roadmap.source-missing"
  | "roadmap.invalid-content"
  | "roadmap.corrupt";

export class RoadmapError extends Error {
  readonly code: RoadmapErrorCode;
  constructor(code: RoadmapErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "RoadmapError";
    this.code = code;
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function receiptFromOperation(resultJson: string): RoadmapWriteReceipt {
  const receipt = JSON.parse(resultJson) as RoadmapWriteReceipt;
  return {
    projectId: receipt.projectId,
    revision: receipt.revision,
    contentHash: receipt.contentHash,
    storeRevision: receipt.storeRevision,
  };
}

function requireActive(db: StoreDb): void {
  const row = db.prepare("select authority_state from collaboration_meta where id = 1").get() as { authority_state?: unknown } | undefined;
  if (row?.authority_state !== "active") {
    throw new RoadmapError("roadmap.store-not-active", "Roadmap access requires an active collaboration authority; staged stores are not readable or writable.");
  }
}

function projectRow(db: StoreDb, projectId: string): { revision: number } {
  const row = db.prepare("select revision from catalog_entities where kind='project' and id=?").get(projectId) as { revision?: unknown } | undefined;
  if (typeof row?.revision !== "number" || !Number.isInteger(row.revision) || row.revision < 1) {
    throw new RoadmapError("roadmap.project-not-found", `Catalog project ${projectId} does not exist.`);
  }
  return { revision: row.revision };
}

function readOn(db: StoreDb, projectId: string): RoadmapRead {
  requireActive(db);
  const project = projectRow(db, projectId);
  const row = db.prepare("select project_id, content_markdown, content_hash, revision, updated_at from project_roadmaps where project_id=?").get(projectId) as
    | { project_id: string; content_markdown: string; content_hash: string; revision: number; updated_at: string }
    | undefined;
  if (!row) return { projectId, projectRevision: project.revision, roadmap: null };
  if (row.project_id !== projectId || typeof row.content_markdown !== "string" ||
      typeof row.content_hash !== "string" || !Number.isInteger(row.revision) || row.revision < 1 ||
      typeof row.updated_at !== "string") {
    throw new RoadmapError("roadmap.corrupt", `Stored roadmap for project ${projectId} is malformed.`);
  }
  let content: RoadmapContent;
  try {
    content = parseRoadmapContent(row.content_markdown);
    if (content.frontmatter.project_id !== projectId) {
      throw new RoadmapError("roadmap.corrupt", `Stored roadmap identity does not match project ${projectId}.`);
    }
  } catch (error) {
    if (error instanceof RoadmapError) throw error;
    throw new RoadmapError("roadmap.corrupt", `Stored roadmap for project ${projectId} is invalid: ${(error as Error).message}`);
  }
  return {
    projectId,
    projectRevision: project.revision,
    roadmap: { projectId, revision: row.revision, contentHash: row.content_hash, updatedAt: row.updated_at, contentMarkdown: row.content_markdown },
    content,
  };
}

/** Read roadmap authority using a handle owned by the caller; never opens a transaction. */
export function readRoadmapAuthorityOn(db: StoreDb, projectId: string): RoadmapRead {
  return readOn(db, projectId);
}

export async function readRoadmapAuthority(
  context: StoreContext,
  projectId: string,
): Promise<RoadmapRead & { collaboration: CompleteCollaborationObservation }> {
  if (resolveCollaborationLocation(context).mode === "remote") {
    const view = await openRemoteReadView(context, [projectId]);
    // note: The project scope is validated first, so an unknown project keeps its own refusal
    // instead of surfacing as a generic incomplete observation.
    const read = remoteRoadmapRead(view, projectId);
    const collaboration = remoteCollaborationObservation(view, { kind: "project", key: projectId });
    if (collaboration.completeness !== "complete") {
      throw new StoreError(
        "collaboration.observation-incomplete",
        `The remote roadmap scope for project ${projectId} is not a complete, current observation.`,
        { projectId },
      );
    }
    return { ...read, collaboration };
  }
  const handle = await openCollaborationStore(context, "read");
  try {
    handle.db.exec("begin");
    try {
      const collaboration = readCollaborationObservation(handle, { kind: "project", key: projectId });
      const result = readOn(handle.db, projectId);
      handle.db.exec("commit");
      return { ...result, collaboration };
    } catch (error) {
      handle.db.exec("rollback");
      throw error;
    }
  } finally {
    handle.close();
  }
}

export async function listRoadmapAuthority(context: StoreContext): Promise<RoadmapRead[]> {
  if (resolveCollaborationLocation(context).mode === "remote") {
    const view = await openRemoteReadView(context);
    return view.projectIds.map((projectId) => remoteRoadmapRead(view, projectId));
  }
  const handle = await openCollaborationStore(context, "read");
  try {
    handle.db.exec("begin");
    try {
      requireActive(handle.db);
      const projects = handle.db.prepare("select id from catalog_entities where kind='project' order by id").all() as Array<{ id: string }>;
      const result = projects.map(({ id }) => readOn(handle.db, id));
      handle.db.exec("commit");
      return result;
    } catch (error) {
      handle.db.exec("rollback");
      throw error;
    }
  } finally {
    handle.close();
  }
}

function validateContent(projectId: string, content: string): void {
  if (typeof content !== "string") throw new RoadmapError("roadmap.invalid-content", "Roadmap content must be a UTF-8 string.");
  if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new TextEncoder().encode(content)) !== content) {
    throw new RoadmapError("roadmap.invalid-content", "Roadmap content contains invalid UTF-8 text.");
  }
  const result = validateRoadmapContent(content, "roadmap content");
  if (!result.ok) throw new RoadmapError("roadmap.invalid-content", `Invalid roadmap content: ${result.violations.map((item) => item.code).join(", ")}.`);
  try {
    if (parseRoadmapContent(content).frontmatter.project_id !== projectId) {
      throw new RoadmapError("roadmap.project-mismatch", `Roadmap content project_id does not match ${projectId}.`);
    }
  } catch (error) {
    if (error instanceof RoadmapError) throw error;
    throw new RoadmapError("roadmap.invalid-content", (error as Error).message);
  }
}

function canonicalSource(sourcePath: string): string {
  try {
    const stat = lstatSync(sourcePath);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("not a regular file");
    const resolved = realpathSync(sourcePath);
    if (!lstatSync(resolved).isFile()) throw new Error("not a regular file");
    return resolved;
  } catch (error) {
    throw new RoadmapError("roadmap.source-missing", `Cannot resolve a regular roadmap source file: ${(error as Error).message}`);
  }
}

function sourceBytes(sourcePath: string): { content: string; hash: string; sourcePath: string } {
  const resolved = canonicalSource(sourcePath);
  try {
    const bytes = readFileSync(resolved);
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { content, hash: sha256(bytes), sourcePath: resolved };
  } catch (error) {
    if (error instanceof RoadmapError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RoadmapError("roadmap.source-missing", `Roadmap source disappeared: ${resolved}`);
    throw new RoadmapError("roadmap.invalid-content", `Roadmap source is not valid UTF-8: ${(error as Error).message}`);
  }
}

export async function reviewRoadmapImport(context: StoreContext, projectId: string, sourcePath: string): Promise<RoadmapImportReview> {
  const source = sourceBytes(sourcePath);
  validateContent(projectId, source.content);
  const read = await readRoadmapAuthority(context, projectId);
  return {
    version: 1,
    projectId,
    expectedProjectRevision: read.projectRevision,
    expectedRoadmapRevision: read.roadmap?.revision ?? "absent",
    sourcePath: source.sourcePath,
    sourceHash: source.hash,
  };
}

async function withWrite<T>(context: StoreContext, fn: (db: StoreDb) => T): Promise<T> {
  return withCollaborationWrite(context, (handle) => fn(handle.db));
}

/**
 * note: The confirmed business result of a remote roadmap write: the frozen document is the
 * recorded effect, so its roadmap revision and content hash are the receipt. A remote write owns
 * no local collaboration revision.
 */
function confirmedRoadmapReceipt(intent: RemoteIntent, projectId: string, contentMarkdown: string): RoadmapWriteReceipt {
  const confirmed = intent.confirmed;
  if (confirmed === null) {
    throw new RoadmapError(
      "roadmap.operation-conflict",
      `Operation ${intent.operationId} is confirmed without a recorded provider effect; nothing was read or changed.`,
    );
  }
  const change = confirmed.event.change;
  const roadmap = change.kind === "project-replace" ? (change.project.roadmap as { revision?: unknown } | null) : null;
  return {
    projectId,
    revision: typeof roadmap?.revision === "number" ? roadmap.revision : 0,
    contentHash: sha256(contentMarkdown),
    storeRevision: 0,
  };
}

/**
 * The remote branch of every roadmap write: freeze the new project journal document (the
 * reviewed content plus the next roadmap revision) as one durable outbox intent. The caller's
 * reviewed project/roadmap revisions are compared with the OBSERVED document before anything is
 * frozen, so a stale reviewer can never overwrite content that moved under it. Roadmap content is
 * portable text, so no checkout path or source hash enters the frozen subject.
 */
async function queueRoadmapWrite(
  context: StoreContext,
  projectId: string,
  operationId: string,
  verb: "roadmap-replace" | "roadmap-import",
  contentMarkdown: string,
  expected: { projectRevision: number; roadmapRevision: RoadmapExpected },
): Promise<RoadmapWriteReceipt> {
  // note: Dynamic on purpose — collaboration-remote.ts imports this module, so a static import
  // would close the cycle before the roadmap contract initializes.
  const { prepareRemoteProjectWrite, pendingRemoteEffect } = await import("./collaboration-remote.js");
  const at = new Date().toISOString();
  const intent = await prepareRemoteProjectWrite(context, {
    projectId,
    operationId,
    origin: {
      verb,
      request: {
        projectId,
        contentMarkdown,
        expectedProjectRevision: expected.projectRevision,
        expectedRoadmapRevision: expected.roadmapRevision,
      },
    },
    next: (current) => {
      const entities = current.catalogEntities as Array<Record<string, unknown>>;
      const project = entities.find((entity) => entity.kind === "project" && entity.id === projectId);
      if (project === undefined || project.revision !== expected.projectRevision) {
        throw new RoadmapError(
          "roadmap.revision-conflict",
          `Catalog project ${projectId} is at revision ${String(project?.revision)} in the observed project, not the ` +
            `expected ${expected.projectRevision}; nothing was enqueued.`,
        );
      }
      const roadmap = current.roadmap as { revision: number } | null;
      const currentRevision: RoadmapExpected = roadmap === null ? "absent" : roadmap.revision;
      if (currentRevision !== expected.roadmapRevision) {
        throw new RoadmapError(
          "roadmap.revision-conflict",
          `The roadmap of ${projectId} is at revision ${String(currentRevision)}, not the expected ` +
            `${String(expected.roadmapRevision)}; nothing was enqueued.`,
        );
      }
      return {
        ...current,
        roadmap: { contentMarkdown, revision: (roadmap?.revision ?? 0) + 1, updatedAt: at },
      };
    },
  });
  if (intent.confirmed !== null) return confirmedRoadmapReceipt(intent, projectId, contentMarkdown);
  throw pendingRemoteEffect(intent);
}

/**
 * The one roadmap write (contract §6). `expected` carries the caller's
 * comparison claims; both are REQUIRED, because a claim derived from the same
 * read the write is built on can never disagree with it — the guard would be
 * vacuous and a stale caller would silently overwrite whatever moved since it
 * read (A11). A disagreement with the current authority inside this
 * transaction is `roadmap.revision-conflict` and nothing is written.
 *
 * The request hash covers the DECLARED intent, not the resolved comparison: a
 * replay (same operation id, same body, same declared claims) is the same
 * request, while the semantic comparison against current state is what makes it
 * a no-op or a conflict. Hashing the observed basis instead would make an
 * identical replay hash differently once the first write moved the revision,
 * turning a legitimate retry into `roadmap.operation-conflict` (A09).
 */
function writeAuthority(
  db: StoreDb,
  input: { projectId: string; contentMarkdown: string },
  operation: RoadmapOperation,
  provenance: { sourcePath: string; sourceHash: string } | undefined,
  requestHashOverride: string | undefined,
  expected: { projectRevision: number; roadmapRevision: RoadmapExpected },
): RoadmapWriteReceipt {
  requireActive(db);
  const hash = sha256(input.contentMarkdown);
  const requestHash = requestHashOverride ?? sha256(JSON.stringify({
    domain: "roadmap-content-authority",
    projectId: input.projectId,
    declaredProjectRevision: expected.projectRevision,
    declaredRoadmapRevision: expected.roadmapRevision,
    contentHash: hash,
    provenance: provenance ?? null,
  }));
  const prior = db.prepare("select request_hash, result_json from collaboration_operations where key_space='standalone' and operation_id=?").get(operation.operationId) as
    | { request_hash: string; result_json: string }
    | undefined;
  if (prior) {
    if (prior.request_hash !== requestHash) throw new RoadmapError("roadmap.operation-conflict", "operationId was reused for a different request or domain.");
    return receiptFromOperation(prior.result_json);
  }
  const project = projectRow(db, input.projectId);
  const current = db.prepare("select revision from project_roadmaps where project_id=?").get(input.projectId) as { revision?: unknown } | undefined;
  const currentExpected: RoadmapExpected = current ? Number(current.revision) : "absent";
  if (project.revision !== expected.projectRevision || currentExpected !== expected.roadmapRevision) {
    throw new RoadmapError(
      "roadmap.revision-conflict",
      `Catalog project ${input.projectId} is at project revision ${project.revision} / roadmap revision ${String(currentExpected)}, ` +
        `not the expected ${expected.projectRevision} / ${String(expected.roadmapRevision)}; nothing was written.`,
    );
  }
  validateContent(input.projectId, input.contentMarkdown);
  const revision = current ? Number(current.revision) + 1 : 1;
  const updatedAt = new Date().toISOString();
  if (current) {
    db.prepare("update project_roadmaps set content_markdown=?, content_hash=?, revision=?, updated_at=? where project_id=?")
      .run(input.contentMarkdown, hash, revision, updatedAt, input.projectId);
  } else {
    db.prepare("insert into project_roadmaps(project_id, content_markdown, content_hash, revision, updated_at) values(?,?,?,?,?)")
      .run(input.projectId, input.contentMarkdown, hash, revision, updatedAt);
  }
  db.prepare("update collaboration_meta set revision=revision+1 where id=1").run();
  const versions = db.prepare("select revision from collaboration_meta where id=1").get() as { revision: number };
  const receipt = { projectId: input.projectId, revision, contentHash: hash, storeRevision: versions.revision };
  db.prepare("insert into collaboration_operations(key_space,operation_id,request_hash,result_json,committed_at) values('standalone',?,?,?,?)")
    .run(operation.operationId, requestHash, JSON.stringify({ ...receipt, outcome: "committed", provenance: provenance ?? null }), updatedAt);
  return receipt;
}

/**
 * Replace the whole roadmap body (contract §6, whose signature declares both
 * `expectedProjectRevision: number` and `expectedRoadmapRevision: RoadmapExpected`
 * as required). The caller states the comparison basis it actually read: each
 * claim is compared against the current authority inside the write transaction
 * and a disagreement is `roadmap.revision-conflict`. Deriving an omitted claim
 * from that same transaction would compare the authority against itself, so the
 * guard would be vacuous and a caller holding a stale read would silently
 * overwrite the newer content. What a claimed revision never becomes is a
 * second authority: the stored `project_roadmaps` row this call writes is the
 * same one every reader resolves.
 */
export async function replaceRoadmapAuthority(
  context: StoreContext,
  input: {
    projectId: string;
    expectedProjectRevision: number;
    expectedRoadmapRevision: RoadmapExpected;
    contentMarkdown: string;
  },
  operation: RoadmapOperation,
): Promise<RoadmapWriteReceipt> {
  if (resolveCollaborationLocation(context).mode === "remote") {
    validateContent(input.projectId, input.contentMarkdown);
    return queueRoadmapWrite(context, input.projectId, operation.operationId, "roadmap-replace", input.contentMarkdown, {
      projectRevision: input.expectedProjectRevision,
      roadmapRevision: input.expectedRoadmapRevision,
    });
  }
  return withWrite(context, (db) =>
    writeAuthority(
      db,
      { projectId: input.projectId, contentMarkdown: input.contentMarkdown },
      operation,
      undefined,
      undefined,
      { projectRevision: input.expectedProjectRevision, roadmapRevision: input.expectedRoadmapRevision },
    ),
  );
}

export async function importRoadmapAuthority(
  context: StoreContext,
  review: RoadmapImportReview,
  operation: RoadmapOperation,
): Promise<RoadmapWriteReceipt> {
  if (resolveCollaborationLocation(context).mode === "remote") {
    // note: The reviewed preview's content is the portable document; its checkout path and source
    // hash pin what the operator read and never enter the frozen subject.
    const source = sourceBytes(review.sourcePath);
    validateContent(review.projectId, source.content);
    return queueRoadmapWrite(context, review.projectId, operation.operationId, "roadmap-import", source.content, {
      projectRevision: review.expectedProjectRevision,
      roadmapRevision: review.expectedRoadmapRevision,
    });
  }
  return withWrite(context, (db) => {
    requireActive(db);
    const requestHash = sha256(JSON.stringify({
      domain: "roadmap-content-authority",
      action: "import",
      projectId: review.projectId,
      expectedProjectRevision: review.expectedProjectRevision,
      expectedRoadmapRevision: review.expectedRoadmapRevision,
      sourcePath: review.sourcePath,
      sourceHash: review.sourceHash,
    }));
    const prior = db.prepare("select request_hash, result_json from collaboration_operations where key_space='standalone' and operation_id=?").get(operation.operationId) as
      | { request_hash: string; result_json: string }
      | undefined;
    if (prior) {
      if (prior.request_hash !== requestHash) throw new RoadmapError("roadmap.operation-conflict", "operationId was reused for a different request or domain.");
      return receiptFromOperation(prior.result_json);
    }
    // The reviewed source hash records what the caller saw; the current path
    // content is imported without a content-drift refusal.
    const source = sourceBytes(review.sourcePath);
    validateContent(review.projectId, source.content);
    // A reviewed import keeps the basis its preview OBSERVED; neither revision
    // is derived here.
    return writeAuthority(
      db,
      { projectId: review.projectId, contentMarkdown: source.content },
      operation,
      { sourcePath: source.sourcePath, sourceHash: source.hash },
      requestHash,
      { projectRevision: review.expectedProjectRevision, roadmapRevision: review.expectedRoadmapRevision },
    );
  });
}

