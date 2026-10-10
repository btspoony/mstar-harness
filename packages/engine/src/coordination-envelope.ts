/**
 * coordination-envelope.ts — the retired coordinator session-envelope bytes.
 *
 * The envelope was the FILE execution route's durable coordinator binding. That
 * route is retired: the ACTIVE execution authority (store.db) is the only
 * binding, written by `execution-session.ts`. This module keeps only the
 * envelope SHAPE and one byte-witness reader for the migration side
 * (`execution-minimal-import.ts` reads envelopes as import sources) and the
 * not-yet-cut issue-domain authorization surface (`issue.ts`). Nothing here is
 * authority: a file that parses as an envelope authorizes nothing.
 *
 * It imports only `node:*`, `./coordination-write.js` and `./path.js` (all
 * leaves) so it closes no ESM cycle back through `store.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  CoordinationError,
  assertExactKeys,
  isNonEmptyString,
  isPlainObject,
} from "./coordination-write.js";
import { resolveWorkflowDir } from "./path.js";

/** The workflow-wide coordinator envelope persisted by the engine. */
export type CoordinationSession = {
  schema_version: 1;
  role: "coordinator";
  session_id: string;
  workflow_id: string;
  harness_root: string;
};

const SESSION_DIR = "sessions";
const ENVELOPE_KEYS = ["schema_version", "role", "session_id", "workflow_id", "harness_root"] as const;

/** Canonical workflow coordinator envelope path. */
export function sessionFilePath(
  harnessRoot: string,
  workflowId: string,
  role: CoordinationSession["role"],
  sessionId: string,
): string {
  return join(
    resolveWorkflowDir(harnessRoot, { harnessDir: harnessRoot }),
    workflowId,
    SESSION_DIR,
    `${role}-${sessionId}.json`,
  );
}

/** Read and validate a session envelope (throws `coordination.session-*`). */
export function readSessionEnvelope(sessionPath: string): CoordinationSession {
  if (!isNonEmptyString(sessionPath) || !isAbsolute(sessionPath)) {
    throw new CoordinationError("coordination.invalid-input", "sessionPath must be an absolute path. Inspect the harness authority with mstar status validate.");
  }
  const abs = resolve(sessionPath);
  if (!existsSync(abs)) {
    throw new CoordinationError("coordination.session-not-found", "Session envelope was not found. Inspect the harness authority with mstar status validate.", { path: abs });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (error) {
    throw new CoordinationError("coordination.store", "Session envelope is not valid JSON. Inspect the harness authority with mstar status validate.", {
      path: abs, cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isPlainObject(parsed)) {
    throw new CoordinationError("coordination.store", "Session envelope must be an object. Inspect the harness authority with mstar status validate.", { path: abs });
  }
  assertExactKeys(parsed, ENVELOPE_KEYS, `session envelope ${abs}`);
  if (parsed.schema_version !== 1) {
    throw new CoordinationError("coordination.invalid-input", "Session envelope must declare schema_version 1. Inspect the harness authority with mstar status validate.", { path: abs });
  }
  const role = parsed.role;
  if (role !== "coordinator") {
    throw new CoordinationError("coordination.invalid-input", "Session envelope has a non-coordinator role. Inspect the harness authority with mstar status validate.", {
      path: abs,
    });
  }
  const sessionId = parsed.session_id;
  const workflowId = parsed.workflow_id;
  const harnessRoot = parsed.harness_root;
  if (!isNonEmptyString(sessionId)) {
    throw new CoordinationError("coordination.invalid-input", "Session envelope requires a non-empty session_id. Inspect the harness authority with mstar status validate.", { path: abs });
  }
  if (!isNonEmptyString(workflowId)) {
    throw new CoordinationError("coordination.invalid-input", "Session envelope requires a non-empty workflow_id. Inspect the harness authority with mstar status validate.", { path: abs });
  }
  if (!isNonEmptyString(harnessRoot)) {
    throw new CoordinationError("coordination.invalid-input", "Session envelope requires a non-empty harness_root. Inspect the harness authority with mstar status validate.", { path: abs });
  }
  if (!isAbsolute(harnessRoot)) {
    throw new CoordinationError("coordination.invalid-input", "Session envelope harness_root must be absolute. Inspect the harness authority with mstar status validate.", { path: abs });
  }
  return {
    schema_version: 1,
    role,
    session_id: sessionId,
    workflow_id: workflowId,
    harness_root: harnessRoot,
  };
}
