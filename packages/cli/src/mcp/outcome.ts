import { commandEnvelopeSchema, type CommandDefinition, type CommandEnvelope } from "@mstar-harness/commands";

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
  return failure.data;
}
