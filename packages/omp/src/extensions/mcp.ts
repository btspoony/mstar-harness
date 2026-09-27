import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { resolveProcessHarnessDir } from "@mstar-harness/engine";
import { executeCommand, getCommandDefinitions, type CommandDefinition, type InvocationContext } from "@mstar-harness/commands";
import { createMcpEffects, mcpToolName } from "@mstar-harness/mcp";

const versions: InvocationContext["versions"] = Object.freeze({
  engine: null,
  cli: null,
  plugin: null,
  host: null,
  platform: process.platform,
});

function inputSchema(definition: CommandDefinition, z: ExtensionAPI["zod"]) {
  if (definition.id !== "judgment.review-advice") return definition.input;
  if (!("extend" in definition.input) || typeof definition.input.extend !== "function") {
    throw new Error("judgment.review-advice must have an object input schema");
  }
  return definition.input.extend({ input: z.string().optional() });
}

function handlerInput(definition: CommandDefinition, input: unknown): unknown {
  if (input === null || typeof input !== "object") return input;
  const normalized = { ...(input as Record<string, unknown>) };
  for (const option of definition.cli.options) {
    if (option.context === "sessionId") delete normalized[option.key];
  }
  if (definition.id === "judgment.review-advice" && normalized.input !== undefined) {
    delete normalized.input;
    normalized.stdin = true;
  }
  return normalized;
}

function hostForContext(definition: CommandDefinition, input: unknown): string {
  if (definition.id === "report" || !("shape" in definition.input)) return "omp";
  const shape = definition.input.shape;
  if (shape === null || typeof shape !== "object" || !Object.hasOwn(shape, "host")) return "omp";
  if (input === null || typeof input !== "object" || !("host" in input) || typeof input.host !== "string") return "omp";
  return input.host;
}

function registerCommands(pi: ExtensionAPI, services: Array<{ close(): Promise<void> }>): void {
  const z = pi.zod;
  const definitions = getCommandDefinitions();
  const registeredNames = new Set<string>();
  const effects = createMcpEffects(services);

  for (const definition of definitions) {
    const name = mcpToolName(definition.id);
    if (registeredNames.has(name)) throw new Error(`OMP MCP tool name collision: ${name} (from command ${definition.id})`);
    registeredNames.add(name);

    pi.registerTool({
      name,
      label: definition.id.replace(/[.-]/g, " "),
      description: definition.description,
      parameters: inputSchema(definition, z),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const selector = definition.cli.options.find((option) => option.context === "sessionId");
        const requestSignal = signal ?? new AbortController().signal;
        const requestContext: InvocationContext = Object.freeze({
          cwd: ctx.cwd,
          controlRoot: resolveProcessHarnessDir(ctx.cwd),
          host: hostForContext(definition, params),
          ...(selector === undefined ? {} : { sessionId: ctx.sessionManager.getSessionId() }),
          versions,
          signal: requestSignal,
          effects,
        });
        const result = await effects.withInput(params, requestContext, () =>
          executeCommand(definition.id, handlerInput(definition, params), requestContext),
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: { mstarCommand: result },
          isError: result.status !== "ok",
        };
      },
    });
  }
}

export default function mcp(pi: ExtensionAPI): void {
  const services: Array<{ close(): Promise<void> }> = [];
  registerCommands(pi, services);
  pi.on("session_shutdown", async () => {
    const running = services.splice(0);
    await Promise.allSettled(running.map(({ close }) => Promise.resolve().then(close)));
  });
}
