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
 | "readAssignmentSource"
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
/**
 * Shape-guard match of a retired body-label core field in ANY of its three
 * forms — a plain `Execute as:` line, a bold `**Execute as**:` line, or a
 * list-prefixed `- **Execute as**:` line (indentation and a numeric or
 * bullet list marker are formatting, never the field; commands
 * validation.ts / dsh parity — one detection grammar across every gate).
 * Detection ONLY: it never reads a field value — the carrier is never
 * field-parsed with a label regex.
 */
function legacyLabelKey(line: string): string | undefined {
 const match = /^[ \t]*(?:(?:\d+[.)]|[-+*])[ \t]+)?(?:\*\*[ \t]*)?(Execute as|Delegation|Task category|Working branch|Branch policy|Execution mode|Write domain|Worktree path)[ \t]*(?:\*\*)?[ \t]*:/.exec(line);
 return match?.[1];
}

/**
 * D16 shape detection: true when the document carries its fields in the
 * RETIRED body-label grammar — at least TWO distinct core labels, so a
 * single bolded field line in ordinary prose never shapes a document as
 * an Assignment; the `## Assignment` heading is irrelevant either way.
 */
function legacyAssignmentShape(text: string): boolean {
 if (/^---[ \t]*\r?\n/.test(text)) return false;
 const found = new Set<string>();
 for (const line of text.split(/\r?\n/)) {
 const key = legacyLabelKey(line);
 if (key !== undefined) found.add(key);
 if (found.size >= 2) return true;
 }
 return false;
}

/** The D16 legacy-format refusal violation (front matter is the only field
 * contract); the fix names BOTH recoveries — the front matter rewrite and
 * the `Assignment file:` pointer. */
function legacyFormatViolation(): GateViolation {
 return {
 severity: "high",
 code: "dispatch.assignment.legacy-format",
 message: "the Assignment carries its fields as `**Label**` body lines — the retired format; front matter is the only field contract",
 fix: "rewrite the assignment as a front-matter document (a `---`-fenced YAML block declaring the snake_case keys, e.g. execute_as / working_branch), or pass it as an `Assignment file: <abs>` pointer under an accepted assignment home",
 };
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
 // compass D14 — resolve the Assignment source ONCE through the engine
 // resolver (inline front-matter passthrough or the `Assignment file:
 // <abs>` pointer, containment-checked against the control harness root;
 // a null root refuses the pointer — containment is never skipped). A
 // refusal is itself the verdict: validating the pointer text would
 // report field violations on the wrong body.
 const harnessDir = api.resolveHarnessDir();
 const source = api.readAssignmentSource(prompt, { harnessDir });
 let violations: readonly GateViolation[];
 let enforcementHard = false;
 if (!source.ok) {
 violations = [source];
 } else {
 const text = source.text;
 const fields = api.parseAssignmentFields(text);
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
 // D16 — an Assignment-shaped document whose fields live in the retired
 // body-label grammar is refused `dispatch.assignment.legacy-format`;
 // the refusal supersedes the schema's absent-fence row for the same
 // unfenced text (one defect, one message).
 const legacy = legacyAssignmentShape(text);
 const writable = api.isReadOnlyAssignmentRole(fields.executeAs ?? "") ? false : undefined;
 const caller = typeof event.agent === "string" ? event.agent : "";
 const composed = api.composeDispatchGate(text, { caller, callerRequired: true, writable });
 violations = [
 ...(legacy ? [legacyFormatViolation()] : []),
 ...composed.violations.filter((violation) => !(legacy && violation.code === "document.frontmatter.absent")),
 ];
 enforcementHard = composed.enforcement.hard;
 }
 const hard = enforcementHard || (harnessDir !== null && api.resolveRepoEnforcement(harnessDir).hard);
 const hardBlocked = hard && violations.length > 0;

 for (const violation of violations) {
 const fix = violation.fix ? ` (fix: ${violation.fix})` : "";
 const level = hardBlocked ? "error" : "warn";
 logger(level, `subagent Assignment validation: [${violation.severity}] ${violation.code}: ${violation.message}${fix}`);
 }

 if (hardBlocked) return Effect.fail(refusalForViolations(violations));
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
