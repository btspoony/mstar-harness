import type { Command } from "commander";
import { serveMcpStdio } from "./stdio.js";

interface McpCommandOptions {
  identityEnv?: string;
}

export function registerMcpCommand(program: Command): void {
  program.command("mcp")
    .description("Run the Morning Star MCP server over stdio")
    .option(
      "--identity-env <NAME>",
      "read the default session id from environment variable NAME; without it no ambient identity is read, and a per-call sessionId always wins",
    )
    .action(async (options: McpCommandOptions) => {
      await serveMcpStdio({ identityEnv: options.identityEnv });
    });
}
