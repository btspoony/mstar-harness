import type { Command } from "commander";
import { serveMcpStdio } from "./stdio.js";

export function registerMcpCommand(program: Command): void {
  program.command("mcp")
    .description("Run the Morning Star MCP server over stdio")
    .action(async () => {
      await serveMcpStdio();
    });
}
