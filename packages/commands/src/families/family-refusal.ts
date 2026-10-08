/**
 * family-refusal.ts — the shared reader from a thrown engine error to the
 * structured refusal facts a family wrapper must preserve.
 *
 * Each family keeps its own envelope construction (its command id, its routing
 * facts, its untyped-failure outcome). What is NOT family-specific is the facts
 * an engine-authored error carries: its `code`, its `details` record and its
 * `recovery` line. Re-simplifying any of them to a message-only wrapper is the
 * defect this module prevents, by giving every family the same reader.
 *
 * This is a reader, not a second refusal contract: it builds no envelope and
 * invents no fact. Absent facts come back `undefined` and the caller decides
 * the fallback.
 */

export type EngineErrorFacts = Readonly<{
  code: string | undefined;
  details: Record<string, unknown> | undefined;
  recovery: string | undefined;
}>;

/**
 * The facts one thrown value carries. A typed engine error is an `Error` with a
 * string `code`, an optional record `details`, and its recovery text either as
 * a top-level string or under `details.recovery`.
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
