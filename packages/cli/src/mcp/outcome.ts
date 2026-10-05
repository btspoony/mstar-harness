import { commandEnvelopeSchema, refusalEnvelope, type CommandDefinition, type CommandEnvelope, type RefusalDiagnostic } from "@mstar-harness/commands";

export function validateCommandOutcome(
  definition: CommandDefinition,
  envelope: unknown,
): CommandEnvelope {
  const result = envelope !== null && typeof envelope === "object" ? envelope as Record<string, unknown> : null;
  if (result === null || result.command !== definition.id) {
    throw new Error(`Command ${definition.id} returned an invalid output envelope: command identity mismatch`);
  }
  if (result.status === "ok") {
    const success = definition.output.safeParse(envelope);
    if (!success.success) {
      throw new Error(`Command ${definition.id} returned an invalid success envelope: ${success.error.message}`);
    }
    return success.data;
  }
  const failure = commandEnvelopeSchema.safeParse(envelope);
  if (!failure.success || failure.data.status === "ok") {
    throw new Error(`Command ${definition.id} returned an invalid failure envelope: ${failure.success ? "expected a non-success status" : failure.error.message}`);
  }
  const outcome = failure.data;
  if (outcome.status === "error") return outcome;

  const details = outcome.details ?? {};
  const helpRoute = typeof details.helpRoute === "string"
    ? details.helpRoute
    : `mstar ${definition.id.replaceAll(".", " ")} --help`;
  const recovery = typeof details.recovery === "string" ? details.recovery : undefined;
  let message = outcome.message;
  if (outcome.status === "refused") {
    const suffix = `\nHelp: ${helpRoute}${recovery === undefined ? "" : `\nRecovery: ${recovery}`}`;
    if (message.endsWith(suffix)) message = message.slice(0, -suffix.length);
  }
  const { diagnostics, helpRoute: _helpRoute, recovery: _recovery, ...extraDetails } = details;
  const refusal = {
    command: outcome.command,
    code: outcome.code,
    message,
    helpRoute,
    ...(recovery === undefined ? {} : { recovery }),
    ...(Array.isArray(diagnostics) ? { diagnostics: diagnostics as RefusalDiagnostic[] } : {}),
    ...(Object.keys(extraDetails).length === 0 ? {} : { details: extraDetails }),
  };
  return outcome.status === "usage"
    ? refusalEnvelope({ ...refusal, status: "usage", exitCode: 2 })
    : refusalEnvelope({ ...refusal, status: "refused", exitCode: 1 });
}
