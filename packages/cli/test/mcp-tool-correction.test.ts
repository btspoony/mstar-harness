import { describe, expect, test } from "bun:test";
import { McpServer, type Transport } from "@modelcontextprotocol/server";
import { correctiveMessage, withToolCorrection } from "../src/mcp/correction.js";

type Message = Parameters<NonNullable<Transport["onmessage"]>>[0];

function linkedTransports() {
  let serverOnMessage: Transport["onmessage"];
  let clientOnMessage: Transport["onmessage"];
  const serverTransport: Transport = {
    start: async () => {}, close: async () => {},
    async send(message) { clientOnMessage?.(message); },
    get onmessage() { return serverOnMessage; },
    set onmessage(handler) { serverOnMessage = handler; },
  };
  const clientTransport: Transport = {
    start: async () => {}, close: async () => {},
    async send(message) { serverOnMessage?.(message); },
    get onmessage() { return clientOnMessage; },
    set onmessage(handler) { clientOnMessage = handler; },
  };
  return { serverTransport, clientTransport };
}

async function startTestServer(decorated: boolean) {
  const { serverTransport, clientTransport } = linkedTransports();
  const server = new McpServer({ name: "correction-test", version: "1" });
  server.registerTool("mstar_version", { description: "Return a test version", inputSchema: {} }, async () => ({
    content: [{ type: "text", text: "registered-handler-ran" }],
  }));
  await server.connect(decorated
    ? withToolCorrection(serverTransport, () => ["mstar_version"])
    : serverTransport);

  let nextId = 0;
  const responseHandlers = new Map<string | number, (message: Message) => void>();
  clientTransport.onmessage = (message) => {
    if ("id" in message && message.id !== null && !("method" in message)) {
      responseHandlers.get(message.id)?.(message);
    }
  };
  async function request(method: string, params: Record<string, unknown> = {}) {
    const id = ++nextId;
    const response = new Promise<Message>((resolve) => responseHandlers.set(id, resolve));
    await clientTransport.send({ jsonrpc: "2.0", id, method, params });
    const result = await response;
    responseHandlers.delete(id);
    return result;
  }
  const initialize = await request("initialize", {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test-client", version: "1" },
  });
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { request, initialize, clientTransport, server };
}

describe("MCP tool correction", () => {
  test("suggests the intended plan issue tool and directory route", () => {
    const message = correctiveMessage("mstar_plan_issue", ["mstar_plan_issue_add", "mstar_plan_show"]);
    expect(message).toContain("mstar_plan_issue_add");
    expect(message).toContain("tools/list");
  });

  test("matches separator and case variants exactly", () => {
    expect(correctiveMessage("MSTAR.PLAN.ISSUE-ADD", ["mstar_plan_issue_add"]))
      .toContain("Did you mean mstar_plan_issue_add?");
  });

  test("selects the nearest tool within two edits", () => {
    expect(correctiveMessage("mstar_plan_isssue_add", ["mstar_plan_issue_add", "mstar_plan_issue_remove"]))
      .toContain("mstar_plan_issue_add");
  });

  test("prefers the closest edit-distance candidate over a longer prefix", () => {
    expect(correctiveMessage("mstar_plan", ["mstar_plan_ab", "mstar_plans"]))
      .toContain("Did you mean mstar_plans?");
  });

  test("breaks equal edit-distance ties lexicographically", () => {
    expect(correctiveMessage("mstar_abd", ["mstar_abf", "mstar_abc"]))
      .toContain("Did you mean mstar_abc?");
  });

  test("does not guess for a distant name", () => {
    const message = correctiveMessage("mstar_completely_unrelated", ["mstar_plan_issue_add"]);
    expect(message).toContain("tools/list");
    expect(message).not.toContain("Did you mean");
  });

  test("executes a registered known tool through the decorated SDK transport", async () => {
    const { request } = await startTestServer(true);
    const response = await request("tools/call", { name: "mstar_version", arguments: {} });
    expect(response).toMatchObject({ result: { content: [{ text: "registered-handler-ran" }] } });
  });
  test("corrects the SDK's real unknown-tool refusal end to end", async () => {
    const { request } = await startTestServer(true);
    const response = await request("tools/call", { name: "mstar_missing", arguments: {} });
    expect(response).toMatchObject({
      error: {
        code: -32602,
        message: expect.stringContaining("Call tools/list for the full catalog."),
      },
    });
  });

  test("tools/list through the decorated transport matches the undecorated SDK catalog", async () => {
    const decorated = await startTestServer(true);
    const undecorated = await startTestServer(false);
    const decoratedList = await decorated.request("tools/list");
    const undecoratedList = await undecorated.request("tools/list");
    expect(decoratedList).toEqual(undecoratedList);
  });

  test("tracks string ids, preserves ids across outbound requests, and clears only on responses", async () => {
    const sent: Message[] = [];
    let inbound: Transport["onmessage"];
    const transport: Transport = {
      start: async () => {}, close: async () => {}, send: async (message) => { sent.push(message); },
      get onmessage() { return inbound; }, set onmessage(handler) { inbound = handler; },
    };
    const wrapped = withToolCorrection(transport, () => ["mstar_plan_issue_add"]);
    wrapped.onmessage = () => {};
    const emit = (message: Message) => inbound?.(message);
    const missingCall = { jsonrpc: "2.0", id: "same-id", method: "tools/call", params: { name: "mstar_plan_issue" } } as const;
    emit(missingCall);
    await wrapped.send({ jsonrpc: "2.0", id: "same-id", method: "sampling/createMessage", params: {} });
    await wrapped.send({ jsonrpc: "2.0", id: "same-id", error: { code: -32602, message: "Tool mstar_plan_issue not found" } });
    expect(sent[1]).toMatchObject({ id: "same-id", error: { message: expect.stringContaining("mstar_plan_issue_add") } });

    emit(missingCall);
    await wrapped.send({ jsonrpc: "2.0", id: "same-id", result: {} });
    await wrapped.send({ jsonrpc: "2.0", id: "same-id", error: { code: -32602, message: "Tool mstar_plan_issue not found" } });
    expect(sent[3]).toMatchObject({ error: { message: "Tool mstar_plan_issue not found" } });

    emit(missingCall);
    await wrapped.send({ jsonrpc: "2.0", id: "same-id", error: { code: -32602, message: "Tool mstar_plan_issue not found" } });
    expect(sent[4]).toMatchObject({ error: { message: expect.stringContaining("mstar_plan_issue_add") } });
  });
  test("cancellation clears a pending id without producing a settlement", async () => {
    const sent: Message[] = [];
    const received: Message[] = [];
    let inbound: Transport["onmessage"];
    const transport: Transport = {
      start: async () => {}, close: async () => {}, send: async (message) => { sent.push(message); },
      get onmessage() { return inbound; }, set onmessage(handler) { inbound = handler; },
    };
    const wrapped = withToolCorrection(transport, () => ["mstar_plan_issue_add"]);
    wrapped.onmessage = (message) => received.push(message);
    const emit = (message: Message) => inbound?.(message);
    emit({ jsonrpc: "2.0", id: "cancelled-id", method: "tools/call", params: { name: "mstar_plan_issue" } });
    const cancellation = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "cancelled-id" } } as const;
    emit(cancellation);
    expect(received[1]).toEqual(cancellation);
    expect(sent).toHaveLength(0);

    const lateError = { jsonrpc: "2.0", id: "cancelled-id", error: { code: -32602, message: "Tool mstar_plan_issue not found" } } as const;
    await wrapped.send(lateError);
    expect(sent[0]).toEqual(lateError);
    emit({ jsonrpc: "2.0", id: "cancelled-id", method: "tools/call", params: { name: "mstar_plan_issue" } });
    await wrapped.send(lateError);
    expect(sent[1]).toMatchObject({ error: { message: expect.stringContaining("mstar_plan_issue_add") } });
    emit({ jsonrpc: "2.0", id: "closed-id", method: "tools/call", params: { name: "mstar_plan_issue" } });
    const closeHandler = () => {};
    wrapped.onclose = closeHandler;
    await wrapped.close();
    expect(wrapped.onclose).toBe(closeHandler);
    const closedError = { ...lateError, id: "closed-id" };
    await wrapped.send(closedError);
    expect(sent[2]).toEqual(closedError);
  });
});
