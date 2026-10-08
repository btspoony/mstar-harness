import type { CommandEnvelope } from "./types.js";

export type RefusalDiagnostic = Readonly<{
  path?: string;
  code: string;
  message: string;
  helpRoute?: string;
  index?: number;
  expected?: string;
  received?: string;
}>;

type RefusalInputFields = Readonly<{
  command: string;
  code: string;
  message: string;
  helpRoute?: string;
  recovery?: string;
  diagnostics?: readonly RefusalDiagnostic[];
  rejected?: Readonly<{ path: string; expected: string; received: string }>;
  details?: Record<string, unknown>;
}>;

export type RefusalInput = RefusalInputFields & (
  | Readonly<{ status: "usage"; exitCode: 2 }>
  | Readonly<{ status: "refused"; exitCode: number }>
);

const SUMMARY_LIMIT = 2400;
const SUMMARY_ENTRIES = 20;

function boundedFact(value: string): string {
  return value.length > 100 ? `${value.slice(0, 99)}…` : value;
}

function diagnosticSummary(diagnostics: readonly RefusalDiagnostic[]) {
  const lines = [`${diagnostics.length} input issues:`];
  let length = lines[0]!.length;
  let shown = 0;
  for (const diagnostic of diagnostics) {
    if (shown === SUMMARY_ENTRIES) break;
    const line = diagnostic.path !== undefined && diagnostic.expected !== undefined && diagnostic.received !== undefined
      ? `Rejected ${boundedFact(diagnostic.path)}: expected ${boundedFact(diagnostic.expected)}; received ${boundedFact(diagnostic.received)}`
      : boundedFact(diagnostic.message);
    // Reserve space for the counts/recovery pointer before adding any entry.
    if (length + line.length + 1 > SUMMARY_LIMIT - 120) break;
    lines.push(line);
    length += line.length + 1;
    shown++;
  }
  const omitted = diagnostics.length - shown;
  lines.push(`${shown} shown; ${omitted} omitted. Full diagnostics: details.diagnostics.`);
  return { message: lines.join("\n"), counts: { total: diagnostics.length, shown, omitted } };
}

/** Build the shared refusal shape without rewriting engine-authored messages. */
export function refusalEnvelope(input: RefusalInput): CommandEnvelope<never> {
  const helpRoute = input.helpRoute ?? `mstar ${input.command.replaceAll(".", " ")} --help`;
  const recovery = input.recovery ?? (input.status === "usage"
    ? `Run ${helpRoute} and correct the flagged input.`
    : undefined);
  const { diagnostics, details, rejected } = input;
  const summary = input.status === "usage" && diagnostics !== undefined && diagnostics.length > 1
    ? diagnosticSummary(diagnostics)
    : undefined;
  const message = summary?.message ?? (rejected === undefined || rejected.path.trim() === ""
    ? input.message
    : `Rejected ${rejected.path}: expected ${rejected.expected}; received ${rejected.received}`);
  const envelopeDetails = {
    ...details,
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(summary === undefined ? {} : { diagnosticSummary: summary.counts }),
    helpRoute,
    ...(recovery === undefined ? {} : { recovery }),
  };
  if (input.status === "refused") {
    return {
      version: 1, command: input.command, status: "refused", code: input.code, exitCode: input.exitCode,
      message: `${input.message}\nHelp: ${helpRoute}${recovery === undefined ? "" : `\nRecovery: ${recovery}`}`,
      details: envelopeDetails,
    };
  }
  return {
    version: 1, command: input.command, status: "usage", code: input.code, exitCode: 2,
    message, details: envelopeDetails,
  };
}

