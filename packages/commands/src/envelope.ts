import type { CommandEnvelope } from "./types.js";

export type RefusalDiagnostic = Readonly<{
  path?: string;
  code: string;
  message: string;
  helpRoute?: string;
  index?: number;
}>;

type RefusalInputFields = Readonly<{
  command: string;
  code: string;
  message: string;
  helpRoute: string;
  recovery: string;
  diagnostics: readonly RefusalDiagnostic[];
  rejected?: Readonly<{ path: string; expected: string; received: string }>;
  details?: Record<string, unknown>;
}>;

export type RefusalInput = RefusalInputFields & (
  | Readonly<{ status: "usage"; exitCode: 2 }>
  | Readonly<{ status: "refused"; exitCode: 1 }>
);

/** Build the shared refusal shape without rewriting engine-authored messages. */
export function refusalEnvelope(input: RefusalInput): CommandEnvelope<never> {
  const { diagnostics, helpRoute, recovery, details, rejected } = input;
  const message = rejected === undefined || rejected.path.trim() === ""
    ? input.message
    : `Rejected ${rejected.path}: expected ${rejected.expected}; received ${rejected.received}`;
  const envelopeDetails = { ...details, diagnostics, helpRoute, recovery };
  if (input.status === "refused") {
    return {
      version: 1, command: input.command, status: "refused", code: input.code, exitCode: 1,
      message: `${input.message}\nHelp: ${helpRoute}\nRecovery: ${recovery}`,
      details: envelopeDetails,
    };
  }
  return {
    version: 1, command: input.command, status: "usage", code: input.code, exitCode: 2,
    message, details: envelopeDetails,
  };
}
