import { isAbsolute } from "node:path";
import { CommanderError, type Command } from "commander";
import { serveMcpStdio, type McpSeat } from "./stdio.js";

interface McpCommandOptions {
  identityEnv?: string;
  harness?: string;
  workspace?: string;
  seat?: string;
}

/** A relative root is a usage refusal, never a cwd-relative guess. */
function absolutePath(flag: string) {
  return (value: string): string => {
    if (!isAbsolute(value)) {
      throw new CommanderError(2, "commander.invalidArgument", `${flag} must be an absolute path; got ${JSON.stringify(value)}`);
    }
    return value;
  };
}

/** The only seat a launcher can declare; an unknown seat would silently drop the restriction. */
function seatValue(value: string): McpSeat {
  if (value !== "leaf") {
    throw new CommanderError(2, "commander.invalidArgument", `--seat must be "leaf"; got ${JSON.stringify(value)}`);
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
      absolutePath("--harness"),
    )
    .option(
      "--workspace <path>",
      "absolute session workspace every call runs from (the invocation cwd). A mounting host that serves sessions living outside its own cwd passes this so cwd-derived paths resolve in the CALLER's workspace; without it the workspace is the pinned harness's parent when --harness is set, else process.cwd()",
      absolutePath("--workspace"),
    )
    .option(
      "--seat <seat>",
      'declare the connection\'s seat: "leaf" refuses the coordinator-seat commands (plan.bind, plan.complete) for this connection before execution, with the named cause and recovery, while every other command stays reachable',
      seatValue,
    )
    .action(async (options: McpCommandOptions) => {
      await serveMcpStdio({
        identityEnv: options.identityEnv,
        harnessRoot: options.harness,
        workspace: options.workspace,
        ...(options.seat === undefined ? {} : { seat: options.seat as McpSeat }),
      });
    });
}
