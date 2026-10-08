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

/** Build the shared refusal shape without rewriting engine-authored messages. */
export function refusalEnvelope(input: RefusalInput): CommandEnvelope<never> {
  const helpRoute = input.helpRoute ?? `mstar ${input.command.replaceAll(".", " ")} --help`;
  const recovery = input.recovery ?? (input.status === "usage"
    ? `Run ${helpRoute} and correct the flagged input.`
    : undefined);
  const { diagnostics, details, rejected } = input;
  const message = rejected === undefined || rejected.path.trim() === ""
    ? input.message
    : `Rejected ${rejected.path}: expected ${rejected.expected}; received ${rejected.received}`;
  const envelopeDetails = {
    ...details,
    ...(diagnostics === undefined ? {} : { diagnostics }),
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

