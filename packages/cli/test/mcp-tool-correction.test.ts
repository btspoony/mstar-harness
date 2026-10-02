import { describe, expect, test } from "bun:test";
import type { Transport } from "@modelcontextprotocol/server";
import { correctiveMessage, withToolCorrection } from "../src/mcp/correction.js";

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

  test("does not guess for a distant name", () => {
    const message = correctiveMessage("mstar_completely_unrelated", ["mstar_plan_issue_add"]);
    expect(message).toContain("tools/list");
    expect(message).not.toContain("Did you mean");
  });

  test("rewrites only the matching unknown-call refusal and forwards normal responses", async () => {
    const sent: unknown[] = [];
    let inbound: ((message: never) => void) | undefined;
    const transport: Transport = {
      start: async () => {}, close: async () => {}, send: async (message) => { sent.push(message); },
      get onmessage() { return inbound; },
      set onmessage(handler) { inbound = handler as ((message: never) => void) | undefined; },
    };
    const wrapped = withToolCorrection(transport, () => ["mstar_plan_issue_add"]);
    wrapped.onmessage = () => {};
    inbound?.({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mstar_plan_issue" } } as never);
    await wrapped.send({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Tool mstar_plan_issue not found" } });
    expect(sent[0]).toMatchObject({ id: 1, error: { code: -32602, message: expect.stringContaining("mstar_plan_issue_add") } });
    inbound?.({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mstar_version" } } as never);
    const successfulCall = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "3.11.2" }] } } as const;
    await wrapped.send(successfulCall);
    expect(sent[1]).toEqual(successfulCall);
    inbound?.({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} } as never);
    const listing = { jsonrpc: "2.0", id: 3, result: { tools: [{ name: "mstar_version" }] } } as const;
    await wrapped.send(listing);
    expect(sent[2]).toEqual(listing);
  });
});
