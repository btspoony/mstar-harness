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

export interface McpJsonRpcResponse {
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}
export interface McpExchangeOutcome {
  method: string;
  name: string;
  succeeded: boolean;
  errorCode?: number;
  errorMessage?: string;
}

export function summarizeMcpExchanges(exchanges: readonly McpExchangeOutcome[]): string {
  const refusalIndex = exchanges.findIndex((exchange) => exchange.method === "tools/call" && !exchange.succeeded);
  const catalogIndex = exchanges.findIndex((exchange, index) => index > refusalIndex && exchange.method === "tools/list" && exchange.succeeded);
  const correctedCall = catalogIndex < 0
    ? undefined
    : exchanges.find((exchange, index) => index > catalogIndex && exchange.method === "tools/call");
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
}
export interface McpRpcExchange {
  id: number;
  response: McpJsonRpcResponse;
}

export interface McpRpcDispatcher {
  request(method: string, params: Record<string, unknown>): Promise<McpRpcExchange>;
  receive(response: McpJsonRpcResponse): void;
  stop(reason: Error): void;
}

interface PendingMcpResponse {
  resolve: (response: McpJsonRpcResponse) => void;
  reject: (error: Error) => void;
}

export function createMcpRpcDispatcher(send: (message: Record<string, unknown>) => void): McpRpcDispatcher {
  let nextId = 0;
  let stopped: Error | null = null;
  const pending = new Map<string | number, PendingMcpResponse>();
  return {
    async request(method, params) {
      if (stopped !== null) throw stopped;
      const id = ++nextId;
      const { promise, resolve, reject } = Promise.withResolvers<McpJsonRpcResponse>();
      pending.set(id, { resolve, reject });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
      const response = await promise;
      return { id, response };
    },
    receive(response) {
      if (response.id === undefined || response.id === null) return;
      const request = pending.get(response.id);
      if (request === undefined) return;
      pending.delete(response.id);
      request.resolve(response);
    },
    stop(reason) {
      if (stopped !== null) return;
      stopped = reason;
      for (const request of pending.values()) request.reject(reason);
      pending.clear();
    },
  };
}

export function mapMcpExchangeEvent(
  method: string,
  name: string,
  id: string | null,
  response: McpJsonRpcResponse,
): Record<string, unknown> {
  const hasOutcome = Object.hasOwn(response, "result") || Object.hasOwn(response, "error");
  const toolError = response.result !== null && typeof response.result === "object"
    && "isError" in response.result && response.result.isError === true;
  const failed = !hasOutcome || response.error !== undefined || toolError;
  const status = failed ? "failed" : "completed";
  const exitCode = failed ? 1 : 0;
  const identity = id === null ? {} : { id };
  return {
    type: "item.completed",
    ...identity,
    item: {
      type: "command_execution",
      ...identity,
      command: ["mcp", method, name],
      mcp_tool_call: { ...identity, method, name, status, exit_code: exitCode },
      status,
      exit_code: exitCode,
    },
  };
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
    const stderr: string[] = [];
    let closed: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const closeDone = Promise.withResolvers<void>();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let dispatcher: McpRpcDispatcher | null = null;

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
          const response = JSON.parse(line) as McpJsonRpcResponse;
          dispatcher?.receive(response);
        } catch {
          // Preserve malformed server output as transcript evidence; no grading record is inferred.
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));

    child.on("error", (error) => dispatcher?.stop(error));
    child.on("close", (code, signal) => {
      closed = { code, signal };
      dispatcher?.stop(new Error(`MCP server exited before responding (code ${code}, signal ${signal})`));
      closeDone.resolve();
    });
    const send = (message: Record<string, unknown>): void => {
      const raw = JSON.stringify(message);
      transcript.push(`client ${raw}`);
      child.stdin.write(`${raw}\n`);
    };
    dispatcher = createMcpRpcDispatcher(send);
    const recordCall = (method: string, name: string, id: number, response: McpJsonRpcResponse) => {
      const hasOutcome = Object.hasOwn(response, "result") || Object.hasOwn(response, "error");
      const toolError = response.result !== null && typeof response.result === "object"
        && "isError" in response.result && response.result.isError === true;
      const succeeded = hasOutcome && response.error === undefined && !toolError;
      exchanges.push({
        method,
        name,
        succeeded,
        ...(response.error?.code === undefined ? {} : { errorCode: response.error.code }),
        ...(response.error?.message === undefined
          ? (hasOutcome ? {} : { errorMessage: "MCP response omitted both result and error" })
          : { errorMessage: response.error.message }),
      });
      eventRecords.push(mapMcpExchangeEvent(method, name, `mcp-${id}`, response));
    };

    const terminate = () => {
      child.kill("SIGTERM");
      if (killTimer === undefined) killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    let failure: string | null = null;
    try {
      timeout = setTimeout(() => {
        timedOut = true;
        dispatcher?.stop(new Error("MCP server request deadline exceeded"));
        terminate();
      }, request.timeoutMs);
      const { response: init } = await dispatcher!.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "skill-eval-scripted-client", version: "1" },
      });
      if (init.error) throw new Error(`MCP initialize failed: ${init.error.message ?? "unknown error"}`);
      if (!Object.hasOwn(init, "result")) throw new Error("MCP initialize response omitted result");
      send({ jsonrpc: "2.0", method: "notifications/initialized" });

      for (const action of options.actions ?? MCP_GUESS_PATH_ACTIONS) {
        const params = action.method === "tools/list"
          ? {}
          : { name: action.name, arguments: action.arguments ?? {} };
        const { id, response } = await dispatcher!.request(action.method, params);
        const name = action.method === "tools/list" ? "tools/list" : action.name;
        recordCall(action.method, name, id, response);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      dispatcher?.stop(error instanceof Error ? error : new Error(String(error)));
      terminate();
    } finally {
      child.stdin.end();
      await closeDone.promise;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      if (pending.trim() !== "") transcript.push(`server ${pending.trim()}`);
      eventRecords.push({ type: "turn.completed", usage: {} });
      writeFileSync(request.stdoutFile, `${eventRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
      writeFileSync(transcriptPath, `${transcript.join("\n")}\n`);
      writeFileSync(request.stderrFile, stderr.join("") + (failure === null ? "" : `${failure}\n`));
      const finalPathIndex = request.argv.indexOf("--output-last-message");
      if (finalPathIndex >= 0 && request.argv[finalPathIndex + 1]) {
        writeFileSync(request.argv[finalPathIndex + 1]!, summarizeMcpExchanges(exchanges));
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
