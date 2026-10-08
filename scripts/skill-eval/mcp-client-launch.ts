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
  jsonrpc?: unknown;
  id?: string | number | null;
  result?: unknown;
  error?: unknown;
}

export interface McpExchangeOutcome {
  identity: string | null;
  method: string;
  name: string;
  status: "succeeded" | "failed" | "interrupted";
  errorCode?: number;
  errorMessage?: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function classifyMcpResponse(input: {
  identity: string | null;
  method: string;
  name: string;
  requestId: string | number;
  response: McpJsonRpcResponse;
  expectedToolName?: string;
}): McpExchangeOutcome {
  const { identity, method, name, requestId, response } = input;
  const base = { identity, method, name };
  const hasResult = Object.hasOwn(response, "result");
  const hasError = Object.hasOwn(response, "error");
  const invalid = (detail: string): McpExchangeOutcome => ({
    ...base,
    status: "failed",
    errorMessage: `invalid MCP response: ${detail}`,
  });
  if (response.jsonrpc !== "2.0" || response.id !== requestId || hasResult === hasError) {
    return invalid("expected JSON-RPC 2.0 response with matching id and exactly one result or error");
  }
  if (hasError) {
    const error = response.error;
    if (!isObjectRecord(error) || typeof error.code !== "number"
      || typeof error.message !== "string" || error.message.trim() === "") {
      return invalid("error response requires numeric code and non-empty string message");
    }
    return { ...base, status: "failed", errorCode: error.code, errorMessage: error.message };
  }

  const result = response.result;
  if (!isObjectRecord(result)) return invalid(`${method} result must be an object`);
  if (method === "tools/list") {
    const tools = result.tools;
    if (!Array.isArray(tools) || tools.length === 0
      || !tools.every((tool) => isObjectRecord(tool) && typeof tool.name === "string" && tool.name.length > 0)) {
      return invalid("tools/list result must contain a non-empty named tools array");
    }
    if (input.expectedToolName !== undefined && !tools.some((tool) => isObjectRecord(tool) && tool.name === input.expectedToolName)) {
      return invalid(`tools/list result omitted corrected tool ${input.expectedToolName}`);
    }
  } else if (method === "tools/call") {
    const content = result.content;
    if (!Array.isArray(content) || content.length === 0
      || !content.every((item) => isObjectRecord(item) && typeof item.type === "string")) {
      return invalid("tools/call result must contain non-empty valid content blocks");
    }
    if ("isError" in result && typeof result.isError !== "boolean") {
      return invalid("tools/call isError must be boolean");
    }
    if (name === "mstar_schema" && !content.some((item) => isObjectRecord(item)
      && item.type === "text" && typeof item.text === "string" && item.text.includes("CaptureInput"))) {
      return invalid("mstar_schema tools/call result must include the requested CaptureInput schema text");
    }
    if (result.isError === true) {
      return { ...base, status: "failed", errorMessage: "MCP tools/call result set isError" };
    }
  } else {
    return invalid(`unsupported MCP method ${method}`);
  }
  return { ...base, status: "succeeded" };
}

export function summarizeMcpExchanges(exchanges: readonly McpExchangeOutcome[]): string {
  const refusalIndex = exchanges.findIndex((exchange) => exchange.method === "tools/call" && exchange.status !== "succeeded");
  const catalogIndex = exchanges.findIndex((exchange, index) => index > refusalIndex
    && exchange.method === "tools/list" && exchange.status === "succeeded");
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
    ...(refusalIndex >= 0 && catalogIndex > refusalIndex && correctedCall?.status === "succeeded"
      ? ["corrected call succeeded"]
      : []),
  ].join("\n");
}

export interface McpRpcRequest {
  id: number;
  response: Promise<McpJsonRpcResponse>;
}

export interface McpRpcDispatcher {
  request(method: string, params: Record<string, unknown>): McpRpcRequest;
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
    request(method, params) {
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
      return { id, response: promise };
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

function nativeMcpEvent(
  eventType: "item.started" | "item.completed",
  method: string,
  name: string,
  identity: string | null,
  status: string,
  exitCode?: number,
  reason?: string,
): Record<string, unknown> {
  const eventIdentity = identity === null ? {} : { id: identity };
  const item: Record<string, unknown> = {
    type: "command_execution",
    ...eventIdentity,
    command: ["mcp", method, name],
    mcp_tool_call: { ...eventIdentity, method, name, status, ...(exitCode === undefined ? {} : { exit_code: exitCode }) },
    status,
  };
  if (exitCode !== undefined) item.exit_code = exitCode;
  if (reason !== undefined) item.reason = reason;
  return { type: eventType, ...eventIdentity, item };
}

export function mapMcpInvocationStartedEvent(method: string, name: string, identity: string | null): Record<string, unknown> {
  return nativeMcpEvent("item.started", method, name, identity, "pending");
}

export function mapMcpExchangeEvent(outcome: McpExchangeOutcome): Record<string, unknown> {
  if (outcome.status === "interrupted") {
    return nativeMcpEvent("item.completed", outcome.method, outcome.name, outcome.identity, "unknown", undefined, outcome.errorMessage);
  }
  const succeeded = outcome.status === "succeeded";
  return nativeMcpEvent(
    "item.completed",
    outcome.method,
    outcome.name,
    outcome.identity,
    succeeded ? "completed" : "failed",
    succeeded ? 0 : 1,
    outcome.errorMessage,
  );
}

export function mapMcpInterruptedEvent(outcome: McpExchangeOutcome, reason: string): Record<string, unknown> {
  return nativeMcpEvent("item.completed", outcome.method, outcome.name, outcome.identity, "unknown", undefined, reason);
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
    const recordCall = async (
      method: string,
      name: string,
      ticket: McpRpcRequest,
      expectedToolName?: string,
    ) => {
      const identity = `mcp-${ticket.id}`;
      eventRecords.push(mapMcpInvocationStartedEvent(method, name, identity));
      try {
        const response = await ticket.response;
        const outcome = classifyMcpResponse({
          identity,
          method,
          name,
          requestId: ticket.id,
          response,
          expectedToolName,
        });
        exchanges.push(outcome);
        eventRecords.push(mapMcpExchangeEvent(outcome));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const interrupted: McpExchangeOutcome = { identity, method, name, status: "interrupted", errorMessage: reason };
        exchanges.push(interrupted);
        eventRecords.push(mapMcpInterruptedEvent(interrupted, reason));
        throw error;
      }
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
      const initialize = dispatcher!.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "skill-eval-scripted-client", version: "1" },
      });
      const { response: init } = await initialize.response;
      if (init.jsonrpc !== "2.0" || init.id !== initialize.id || !Object.hasOwn(init, "result") || Object.hasOwn(init, "error")) {
        throw new Error("MCP initialize response has an invalid JSON-RPC envelope");
      }
      if (init.result === null || typeof init.result !== "object" || Array.isArray(init.result)
        || !("serverInfo" in init.result) || !("capabilities" in init.result)) {
        throw new Error("MCP initialize result is missing serverInfo or capabilities");
      }
      send({ jsonrpc: "2.0", method: "notifications/initialized" });

      const actions = options.actions ?? MCP_GUESS_PATH_ACTIONS;
      for (let index = 0; index < actions.length; index += 1) {
        const action = actions[index]!;
        const params = action.method === "tools/list"
          ? {}
          : { name: action.name, arguments: action.arguments ?? {} };
        const ticket = dispatcher!.request(action.method, params);
        const name = action.method === "tools/list" ? "tools/list" : action.name;
        let expectedToolName: string | undefined;
        if (action.method === "tools/list") {
          for (let nextIndex = index + 1; nextIndex < actions.length; nextIndex += 1) {
            const next = actions[nextIndex]!;
            if (next.method === "tools/call") {
              expectedToolName = next.name;
              break;
            }
          }
        }
        await recordCall(action.method, name, ticket, expectedToolName);
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
      const completed = failure === null && !timedOut;
      if (completed) eventRecords.push({ type: "turn.completed", usage: {} });
      writeFileSync(request.stdoutFile, `${eventRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
      writeFileSync(transcriptPath, `${transcript.join("\n")}\n`);
      writeFileSync(request.stderrFile, stderr.join("") + (failure === null ? "" : `${failure}\n`));
      const finalPathIndex = request.argv.indexOf("--output-last-message");
      if (completed && finalPathIndex >= 0 && request.argv[finalPathIndex + 1]) {
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
