import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
/** Native tool.execute.before coverage is limited to write/edit; patch, shell,
 * and Code Mode remain outside this gate. SDK pin receipt: the installed
 * @opencode/plugin@2.0.26/dist/effect/tool.d.ts:1 imports Tool from
 * @opencode/schema/tool, whose pinned dist/tool.d.ts:40 declares Tool.Error. */
import type { ToolHooks } from "@opencode/plugin/effect/tool";
import { Tool } from "@opencode/schema/tool";
import { Effect } from "effect";

import type * as Engine from "@mstar-harness/engine";

import { loadWriteGateApi } from "../engine-seams";
import { defaultStatusLogger, type StatusLogger } from "../log";

export type WriteBeforeEvent = ToolHooks["execute.before"];

type EngineModule = typeof Engine;
export type WriteGateEngineApi = Pick<
  EngineModule,
  | "applyEnforcement"
  | "harnessDocKindOfTarget"
  | "queryIssueFlow"
  | "resolveExecutionReadRoute"
  | "resolveHarnessDir"
  | "resolveProjectDir"
  | "resolveRepoEnforcement"
  | "resolveWorkflowDir"
  | "validateStatusWriteDoc"
  | "withStoreRead"
>;

type WriteGateServices = {
  loadEngine?: () => Promise<WriteGateEngineApi | null>;
  logger?: StatusLogger;
};

type GatedDocument = { harnessDir: string; kind: Engine.HarnessDocKind };

const STORE_NAMES: Record<string, true> = {
  "store.db": true,
  "store.db-wal": true,
  "store.db-shm": true,
};
const PRE_ACTIVATION_CODES = new Set(["store.not-initialized", "store.not-active"]);


function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function errorCode(error: unknown): string | undefined {
  const record = asRecord(error);
  return typeof record?.code === "string" ? record.code : undefined;
}

function refusal(code: string, message: string): Tool.Error {
  return new Tool.Error({ message: `[${code}] ${message}` });
}

function malformedPath(): Tool.Error {
  return refusal(
    "write.input-path-invalid",
    "input.path must be a non-empty string. Align the OpenCode 2.0.26 tool input schema and retry; no write was authorized.",
  );
}

function landedPathOf(filePath: string): string {
  let probe = resolve(filePath);
  const suffix: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(probe), ...suffix);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return resolve(filePath);
      suffix.unshift(basename(probe));
      probe = parent;
    }
  }
}


function harnessRootFor(api: WriteGateEngineApi, candidate: string): string | null {
  let dir = dirname(candidate);
  for (;;) {
    const resolved = api.resolveHarnessDir(dir);
    if (resolved !== null) {
      const root = resolve(resolved);
      const rel = relative(root, candidate);
      if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return resolved;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function isStoreAuthorityTarget(api: WriteGateEngineApi, candidate: string): boolean {
  const name = basename(candidate).toLowerCase();
  return STORE_NAMES[name] === true && harnessRootFor(api, candidate) !== null;
}

function caseFoldedDocument(api: WriteGateEngineApi, candidate: string): GatedDocument | null {
  const name = basename(candidate).toLowerCase();
  if (name !== "status.json" && name !== "snapshot.json" && name !== "residuals.json") return null;
  const harnessDir = harnessRootFor(api, candidate);
  if (harnessDir === null) return null;
  const relativeTarget = relative(resolve(harnessDir), resolve(candidate)).split(sep).map((part) => part.toLowerCase());
  if (name === "status.json" && relativeTarget.length === 1) return { harnessDir, kind: "status" };
  if (name === "snapshot.json") {
    const workflowDir = relative(resolve(harnessDir), api.resolveWorkflowDir(harnessDir, { harnessDir })).split(sep).map((part) => part.toLowerCase());
    const rel = relativeTarget.slice(workflowDir.length);
    if (relativeTarget.slice(0, workflowDir.length).join("/") === workflowDir.join("/") && rel.length === 2 && rel[1] === "snapshot.json") {
      return { harnessDir, kind: "snapshot" };
    }
  }
  if (name === "residuals.json") {
    const projectDir = relative(resolve(harnessDir), api.resolveProjectDir(harnessDir, { harnessDir })).split(sep).map((part) => part.toLowerCase());
    const rel = relativeTarget.slice(projectDir.length);
    if (relativeTarget.slice(0, projectDir.length).join("/") === projectDir.join("/") && rel.length === 2 && rel[1] === "residuals.json") {
      return { harnessDir, kind: "register" };
    }
  }
  return null;
}

function classifyDocument(api: WriteGateEngineApi, inputPath: string, landedPath: string): GatedDocument | null {
  return api.harnessDocKindOfTarget(inputPath)
    ?? caseFoldedDocument(api, inputPath)
    ?? (landedPath === inputPath ? null : api.harnessDocKindOfTarget(landedPath) ?? caseFoldedDocument(api, landedPath));
}

function authorityError(code: string, message: string): AuthorityRefusal {
  return {
    code,
    message: `${message} — the write is refused unconditionally; inspect the harness with mstar status validate and use the supported store operation.`,
  };
}

async function authorityRefusalFor(api: WriteGateEngineApi, target: GatedDocument): Promise<AuthorityRefusal | null> {
  if (target.kind === "status" || target.kind === "snapshot") {
    try {
      const route = await api.resolveExecutionReadRoute({ harnessDir: target.harnessDir });
      return route === "execution"
        ? authorityError("execution.direct-write-refused", "The ACTIVE execution authority retires this file as a persistence route")
        : null;
    } catch (error) {
      const code = errorCode(error) ?? "store.authority-unavailable";
      return authorityError("store.authority-unavailable", `The execution authority could not be read (${code}: ${error instanceof Error ? error.message : String(error)})`);
    }
  }

  try {
    await api.withStoreRead({ harnessDir: target.harnessDir }, api.queryIssueFlow());
    return authorityError("project.register.retired", "The ACTIVE issue/catalog authority retires project residual registers");
  } catch (error) {
    const code = errorCode(error);
    if (code !== undefined && PRE_ACTIVATION_CODES.has(code)) return null;
    return authorityError("store.authority-unavailable", `The issue/catalog authority could not be read (${code ?? "unknown"}: ${error instanceof Error ? error.message : String(error)})`);
  }
}

function countOccurrences(text: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let offset = 0;
  for (;;) {
    const at = text.indexOf(needle, offset);
    if (at < 0) return count;
    count++;
    offset = at + needle.length;
  }
}

function prospectiveEdit(current: string, input: Record<string, unknown>): string | undefined {
  const { oldString, newString, replaceAll } = input;
  if (typeof oldString !== "string" || oldString === "" || typeof newString !== "string" || typeof replaceAll !== "boolean") return undefined;
  const hits = countOccurrences(current, oldString);
  if (hits === 0 || (hits !== 1 && replaceAll !== true)) return undefined;
  return replaceAll ? current.replaceAll(oldString, newString) : current.replace(oldString, newString);
}

async function validateDocument(
  api: WriteGateEngineApi,
  event: WriteBeforeEvent,
  input: Record<string, unknown>,
  path: string,
  target: GatedDocument,
  logger: StatusLogger,
): Promise<void> {
  let content: unknown = input.content;
  if (event.tool === "edit") {
    try {
      if (!existsSync(path)) content = undefined;
      else {
        const current = readFileSync(path, "utf8");
        content = prospectiveEdit(current, input) ?? undefined;
      }
    } catch (error) {
      logger("warn", `Could not synthesize edit post-state for ${basename(path)}; validating pre-edit disk state instead (${error instanceof Error ? error.message : String(error)}).`);
      content = undefined;
    }
  }

  const violations = api.validateStatusWriteDoc(content, path, target.kind);
  if (violations.length === 0) return;
  const enforcement = api.resolveRepoEnforcement(target.harnessDir);
  const result = api.applyEnforcement({ ok: false, violations }, { hard: enforcement.hard });
  for (const violation of result.violations) {
    const line = `[${violation.severity}] ${violation.code}: ${violation.message}${violation.fix ? ` (fix: ${violation.fix})` : ""}`;
    logger(enforcement.hard ? "error" : "warn", `${basename(path)} validation: ${line}`);
  }
  if (result.hardBlocked) {
    const details = result.violations.map((violation) => `[${violation.code}] ${violation.message}${violation.fix ? ` Recovery: ${violation.fix}` : ""}`).join("\n");
    throw refusal(result.violations[0]?.code ?? "status.invalid", `${details}\nCorrect the coordination document and retry; the write was not applied.`);
  }
}

async function executeBefore(event: WriteBeforeEvent, services: WriteGateServices): Promise<void> {
  if (event.tool !== "write" && event.tool !== "edit") return;
  const input = asRecord(event.input);
  if (input === null || typeof input.path !== "string" || input.path.trim() === "") throw malformedPath();

  const api = await (services.loadEngine ?? loadWriteGateApi)();
  if (api === null) {
    throw refusal("write.engine-unavailable", "The required ACTIVE-only engine gate exports are unavailable. Upgrade @mstar-harness/engine and retry; no write was authorized.");
  }

  const requested = resolve(input.path);
  const landed = landedPathOf(requested);
  const logger = services.logger ?? defaultStatusLogger;
  if (isStoreAuthorityTarget(api, requested) || isStoreAuthorityTarget(api, landed)) {
    throw refusal("store.direct-write-refused", "store.db and its WAL/SHM files are store authority and cannot be written by a tool");
  }

  const target = classifyDocument(api, requested, landed);
  if (target === null) return;

  const authorityRefusal = await authorityRefusalFor(api, target);
  if (authorityRefusal !== null) throw refusal(authorityRefusal.code, authorityRefusal.message);
  await validateDocument(api, event, input, requested, target, logger);
}

export function writeBefore(event: WriteBeforeEvent, services: WriteGateServices = {}): Effect.Effect<void, Tool.Error> {
  return Effect.tryPromise({
    try: () => executeBefore(event, services),
    catch: (error) => error instanceof Tool.Error
      ? error
      : refusal("write.gate-failed", `The write gate could not safely evaluate this request (${error instanceof Error ? error.message : String(error)}). Inspect the harness and retry; no authorization was granted.`),
  });
}
