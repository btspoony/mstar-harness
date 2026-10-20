import { isAbsolute } from "node:path";
import { CommanderError, type Command } from "commander";
import { serveMcpStdio } from "./stdio.js";

interface McpCommandOptions {
  identityEnv?: string;
  harness?: string;
}

/** A relative root is a usage refusal, never a cwd-relative guess. */
function absoluteHarness(value: string): string {
  if (!isAbsolute(value)) {
    throw new CommanderError(2, "commander.invalidArgument", `--harness must be an absolute path; got ${JSON.stringify(value)}`);
  }
  return value;
}

export function registerMcpCommand(program: Command): void {
  program.command("mcp")
    .description("Run the Morning Star MCP server over stdio")
    .option(
      "--identity-env <NAME>",
      "read the default session id from environment variable NAME and LOCK the connection identity to it when the variable resolves a usable id (one safe path component under the engine's safe-session-id rule): the tools publish no session selector and a caller-supplied sessionId is stripped before admission, so every call runs under the declared identity. An unset, blank or unsafe value keeps the connection generic and is warned about at launch, with the recovery to correct the variable or drop --identity-env and relaunch. Without it no ambient identity is read and a per-call sessionId selects the identity.",
    )
    .option(
      "--harness <path>",
      "absolute harness root for every call; it also anchors the invocation workspace at its parent, so cwd-derived paths land under the pinned harness. Without it the server probes process.cwd() for one",
      absoluteHarness,
    )
    .action(async (options: McpCommandOptions) => {
      await serveMcpStdio({ identityEnv: options.identityEnv, harnessRoot: options.harness });
    });
}
