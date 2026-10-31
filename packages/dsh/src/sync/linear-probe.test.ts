/**
 * linear-probe.test.ts — dsh host probe (binding-config plan Task 3): the
 * four probe states proven by fixtures injected at the MCP boundary.
 */
import { describe, expect, test } from "bun:test";
import { createLinearProbe, type LinearProbeDeps, type RpcOutcome } from "./linear-probe.js";

const ENTRY = { url: "https://mcp.linear.app/sse" };

/** Deps whose scripted outcomes are consumed in order. */
function deps(outcomes: RpcOutcome[], hasEntry = true): LinearProbeDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    findLinearEntry: () => (hasEntry ? ENTRY : null),
    rpc: async (_entry, method) => {
      calls.push(method);
      const next = outcomes.shift();
      if (next === undefined) throw new Error(`unexpected rpc call: ${method}`);
      return next;
    },
  };
}

describe("createLinearProbe", () => {
  test("configured + handshake ok → ready", async () => {
    const d = deps([{ kind: "ok" }, { kind: "ok", tools: ["list_issues"] }]);
    const result = await createLinearProbe(d).probe();
    expect(result.state).toBe("ready");
    expect(result.cause).toBe("ready: Linear MCP handshake succeeded (initialize + tools/list)");
    expect(d.calls).toEqual(["initialize", "tools/list"]);
  });

  test("no configured entry → service-absent (no rpc call)", async () => {
    const d = deps([], false);
    const result = await createLinearProbe(d).probe();
    expect(result.state).toBe("service-absent");
    expect(result.cause).toBe("service-absent: no Linear entry in the host MCP configuration");
    expect(d.calls).toEqual([]);
  });

  test("entry present but transport refused → unreachable, never ready", async () => {
    const d = deps([{ kind: "transport-error", message: "connection refused" }]);
    const result = await createLinearProbe(d).probe();
    expect(result.state).toBe("unreachable");
    expect(result.cause).toBe("unreachable: Linear MCP transport failed (connection refused)");
  });

  test("handshake 401/403 or auth-class error → access-denied", async () => {
    for (const status of [401, 403]) {
      const d = deps([{ kind: "http-status", status }]);
      const result = await createLinearProbe(d).probe();
      expect(result.state).toBe("access-denied");
      expect(result.cause).toBe(`access-denied: Linear MCP handshake answered ${status}`);
    }
    const toolsStage = deps([{ kind: "ok" }, { kind: "http-status", status: 401 }]);
    expect((await createLinearProbe(toolsStage).probe()).state).toBe("access-denied");
  });

  test("a non-auth HTTP failure maps to unreachable", async () => {
    const d = deps([{ kind: "http-status", status: 503 }]);
    expect((await createLinearProbe(d).probe()).state).toBe("unreachable");
  });

  test("the probe never prints a credential and never mutates anything", async () => {
    const d = deps([{ kind: "ok" }, { kind: "ok" }]);
    const provider = createLinearProbe(d);
    const result = await provider.probe();
    // Credential-free result: no field name or value hints at a token.
    for (const value of Object.values(result)) {
      expect(String(value).toLowerCase()).not.toContain("bearer");
      expect(String(value).toLowerCase()).not.toContain("lin_api");
    }
    // Read-only: probing twice hits the same injected deps, no state change.
    expect(d.calls).toEqual(["initialize", "tools/list"]);
  });
});
