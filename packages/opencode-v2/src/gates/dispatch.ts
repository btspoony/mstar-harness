import { Tool } from "@opencode/schema/tool";
import { Effect } from "effect";
import type { ToolHooks } from "@opencode/plugin/effect/tool";

import * as Engine from "@mstar-harness/engine";

import { defaultStatusLogger, type StatusLogger } from "../log";

/**
 * SDK pin receipt: `@opencode/plugin@2.2.5/dist/effect/tool.d.ts:1` imports
 * `Tool` from `@opencode/schema/tool`; the pinned schema's
 * `dist/tool.d.ts:40` declares `Tool.Error`. `execute.before` receives
 * `event.agent` as the caller and leaves tool arguments in `input: unknown`.
 */
export type DispatchBeforeEvent = ToolHooks["execute.before"];
type EngineModule = typeof Engine;
/** The engine exports this gate calls; the bundled build inlines them. */
export type DispatchGateApi = Pick<
 EngineModule,
 | "applyEnforcement"
 | "composeDispatchGate"
 | "isReadOnlyAssignmentRole"
 | "parseAssignmentFields"
 | "resolveHarnessDir"
 | "resolveRepoEnforcement"
>;
export type DispatchGateServices = {
 /** Test substitution: the real engine is the default. */
 engine?: DispatchGateApi;
 logger?: StatusLogger;
};

type InputRecord = Record<string, unknown>;
type GateViolation = { severity: string; code: string; message: string; fix?: string };

function record(value: unknown): InputRecord | null {
 return typeof value === "object" && value !== null && !Array.isArray(value) ? value as InputRecord : null;
}

function toolError(code: string, details: string): Tool.Error {
 return new Tool.Error({ message: `[${code}] ${details}` });
}

function refusalForViolations(violations: readonly GateViolation[]): Tool.Error {
 const details = violations.map((violation) => {
 const recovery = violation.fix ? ` Recovery: ${violation.fix}` : "";
 return `[${violation.code}] ${violation.message}.${recovery}`;
 }).join("\n");
 return toolError(
 violations[0]?.code ?? "dispatch.assignment-invalid",
 `${details}\nCorrect the Assignment fields or branch form and retry; the subagent was not spawned.`,
 );
}

function malformedPrompt(): Tool.Error {
 return toolError(
 "dispatch.input-prompt-invalid",
 "input.prompt must be a string containing the Assignment text. Align the OpenCode 2.2.5 subagent schema and retry; no subagent was spawned.",
 );
}

function dispatchEffect(event: DispatchBeforeEvent, api: DispatchGateApi, logger: StatusLogger): Effect.Effect<void, Tool.Error> {
 const input = record(event.input);
 if (input === null || typeof input.prompt !== "string") return Effect.fail(malformedPrompt());
 if (typeof input.agent !== "string" || input.agent.trim() === "") {
 return Effect.fail(toolError(
 "dispatch.target-role-missing",
 "input.agent must name the requested target role. Supply the intended target role and retry; no subagent was spawned.",
 ));
 }

 try {
 const prompt = input.prompt;
 const fields = api.parseAssignmentFields(prompt);
 // Normalize both sides the way the engine does (strip a leading @,
 // lowercase, take the first whitespace token) so `@QC-Specialist` or
 // `qc-specialist-2 (security lens)` in the prompt still matches the
 // canonical target role.
 const declaredRole = fields.executeAs === undefined
 ? ""
 : fields.executeAs.trim().replace(/^@/, "").toLowerCase().split(/\s+/)[0] ?? "";
 if (declaredRole !== "" && input.agent.toLowerCase() !== declaredRole) {
 return Effect.fail(toolError(
 "dispatch.target-role-mismatch",
 `input.agent target "${input.agent}" does not match Assignment Execute as "${fields.executeAs}". Align the prompt's declared Execute as role with input.agent, or correct input.agent to the intended target; no subagent was spawned.`,
 ));
 }
 const writable = api.isReadOnlyAssignmentRole(fields.executeAs ?? "") ? false : undefined;
 const caller = typeof event.agent === "string" ? event.agent : "";
 const composed = api.composeDispatchGate(prompt, { caller, callerRequired: true, writable });
 const harnessDir = api.resolveHarnessDir();
 const hard = composed.enforcement.hard || (harnessDir !== null && api.resolveRepoEnforcement(harnessDir).hard);
 const gated = api.applyEnforcement(composed, { hard });

 for (const violation of gated.violations) {
 const fix = violation.fix ? ` (fix: ${violation.fix})` : "";
 const level = gated.hardBlocked ? "error" : "warn";
 logger(level, `subagent Assignment validation: [${violation.severity}] ${violation.code}: ${violation.message}${fix}`);
 }

 if (gated.hardBlocked) return Effect.fail(refusalForViolations(gated.violations));
 return Effect.void;
 } catch (error) {
 return Effect.fail(toolError(
 "dispatch.engine-unavailable",
 `The Assignment gate failed while evaluating the subagent request (${error instanceof Error ? error.message : String(error)}). Check the pinned engine exports and retry; no subagent was spawned.`,
 ));
 }
}

export function dispatchBefore(event: DispatchBeforeEvent, services: DispatchGateServices = {}): Effect.Effect<void, Tool.Error> {
 if (event.tool !== "subagent") return Effect.void;

 return dispatchEffect(event, services.engine ?? Engine, services.logger ?? defaultStatusLogger);
}
