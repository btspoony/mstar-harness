import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { resolveProcessHarnessDir } from "@mstar-harness/engine";
import { executeCommand, getCommandDefinitions, type CommandDefinition, type InvocationContext } from "@mstar-harness/commands";
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
export function createOpenCodeMcpTools(services: Array<{ close(): Promise<void> }>): Record<string, OpenCodeMcpTool> {
  const definitions = getCommandDefinitions();
  const registeredNames = new Set<string>();
  const effects = createMcpEffects(services);
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
        const selector = definition.cli.options.find((option) => option.context === "sessionId");
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
