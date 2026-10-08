/**
 * family-refusal.ts — the one shared reader from a thrown engine error to the
 * structured refusal facts a family wrapper must preserve, plus the one shared
 * projection from a schema rejection to structured diagnostics.
 *
 * Each family keeps its own envelope construction (its command id, its routing
 * facts, its untyped-failure outcome). What is NOT family-specific is the facts
 * an engine-authored error carries: its `code`, its `details` record and the
 * `recovery` line that lives inside those details. Re-simplifying any of them to
 * a message-only wrapper is the defect this module prevents, by giving every
 * family the same reader instead of a hand-rolled check per call site.
 *
 * This is a reader, not a second refusal contract: it builds no envelope and
 * invents no fact. Absent facts come back `undefined` and the caller decides
 * the fallback.
 */
import type { z } from "zod";
import type { RefusalDiagnostic } from "../envelope.js";

export type EngineErrorFacts = Readonly<{
  code: string | undefined;
  details: Record<string, unknown> | undefined;
  recovery: string | undefined;
}>;

/**
 * The facts one thrown value carries. A typed engine error is an `Error` with a
 * string `code`, an optional record `details`, and its recovery text either as
 * a top-level string or under `details.recovery` (the execution refusal shapes
 * author it there); both are the same fact, so either placement is read.
 */
export function engineErrorFacts(error: unknown): EngineErrorFacts {
  const record: Record<string, unknown> | undefined =
    error !== null && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const rawCode = record === undefined ? undefined : record.code;
  const rawDetails = record === undefined ? undefined : record.details;
  const rawRecovery = record === undefined ? undefined : record.recovery;
  const code = typeof rawCode === "string" ? rawCode : undefined;
  const details =
    rawDetails !== null && typeof rawDetails === "object" && !Array.isArray(rawDetails)
      ? (rawDetails as Record<string, unknown>)
      : undefined;
  const recovery =
    typeof rawRecovery === "string" ? rawRecovery : typeof details?.recovery === "string" ? details.recovery : undefined;
  return { code, details, recovery };
}

/**
 * One shared-shape diagnostic per schema issue, in issue order: the field path,
 * the stable issue code, the message and the first array index. A family that
 * decodes its own input still owes the caller the same structured facts the
 * canonical admission emits; a joined message alone loses every fact past the
 * first. Values are never echoed — only the family's own schema text.
 */
export function decodeDiagnostics(error: z.ZodError): RefusalDiagnostic[] {
  return error.issues.map((issue) => {
    const index = issue.path.find((part) => typeof part === "number");
    const path = issue.path.reduce<string>(
      (prefix, part) =>
        typeof part === "number" ? `${prefix}[${String(part)}]` : prefix === "" ? String(part) : `${prefix}.${String(part)}`,
      "",
    );
    return {
      path,
      code: issue.code,
      message: issue.message,
      ...(typeof index === "number" ? { index } : {}),
    };
  });
}
