import { isAbsolute } from "node:path";
import { CommanderError, type Command } from "commander";
import { serveMcpStdio, type McpSeat } from "./stdio.js";

interface McpCommandOptions {
  workspace?: string;
  seat?: string;
  trustCallerSessionId?: boolean;
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
      "--workspace <path>",
      "absolute session workspace every call runs from (the invocation cwd), for a mounting host whose caller works outside the harness root's parent. Without it the workspace is the declared control root's parent directory; a connection that declares no root instead runs from its own launch directory, which a root-free command may not read or write by default, so declaring this flag is also how a mounting host names the directory harness.scaffold may bootstrap",
      absolutePath("--workspace"),
    )
    .option(
      "--seat <seat>",
      'declare the connection\'s seat: "leaf" refuses the coordinator-seat commands for this connection before execution, with the named cause and recovery. Those commands are the two classes that need a coordinator seat: those that establish or replace one (bind or complete a plan, recover a session, launch a child under the caller\'s verified live coordinator binding) and the workflow-scope writes (delivery evidence, lifecycle, close, adoption, coordinator notes, iteration registration). The set is derived from the command layer (`coordinator-seat.ts` in @mstar-harness/commands), which both this connection and the dsh host guard read, so it is not restated here. The remaining commands are not additionally restricted by this seat filter; each keeps its own input and authorization requirements',
      seatValue,
    )
    .option(
      "--trust-caller-session-id",
      "DANGEROUS, default OFF: trust a caller-declared `sessionId` as an execution identity on this connection. An MCP server is a child process with no host-proven caller identity, so the default connection publishes no session selector and refuses a supplied one; enabling this lets any caller that knows a live coordinator session id act as it. Enable it only for a deployment whose callers are already authenticated by a channel this server owns. The host-proven routes stay available either way: the dsh native tools (plan bind, audit report validation, execution clear) and the CLI",
    )
    .action(async (options: McpCommandOptions) => {
      await serveMcpStdio({
        workspace: options.workspace,
        ...(options.seat === undefined ? {} : { seat: options.seat as McpSeat }),
        ...(options.trustCallerSessionId === true ? { trustCallerSessionId: true } : {}),
      });
    });
}
