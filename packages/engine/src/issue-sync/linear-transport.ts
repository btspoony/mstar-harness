/**
 * Streamable-HTTP transport for the Linear MCP entry.
 *
 * The adapter and probe above take their I/O as injected capabilities so they
 * can be driven by fixtures. This module is the one real implementation: a
 * minimal JSON-RPC client over the MCP streamable-HTTP transport, used by the
 * command layer so that `issue-sync import` has a working host without every
 * host re-implementing the wire format.
 *
 * Deliberate limits, all of them visible as a typed outcome rather than a
 * throw: one request per call (no batching), no reconnect, and a deadline that
 * aborts the fetch. A server that answers with an SSE frame is parsed; anything
 * the client cannot classify becomes `transport-error` carrying a message that
 * is redacted before it reaches a cause.
 */
import { DEFAULT_PROBE_DEADLINE_MS, redactTransportMessage, type RpcOutcome } from "./linear-probe.js";
import type { LinearCallOutcome } from "./linear-adapter.js";

/** Credential + endpoint the transport needs; absent token means "no auth header". */
export type LinearTransportOptions = {
  url: string;
  /** Bearer token, when the deployment holds one; OAuth hosts pass nothing. */
  token?: string;
  /** Extra static headers (deployment-specific routing). */
  headers?: Record<string, string>;
  deadlineMs?: number;
};

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
};

let nextId = 1;

function authHeaders(options: LinearTransportOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // Streamable HTTP servers may answer either with a plain JSON body or with
    // an SSE stream; the MCP spec requires the client to accept both.
    accept: "application/json, text/event-stream",
    ...options.headers,
  };
  if (options.token !== undefined && options.token !== "") headers.authorization = `Bearer ${options.token}`;
  return headers;
}

/** Pull the first JSON-RPC payload out of a response body (plain JSON or SSE). */
function parseBody(raw: string): JsonRpcResponse | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      return null;
    }
  }
  // SSE: one `data: <json>` line per frame; the first parseable frame wins.
  for (const line of trimmed.split("\n")) {
    const match = /^data:\s*(.*)$/.exec(line.trim());
    if (match === null) continue;
    try {
      return JSON.parse(match[1]!) as JsonRpcResponse;
    } catch {
      continue;
    }
  }
  return null;
}

async function post(options: LinearTransportOptions, body: unknown): Promise<
  | { kind: "ok"; response: JsonRpcResponse }
  | { kind: "transport-error"; message: string }
  | { kind: "http-status"; status: number }
> {
  const deadline = options.deadlineMs ?? DEFAULT_PROBE_DEADLINE_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadline);
  try {
    const response = await fetch(options.url, {
      method: "POST",
      headers: authHeaders(options),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return { kind: "http-status", status: response.status };
    const parsed = parseBody(await response.text());
    if (parsed === null) {
      return { kind: "transport-error", message: "the response carried no JSON-RPC payload" };
    }
    return { kind: "ok", response: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "transport-error", message: redactTransportMessage(message) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One JSON-RPC request. `initialize` and `tools/list` answer with a tool list;
 * both are enough for the probe's two-call handshake.
 */
export async function linearRpc(
  options: LinearTransportOptions,
  method: "initialize" | "tools/list",
): Promise<RpcOutcome> {
  const params =
    method === "initialize"
      ? { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "mstar", version: "1" } }
      : {};
  const outcome = await post(options, { jsonrpc: "2.0", id: nextId++, method, params });
  if (outcome.kind !== "ok") return outcome;
  const { response } = outcome;
  if (response.error !== undefined) {
    return { kind: "transport-error", message: redactTransportMessage(response.error.message ?? "json-rpc error") };
  }
  if (method === "initialize") return { kind: "ok" };
  const result = response.result as { tools?: Array<{ name?: unknown }> } | undefined;
  const tools = Array.isArray(result?.tools)
    ? result.tools.map((tool) => (typeof tool?.name === "string" ? tool.name : "")).filter((name) => name !== "")
    : [];
  return { kind: "ok", tools };
}

/** One read-only `tools/call`; the payload is returned unmapped for the adapter. */
export async function linearCall(
  options: LinearTransportOptions,
  request: { tool: string; arguments: Record<string, unknown> },
): Promise<LinearCallOutcome> {
  const outcome = await post(options, {
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name: request.tool, arguments: request.arguments },
  });
  if (outcome.kind !== "ok") return outcome;
  const { response } = outcome;
  if (response.error !== undefined) {
    return { kind: "transport-error", message: redactTransportMessage(response.error.message ?? "json-rpc error") };
  }
  const result = response.result as { structuredContent?: unknown; content?: Array<{ text?: unknown }> } | undefined;
  if (result?.structuredContent !== undefined) return { kind: "ok", payload: result.structuredContent };
  // Text-only tool results carry the payload as a JSON string.
  const text = Array.isArray(result?.content)
    ? result.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
    : "";
  if (text.trim() !== "") {
    try {
      return { kind: "ok", payload: JSON.parse(text) as unknown };
    } catch {
      return { kind: "transport-error", message: "the tool result text was not JSON" };
    }
  }
  return { kind: "ok", payload: result?.structuredContent ?? null };
}
