export type { RoadmapContent } from "./roadmap-content.js";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { StoreError, openStore, type StoreContext, type StoreDb } from "./store-db.js";
import { parseRoadmapContent, validateRoadmapContent } from "./roadmap-content.js";

export type RoadmapExpected = number | "absent";
export type RoadmapOperation = { operationId: string; actor?: string };
export type RoadmapRecord = {
  projectId: string;
  revision: number;
  contentHash: string;
  updatedAt: string;
  contentMarkdown: string;
};
export type RoadmapRead = { projectId: string; projectRevision: number; roadmap: RoadmapRecord | null };
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
  | "roadmap.source-drift"
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

function requireRoadmapSchema(db: StoreDb): void {
  const present = db.prepare("select count(*) as count from sqlite_master where type='table' and name='schema_version'").get() as
    | { count?: unknown }
    | undefined;
  if (present?.count !== 1) throw new StoreError("store.corrupt", "The store database has no schema_version table.");
  const row = db.prepare("select max(version) as version from schema_version").get() as { version?: unknown } | undefined;
  if (typeof row?.version !== "number" || row.version < 6) {
    throw new RoadmapError("roadmap.schema-outdated", 'Roadmap content requires store schema 6; run "mstar store upgrade" first.');
  }
}

function requireActive(db: StoreDb): void {
  const row = db.prepare("select authority_state from store_meta where id = 1").get() as { authority_state?: unknown } | undefined;
  if (row?.authority_state !== "active") {
    throw new RoadmapError("roadmap.store-not-active", "Roadmap access requires an active store; staged stores are not readable or writable.");
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
  requireRoadmapSchema(db);
  requireActive(db);
  const project = projectRow(db, projectId);
  const row = db.prepare("select project_id, content_markdown, content_hash, revision, updated_at from project_roadmaps where project_id=?").get(projectId) as
    | { project_id: string; content_markdown: string; content_hash: string; revision: number; updated_at: string }
    | undefined;
  if (!row) return { projectId, projectRevision: project.revision, roadmap: null };
  if (row.project_id !== projectId || typeof row.content_markdown !== "string" || typeof row.content_hash !== "string" ||
      !Number.isInteger(row.revision) || row.revision < 1 || typeof row.updated_at !== "string" ||
      sha256(row.content_markdown) !== row.content_hash) {
    throw new RoadmapError("roadmap.corrupt", `Stored roadmap for project ${projectId} is malformed or has a mismatched content hash.`);
  }
  try {
    const content = parseRoadmapContent(row.content_markdown);
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
  };
}

/** Read roadmap authority using a handle owned by the caller; never opens a transaction. */
export function readRoadmapAuthorityOn(db: StoreDb, projectId: string): RoadmapRead {
  return readOn(db, projectId);
}

export async function readRoadmapAuthority(context: StoreContext, projectId: string): Promise<RoadmapRead> {
  const handle = await openStore(context, "read");
  try {
    handle.db.exec("begin");
    try {
      const result = readOn(handle.db, projectId);
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

export async function listRoadmapAuthority(context: StoreContext): Promise<RoadmapRead[]> {
  const handle = await openStore(context, "read");
  try {
    handle.db.exec("begin");
    try {
      requireRoadmapSchema(handle.db);
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
  if (new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(content)) !== content) {
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
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
  const handle = await openStore(context, "write");
  try {
    handle.db.exec("begin immediate");
    try {
      const result = fn(handle.db);
      handle.db.exec("commit");
      return result;
    } catch (error) {
      try { handle.db.exec("rollback"); } catch { /* transaction already failed */ }
      throw error;
    }
  } finally {
    handle.close();
  }
}

function writeAuthority(
  db: StoreDb,
  input: { projectId: string; expectedProjectRevision: number; expectedRoadmapRevision: RoadmapExpected; contentMarkdown: string },
  operation: RoadmapOperation,
  provenance?: { sourcePath: string; sourceHash: string },
  requestHashOverride?: string,
): RoadmapWriteReceipt {
  requireRoadmapSchema(db);
  requireActive(db);
  const hash = sha256(input.contentMarkdown);
  const requestHash = requestHashOverride ?? sha256(JSON.stringify({ domain: "roadmap-content-authority", ...input, contentHash: hash, provenance: provenance ?? null }));
  const prior = db.prepare("select request_hash, result_json from store_operations where operation_id=?").get(operation.operationId) as
    | { request_hash: string; result_json: string }
    | undefined;
  if (prior) {
    if (prior.request_hash !== requestHash) throw new RoadmapError("roadmap.operation-conflict", "operationId was reused for a different request or domain.");
    return receiptFromOperation(prior.result_json);
  }
  const project = projectRow(db, input.projectId);
  const current = db.prepare("select revision from project_roadmaps where project_id=?").get(input.projectId) as { revision?: unknown } | undefined;
  const currentExpected: RoadmapExpected = current ? Number(current.revision) : "absent";
  if (project.revision !== input.expectedProjectRevision || currentExpected !== input.expectedRoadmapRevision) {
    throw new RoadmapError("roadmap.revision-conflict", "Catalog project or roadmap revision changed since it was observed.");
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
  db.prepare("update store_meta set revision=revision+1 where id=1").run();
  const versions = db.prepare("select revision from store_meta where id=1").get() as { revision: number };
  const receipt = { projectId: input.projectId, revision, contentHash: hash, storeRevision: versions.revision };
  db.prepare("insert into store_operations(operation_id, request_hash, result_json, committed_at) values(?,?,?,?)")
    .run(operation.operationId, requestHash, JSON.stringify({ ...receipt, outcome: "committed", provenance: provenance ?? null }), updatedAt);
  return receipt;
}

export async function replaceRoadmapAuthority(
  context: StoreContext,
  input: { projectId: string; expectedProjectRevision: number; expectedRoadmapRevision: RoadmapExpected; contentMarkdown: string },
  operation: RoadmapOperation,
): Promise<RoadmapWriteReceipt> {
  return withWrite(context, (db) => writeAuthority(db, input, operation));
}

export async function importRoadmapAuthority(
  context: StoreContext,
  review: RoadmapImportReview,
  operation: RoadmapOperation,
): Promise<RoadmapWriteReceipt> {
  return withWrite(context, (db) => {
    requireRoadmapSchema(db);
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
    const prior = db.prepare("select request_hash, result_json from store_operations where operation_id=?").get(operation.operationId) as
      | { request_hash: string; result_json: string }
      | undefined;
    if (prior) {
      if (prior.request_hash !== requestHash) throw new RoadmapError("roadmap.operation-conflict", "operationId was reused for a different request or domain.");
      return receiptFromOperation(prior.result_json);
    }
    const source = sourceBytes(review.sourcePath);
    if (source.hash !== review.sourceHash) throw new RoadmapError("roadmap.source-drift", "Reviewed roadmap source changed before import; no content was published.");
    validateContent(review.projectId, source.content);
    return writeAuthority(db, {
      projectId: review.projectId,
      expectedProjectRevision: review.expectedProjectRevision,
      expectedRoadmapRevision: review.expectedRoadmapRevision,
      contentMarkdown: source.content,
    }, operation, { sourcePath: source.sourcePath, sourceHash: source.hash }, requestHash);
  });
}

