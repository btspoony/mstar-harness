/**
 * Scripted MCP stdio client used by the bounded-resolution evaluator scenario.
 * The raw protocol exchange is retained beside the grading stream; every tool
 * request is separately translated into the runner's native invocation record.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import type { SpawnFn, SpawnRequest, SpawnResult } from "./runner.ts";
interface McpLaunchConfig {
  command: string;
  args: string[];
}

export type ScriptedMcpAction =
  | Readonly<{ method: "tools/list" }>
  | Readonly<{ method: "tools/call"; name: string; arguments?: Record<string, unknown> }>;

export const MCP_GUESS_PATH_ACTIONS = [
  { method: "tools/call", name: "mstar_schem" },
  { method: "tools/list" },
  { method: "tools/call", name: "mstar_schema", arguments: { type: "CaptureInput" } },
] as const satisfies readonly ScriptedMcpAction[];

export interface McpClientLaunchOptions {
  cliPath: string;
  actions?: readonly ScriptedMcpAction[];
  nodePath?: string;
}

interface JsonRpcResponse {
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}
interface McpExchangeOutcome {
  method: string;
  name: string;
  succeeded: boolean;
  errorCode?: number;
  errorMessage?: string;
}

/**
 * Launch the built CLI's MCP stdio server and drive it with fixed JSON-RPC
 * requests. stdoutFile receives only native evaluator event records; raw
 * request/response bytes are archived to a sibling transcript file.
 */
export function createMcpClientLaunch(options: McpClientLaunchOptions): SpawnFn {
  return async (request: SpawnRequest): Promise<SpawnResult> => {
    const config = JSON.parse(readFileSync(join(request.cwd, "mcp.json"), "utf8")) as McpLaunchConfig;
    const args = config.args.map((arg) => arg === "${MSTAR_CLI_PATH}" ? options.cliPath : arg);
    const child = spawn(options.nodePath ?? config.command, args, {
      cwd: request.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const transcriptPath = join(dirname(request.stdoutFile), "mcp-transcript.jsonl");
    const transcript: string[] = [];
    const eventRecords: Record<string, unknown>[] = [
      { type: "thread.started", thread_id: `mcp-${process.pid}-${Date.now()}` },
    ];
    const exchanges: McpExchangeOutcome[] = [];
    let pending = "";
    const responses = new Map<string | number, (response: JsonRpcResponse) => void>();
    const stderr: string[] = [];
    let nextId = 0;
    let closed: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const closeDone = Promise.withResolvers<void>();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const failPending = (error: Error) => {
      for (const resolveResponse of responses.values()) {
        resolveResponse({ error: { message: error.message } });
      }
      responses.clear();
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line === "") continue;
        transcript.push(`server ${line}`);
        try {
          const response = JSON.parse(line) as JsonRpcResponse;
          if (response.id !== undefined && response.id !== null) {
            const resolveResponse = responses.get(response.id);
            if (resolveResponse) {
              responses.delete(response.id);
              resolveResponse(response);
            }
          }
        } catch {
          // Preserve malformed server output as transcript evidence; no grading record is inferred.
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));
    child.on("error", (error) => failPending(error));
    child.on("close", (code, signal) => {
      closed = { code, signal };
      failPending(new Error(`MCP server exited before responding (code ${code}, signal ${signal})`));
      closeDone.resolve();
    });

    const send = (message: Record<string, unknown>): void => {
      const raw = JSON.stringify(message);
      transcript.push(`client ${raw}`);
      child.stdin.write(`${raw}\n`);
    };
    const ask = async (method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> => {
      const id = ++nextId;
      const { promise, resolve } = Promise.withResolvers<JsonRpcResponse>();
      responses.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
      return promise;
    };
    const recordCall = (method: string, name: string, id: number, response: JsonRpcResponse) => {
      const toolError = response.result !== null && typeof response.result === "object"
        && "isError" in response.result && response.result.isError === true;
      const succeeded = response.error === undefined && !toolError;
      const status = succeeded ? "completed" : "failed";
      const exitCode = succeeded ? 0 : 1;
      exchanges.push({
        method,
        name,
        succeeded,
        ...(response.error?.code === undefined ? {} : { errorCode: response.error.code }),
        ...(response.error?.message === undefined ? {} : { errorMessage: response.error.message }),
      });
      eventRecords.push({
        type: "item.completed",
        id: `mcp-${id}`,
        item: {
          type: "command_execution",
          id: `mcp-${id}`,
          command: ["mcp", method, name],
          mcp_tool_call: { id: `mcp-${id}`, method, name, status, exit_code: exitCode },
          status,
          exit_code: exitCode,
        },
      });
    };
    const finalMessage = (): string => {
      const refusalIndex = exchanges.findIndex((exchange) => exchange.method === "tools/call" && !exchange.succeeded);
      const catalogIndex = exchanges.findIndex((exchange, index) => index > refusalIndex && exchange.method === "tools/list" && exchange.succeeded);
      const correctedCall = exchanges.find((exchange, index) => index > catalogIndex && exchange.method === "tools/call");
      return [
        ...(refusalIndex < 0 ? [] : [
          exchanges[refusalIndex]!.errorCode === undefined
            ? exchanges[refusalIndex]!.errorMessage ?? "tool call failed"
            : `error ${exchanges[refusalIndex]!.errorCode}: ${exchanges[refusalIndex]!.errorMessage ?? "tool call failed"}`,
        ]),
        ...(catalogIndex < 0 ? [] : ["tools/list catalog returned"]),
        ...(refusalIndex >= 0 && catalogIndex > refusalIndex && correctedCall?.succeeded
          ? ["corrected call succeeded"]
          : []),
      ].join("\n");
    };

    let failure: string | null = null;
    try {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, request.timeoutMs);
      const init = await ask("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "skill-eval-scripted-client", version: "1" },
      });
      if (init.error) throw new Error(`MCP initialize failed: ${init.error.message ?? "unknown error"}`);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });

      for (const action of options.actions ?? MCP_GUESS_PATH_ACTIONS) {
        const params = action.method === "tools/list"
          ? {}
          : { name: action.name, arguments: action.arguments ?? {} };
        const response = await ask(action.method, params);
        const name = action.method === "tools/list" ? "tools/list" : action.name;
        recordCall(action.method, name, nextId, response);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      child.kill("SIGTERM");
    } finally {
      child.stdin.end();
      clearTimeout(timeout);
      await closeDone.promise;
      if (pending.trim() !== "") transcript.push(`server ${pending.trim()}`);
      eventRecords.push({ type: "turn.completed", usage: {} });
      writeFileSync(request.stdoutFile, `${eventRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
      writeFileSync(transcriptPath, `${transcript.join("\n")}\n`);
      writeFileSync(request.stderrFile, stderr.join("") + (failure === null ? "" : `${failure}\n`));
      const finalPathIndex = request.argv.indexOf("--output-last-message");
      if (finalPathIndex >= 0 && request.argv[finalPathIndex + 1]) {
        writeFileSync(request.argv[finalPathIndex + 1]!, finalMessage());
      }
    }
    return {
      code: failure === null ? closed?.code ?? 0 : null,
      signal: closed?.signal ?? null,
      timedOut,
      spawnError: failure,
    } satisfies SpawnResult;
  };
}
