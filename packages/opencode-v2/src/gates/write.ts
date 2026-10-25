import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
/** Native tool.execute.before coverage is limited to write/edit; patch, shell,
 * and Code Mode remain outside this gate. SDK pin receipt: the installed
 * @opencode/plugin@2.1.3/dist/effect/tool.d.ts:1 imports Tool from
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
 | "caseFoldedDocKind"
 | "harnessDocKindOfTarget"
 | "isStoreAuthorityTarget"
 | "landedPathOf"
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
type AuthorityRefusal = { code: string; message: string };

const PRE_ACTIVATION_CODES = new Set(["store.not-initialized", "store.not-active"]);
const AUTHORITY_RECOVERY = "Use supported mstar plan prepare|progress|complete, mstar workflow phase|lifecycle|execution-policy|integration-worktree transitions, or mstar status workflow-close for lifecycle changes; use mstar issue or mstar catalog commands for record changes, or mstar store upgrade/migrate for supported imports. Raw database-byte edits have no supported direct-write verb, so escalate repairs to the project maintainer.";


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

function malformedPath(field: "filePath" | "path"): Tool.Error {
 return refusal(
 "write.input-path-invalid",
 `input.${field} must be a non-empty string. Align the OpenCode 2.0.26 tool input schema and retry; no write was authorized.`,
 );
}

function classifyDocument(api: WriteGateEngineApi, inputPath: string, landedPath: string): GatedDocument | null {
 return api.harnessDocKindOfTarget(inputPath)
 ?? api.caseFoldedDocKind(inputPath)
 ?? (landedPath === inputPath ? null : api.harnessDocKindOfTarget(landedPath) ?? api.caseFoldedDocKind(landedPath));
}

function authorityError(code: string, message: string): AuthorityRefusal {
 return {
 code,
 message: `${message} — the write is refused unconditionally. ${AUTHORITY_RECOVERY}`,
 };
}

async function authorityRefusalFor(api: WriteGateEngineApi, target: GatedDocument): Promise<AuthorityRefusal | null> {
 if (target.kind === "status" || target.kind === "snapshot") {
 try {
 // ACTIVE-only: the engine's route decision retires the file execution
 // route entirely — status/snapshot writes are vetoed while the
 // authority is ACTIVE. A pre-activation harness (`store.not-initialized`
 // / `store.not-active`) is NO verdict: the compass-governed document
 // lint below decides, mirroring the register route's legacy
 // disposition. Any other refusal leaves the authority UNKNOWN and
 // fails closed; there is no file-route fallback.
 await api.resolveExecutionReadRoute({ harnessDir: target.harnessDir });
 return authorityError("execution.direct-write-refused", "The ACTIVE execution authority retires this file as a persistence route");
 } catch (error) {
 const code = errorCode(error);
 if (code !== undefined && PRE_ACTIVATION_CODES.has(code)) return null;
 return authorityError("store.authority-unavailable", `The execution authority could not be read (${code ?? "unknown"}: ${error instanceof Error ? error.message : String(error)})`);
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
 if (
 typeof oldString !== "string" ||
 oldString === "" ||
 typeof newString !== "string" ||
 (replaceAll !== undefined && typeof replaceAll !== "boolean")
 ) return undefined;
 const replaceEveryMatch = replaceAll === true;
 const hits = countOccurrences(current, oldString);
 if (hits === 0 || (hits !== 1 && !replaceEveryMatch)) return undefined;
 return current.split(oldString).join(newString);
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
 if (input === null) throw malformedPath("filePath");
 const filePath = typeof input.filePath === "string" && input.filePath.trim() !== ""
 ? input.filePath
 : typeof input.path === "string" && input.path.trim() !== ""
 ? input.path
 : undefined;
 if (filePath === undefined) throw malformedPath(input.filePath === undefined ? "path" : "filePath");

 let api: WriteGateEngineApi | null;
 try {
 api = await (services.loadEngine ?? loadWriteGateApi)();
 } catch (error) {
 throw refusal(
 "write.engine-unavailable",
 `The bundled engine failed to load (${error instanceof Error ? error.message : String(error)}). Upgrade the OpenCode plugin/host runtime; the engine is bundled with the plugin and is not a runtime dependency. No write was authorized.`,
 );
 }
 if (api === null) {
 throw refusal("write.engine-unavailable", "The required ACTIVE-only engine gate exports are unavailable. Upgrade the OpenCode plugin/host runtime; the engine is bundled with the plugin and is not a runtime dependency. No write was authorized.");
 }

 const requested = resolve(filePath);
 let landed: string;
 try {
 landed = api.landedPathOf(requested);
 } catch (error) {
 // The engine's chained resolver refuses a symlink cycle/overflow
 // fail-closed; keep its code + message in this host's envelope.
 const code = errorCode(error);
 if (code !== "write.symlink-resolution-refused") throw error;
 throw refusal(code, error instanceof Error ? error.message : String(error));
 }
 const logger = services.logger ?? defaultStatusLogger;
 if (api.isStoreAuthorityTarget(requested) || api.isStoreAuthorityTarget(landed)) {
 throw refusal(
 "store.direct-write-refused",
 `store.db and its WAL/SHM files are store authority and cannot be written by a tool. ${AUTHORITY_RECOVERY}`,
 );
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
