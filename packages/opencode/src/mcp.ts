import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { resolveProcessHarnessDir } from "@mstar-harness/engine";
import { executeCommand, getCommandDefinitions, type CommandDefinition, type InvocationContext, type CliSyntax } from "@mstar-harness/commands";
import { createMcpEffects, mcpToolName } from "@mstar-harness/mcp";
export type OpenCodeMcpTool = ToolDefinition;
const versions: InvocationContext["versions"] = Object.freeze({
  engine: null,
  cli: null,
  plugin: null,
  host: null,
  platform: process.platform,
});


function inputSchema(definition: CommandDefinition) {
  if (definition.id !== "judgment.review-advice") return definition.input;
  if (!("extend" in definition.input) || typeof definition.input.extend !== "function") {
    throw new Error("judgment.review-advice must have an object input schema");
  }
  return definition.input.extend({ input: tool.schema.string().optional() });
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
  if (definition.id === "report" || !("shape" in definition.input)) return "opencode";
  const shape = definition.input.shape;
  if (shape === null || typeof shape !== "object" || !Object.hasOwn(shape, "host")) return "opencode";
  if (input === null || typeof input !== "object" || !("host" in input) || typeof input.host !== "string") return "opencode";
  return input.host;
}
export type OpenCodeMcpServices = Map<string, Array<{ close(): Promise<void> }>>;

export async function closeOpenCodeMcpSession(servicesBySession: OpenCodeMcpServices, sessionId: string): Promise<void> {
  const services = servicesBySession.get(sessionId);
  if (services === undefined) return;
  servicesBySession.delete(sessionId);
  await Promise.allSettled(services.map((service) => service.close()));
}

export function createOpenCodeMcpTools(servicesBySession: OpenCodeMcpServices): Record<string, OpenCodeMcpTool> {
  const definitions = getCommandDefinitions();
  const registeredNames = new Set<string>();
  const tools: Record<string, OpenCodeMcpTool> = {};
  for (const definition of definitions) {
    const name = mcpToolName(definition.id);
    if (registeredNames.has(name)) throw new Error(`OpenCode MCP tool name collision: ${name} (from command ${definition.id})`);
    registeredNames.add(name);
    const schema = inputSchema(definition);

    tools[name] = tool({
      description: definition.description,
      args: schema.shape,
      async execute(params, context) {

        const nativeContext = context;
        let sessionServices = servicesBySession.get(nativeContext.sessionID);
        if (sessionServices === undefined) {
          sessionServices = [];
          servicesBySession.set(nativeContext.sessionID, sessionServices);
        }
        const effects = createMcpEffects(sessionServices);
        const selector = definition.cli.options.find((option: CliSyntax["options"][number]) => option.context === "sessionId");
        const requestContext: InvocationContext = Object.freeze({
          cwd: nativeContext.directory,
          controlRoot: resolveProcessHarnessDir(nativeContext.directory),
          host: hostForContext(definition, params),
          ...(selector === undefined ? {} : { sessionId: nativeContext.sessionID }),
          versions,
          signal: nativeContext.abort ?? new AbortController().signal,
          effects,
        });
        const result = await effects.withInput(params, requestContext, () =>
          executeCommand(definition.id, handlerInput(definition, params), requestContext),
        );
        return JSON.stringify(result);
      },
    });
  }
  return tools;
}
