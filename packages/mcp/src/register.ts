import type { McpServer } from "@modelcontextprotocol/server";
import type { CommandDefinition, InvocationContext } from "@mstar-harness/commands";

export type ResolveContext = (
  definition: CommandDefinition,
  input: unknown,
) => InvocationContext | Promise<InvocationContext>;

export function mcpToolName(commandId: string): string {
  return `mstar_${commandId.replace(/[.-]/g, "_")}`;
}

export function registerMcpCommands(
  server: McpServer,
  definitions: readonly CommandDefinition[],
  resolveContext: ResolveContext,
): void {
  const tools = definitions.map((definition) => ({ definition, name: mcpToolName(definition.id) }));
  const names = new Set<string>();

  for (const { definition, name } of tools) {
    if (names.has(name)) {
      throw new Error(`MCP tool name collision: ${name} (from command ${definition.id})`);
    }
    names.add(name);
  }

  for (const { definition, name } of tools) {
    server.registerTool(name, {
      description: definition.description,
      inputSchema: definition.input,
      outputSchema: definition.output,
    }, async (input) => {
      const envelope = await definition.execute(input, await resolveContext(definition, input));
      const validated = definition.output.safeParse(envelope);
      if (!validated.success) {
        throw new Error(`Command ${definition.id} returned an invalid output envelope: ${validated.error.message}`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(validated.data) }],
        structuredContent: validated.data,
        isError: validated.data.status !== "ok",
      };
    });
  }
}
