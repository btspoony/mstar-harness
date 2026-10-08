/**
 * execution-ledgers.ts (command family) — the thin public routes for the two
 * agent CONTENT operations of the retained workflow-notes ledger.
 *
 * `appendWorkflowNote` (write) and `normalizeWorkflowNotesCoverage` (pure
 * projection) are engine-supported agent operations with no CLI/MCP entry
 * until now. Both routes stay thin: they resolve the control harness, build the
 * caller/session facts the engine already requires, and call the ONE engine
 * implementation — no second ledger reader, no second dedup rule, no rewritten
 * message. The engine's own authorization decides: a stale epoch, a revoked
 * session, a foreign caller or a mismatched scope refuses with the store's or
 * the ledger module's own code, details and recovery, and the wrapper preserves
 * them verbatim.
 *
 * ## Boundary rationale (why these routes exist and others do not)
 *
 * The classification rule is DOMAIN, not consumer count. An engine export earns
 * a public route when its existing semantics make it an agent content operation:
 * a note is caller-authored content the agent appends and inspects, so both
 * ledger operations route here.
 *
 * The remaining engine exports of this area stay internal by their own domain
 * rationale — they are reader derivations with no caller-authored content:
 *
 * - projection refresh / capture / publish — internal cache maintenance the
 *   authority performs for its own readers; exposing it would let a caller
 *   mutate derived state directly, bypassing the writer that owns it.
 * - `workflowExecutionPolicyViolations` — a validation-derivation helper whose
 *   facts already travel inside the refusals of the transitions that apply the
 *   policy; a separate route would publish a second, drift-prone copy.
 * - catalog-registration selectors — create-only catalog bookkeeping owned by
 *   the register/reconcile verbs; a selector route would expose producer
 *   internals, not an agent operation.
 *
 * This rationale lives with the module that owns the route boundary; it is NOT
 * duplicated into command metadata of unrelated exports.
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  ExecutionLedgerError,
  appendWorkflowNote,
  decodeExecutionSessionRef,
  executionContextFor,
  normalizeWorkflowNotesCoverage,
  resolveProcessHarnessDir,
  workflowNotesLedgerPath,
  type ExecutionIdentity,
} from "@mstar-harness/engine";
import { commandEnvelopeSchema } from "../definitions.js";
import { refusalEnvelope } from "../envelope.js";
import { decodeInputDiagnostics } from "../input-diagnostics.js";
import { engineErrorFacts } from "./family-refusal.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";

const APPEND_ID = "workflow-note.append";
const COVERAGE_ID = "workflow-note.coverage";

function ok<T>(id: string, data: T): CommandEnvelope<T> {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}

/** Preserve one engine error's code, details and recovery verbatim. */
function engineRefusal(id: string, error: unknown): CommandEnvelope<never> {
  const { code, details, recovery } = engineErrorFacts(error);
  return refusalEnvelope({
    command: id, status: "refused", code: code ?? `${id}.refused`, exitCode: 1,
    message: error instanceof Error ? error.message : String(error),
    ...(details === undefined ? {} : { details }),
    ...(recovery === undefined ? {} : { recovery }),
  });
}

function usage(id: string, message: string, path?: string): CommandEnvelope<never> {
  return refusalEnvelope({
    command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message,
    ...(path === undefined ? {} : { diagnostics: [{ path, code: "required", message }] }),
  });
}

/** One usage refusal carrying every schema issue, in the shared shape. */
function decodeUsage(id: string, error: z.ZodError, input: unknown): CommandEnvelope<never> {
  return refusalEnvelope({
    command: id, status: "usage", code: "command.invalid-input", exitCode: 2,
    message: "Invalid input.",
    diagnostics: decodeInputDiagnostics(error, input),
  });
}

const sessionOption = { key: "sessionId", flags: "--session-id <value>", required: false, context: "sessionId" } as const;

const appendInput = z.object({
  workflow: z.string().min(1),
  sessionRef: z.string().min(1),
  id: z.string().min(1),
  text: z.string(),
  ts: z.string().min(1).optional(),
  harness: z.string().min(1).optional(),
});

const coverageInput = z.object({
  workflow: z.string().min(1),
  file: z.string().min(1).optional(),
  harness: z.string().min(1).optional(),
});

/**
 * The no-follow, nonblocking open prevents leaf-link races without waiting on
 * a FIFO; fstat validates the opened object. Explicit files are intentionally
 * not confined beneath root.
 */
function readLedgerBytes(file: string): Uint8Array | null {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new ExecutionLedgerError(
        "execution-ledgers.target-untrusted",
        `the retained notes ledger at ${file} is a symbolic link.`,
      );
    }
    if (code !== "ENOENT") throw error;
    try {
      const info = lstatSync(file);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new ExecutionLedgerError(
          "execution-ledgers.target-untrusted",
          `the retained notes ledger at ${file} is not a regular file.`,
        );
      }
      return null;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw statError;
    }
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new ExecutionLedgerError(
        "execution-ledgers.target-untrusted",
        `the retained notes ledger at ${file} is not a regular file.`,
      );
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function getExecutionLedgerCommandDefinitions(): readonly CommandDefinition[] {
  return [
    {
      id: APPEND_ID,
      cli: {
        path: ["workflow-note", "append"],
        aliases: [],
        arguments: [],
        options: [
          { key: "workflow", flags: "--workflow <id>", required: true },
          { key: "sessionRef", flags: "--session-ref <wire>", required: true, help: "The active session reference returned by the `plan bind --execution` receipt: wire format exec-session-v1:<base64url JSON>." },
          { key: "id", flags: "--id <id>", required: true, help: "The note's stable record identity (the dedup key); a retry with the same id and text replays instead of duplicating." },
          { key: "text", flags: "--text <text>", required: true },
          { key: "ts", flags: "--ts <rfc3339>", required: false, help: "Note timestamp; defaults to the current time." },
          { key: "harness", flags: "--harness <path>", required: false },
          sessionOption,
        ],
      },
      input: appendInput,
      output: commandEnvelopeSchema,
      effects: ["write"],
      description: "Append one note to the addressed workflow's retained notes ledger, or replay an already accepted record id. Active-route only: the engine proves the bound session is current immediately before the fsynced append, so a stale, revoked or foreign session refuses and no byte is written.",
      async execute(raw, context) {
        if (context.sessionId === undefined || context.sessionId.trim() === "") {
          return usage(APPEND_ID, "appending a workflow note requires an acquired coordinator identity (CLI: pass --session-id or set MSTAR_HOST_SESSION_ID; MCP: the host must pass sessionId per call).", "sessionId");
        }
        const parsed = appendInput.safeParse(raw);
        if (!parsed.success) return decodeUsage(APPEND_ID, parsed.error, raw);
        const input = parsed.data;
        try {
          const root = resolveProcessHarnessDir(context.cwd, input.harness);
          if (root === null) return usage(APPEND_ID, "no control harness resolved; supply an absolute harness", "harness");
          const ref = decodeExecutionSessionRef(input.sessionRef);
          if (ref.workflowId !== input.workflow || ref.role !== "coordinator") {
            return usage(APPEND_ID, "sessionRef must address the selected workflow's coordinator seat", "sessionRef");
          }
          const identity: ExecutionIdentity = {
            source: context.host === undefined ? "local" : "host",
            sessionId: context.sessionId,
            workflowId: input.workflow,
            role: "coordinator",
          };
          // Provenance is the BOUND session's own scope, never a caller-supplied
          // field: the note's workflowId/sessionId are taken from the addressed
          // scope and the decoded reference, not from separate inputs.
          const receipt = await appendWorkflowNote(executionContextFor({ harnessDir: root }, identity), ref, {
            version: 1,
            id: input.id,
            workflowId: input.workflow,
            sessionId: ref.sessionId,
            kind: "note",
            ts: input.ts ?? new Date().toISOString(),
            text: input.text,
          });
          return ok(APPEND_ID, receipt);
        } catch (error) {
          return engineRefusal(APPEND_ID, error);
        }
      },
    },
    {
      id: COVERAGE_ID,
      cli: {
        path: ["workflow-note", "coverage"],
        aliases: [],
        arguments: [],
        options: [
          { key: "workflow", flags: "--workflow <id>", required: true },
          { key: "file", flags: "--file <absolute-path>", required: false, help: "Read this absolute ledger path instead of the workflow's canonical notes.jsonl." },
          { key: "harness", flags: "--harness <path>", required: false },
        ],
      },
      input: coverageInput,
      output: commandEnvelopeSchema,
      effects: ["read"],
      description: "Project one workflow's retained notes ledger into its normalized coverage facts (canonical path, format, file hash, ordered historical and accepted records, duplicate ids, unterminated tail, counts). Read-only; nothing is written.",
      async execute(raw, context) {
        const parsed = coverageInput.safeParse(raw);
        if (!parsed.success) return decodeUsage(COVERAGE_ID, parsed.error, raw);
        const input = parsed.data;
        try {
          const root = resolveProcessHarnessDir(context.cwd, input.harness);
          if (root === null) return usage(COVERAGE_ID, "no control harness resolved; supply an absolute harness", "harness");
          if (input.file !== undefined && !path.isAbsolute(input.file)) {
            return usage(COVERAGE_ID, "file must be an absolute path", "file");
          }
          const file = input.file ?? workflowNotesLedgerPath({ harnessDir: root }, input.workflow);
          const bytes = readLedgerBytes(file);
          return ok(COVERAGE_ID, normalizeWorkflowNotesCoverage({ workflowId: input.workflow, path: file, bytes }));
        } catch (error) {
          return engineRefusal(COVERAGE_ID, error);
        }
      },
    },
  ];
}
