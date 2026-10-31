/**
 * linear-probe.test.ts — dsh host probe (binding-config plan Task 3): the four
 * probe states proven by fixtures injected at the MCP boundary, plus the QC
 * wave's F1 (deadline), F2 (redaction), F3 (listing verb) and F9 (no
 * fabricated page).
 */
import { describe, expect, test } from "bun:test";
import { createLinearProbe, redactTransportMessage, type LinearProbeDeps, type RpcOutcome } from "./linear-probe.js";

const ENTRY = { url: "https://mcp.linear.app/sse" };
const LISTING_VERBS = ["list_issues", "search_issues"];

/** Deps whose scripted outcomes are consumed in order. */
function deps(
  outcomes: RpcOutcome[],
  hasEntry = true,
  override: Partial<LinearProbeDeps> = {},
): LinearProbeDeps & { calls: string[] } {
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
    listingVerbs: LISTING_VERBS,
    ...override,
  };
}

const OK_INIT: RpcOutcome = { kind: "ok" };
const OK_TOOLS: RpcOutcome = { kind: "ok", tools: ["get_issue", "list_issues"] };

describe("createLinearProbe", () => {
  test("configured + handshake ok + listing verb listed → ready", async () => {
    const d = deps([OK_INIT, OK_TOOLS]);
    const result = await createLinearProbe(d).probe();
    expect(result.state).toBe("ready");
    expect(result.cause).toBe("ready: Linear MCP handshake succeeded and lists list_issues");
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
    const toolsStage = deps([OK_INIT, { kind: "http-status", status: 401 }]);
    expect((await createLinearProbe(toolsStage).probe()).state).toBe("access-denied");
  });

  test("a non-auth HTTP failure maps to unreachable", async () => {
    const d = deps([{ kind: "http-status", status: 503 }]);
    expect((await createLinearProbe(d).probe()).state).toBe("unreachable");
  });

  test("F1: a transport that never settles yields unreachable at the deadline instead of hanging", async () => {
    const hang: LinearProbeDeps = {
      findLinearEntry: () => ENTRY,
      listingVerbs: LISTING_VERBS,
      deadlineMs: 20,
      rpc: () => new Promise<RpcOutcome>(() => {}),
    };
    const started = Date.now();
    const result = await createLinearProbe(hang).probe();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.state).toBe("unreachable");
    expect(result.cause).toBe("unreachable: Linear MCP handshake timed out after 20ms");
  });

  test("F1: the deadline also covers the second call", async () => {
    let call = 0;
    const d: LinearProbeDeps = {
      findLinearEntry: () => ENTRY,
      listingVerbs: LISTING_VERBS,
      deadlineMs: 20,
      rpc: () => {
        call += 1;
        return call === 1 ? Promise.resolve(OK_INIT) : new Promise<RpcOutcome>(() => {});
      },
    };
    const result = await createLinearProbe(d).probe();
    expect(result.state).toBe("unreachable");
    expect(result.cause).toContain("timed out after 20ms");
  });

  test("F2: a credential in the transport message is redacted out of the cause", async () => {
    const leaky = "request failed: Authorization: Bearer lin_api_9f8e7d6c5b4a headers accepted, token=supersecretvalue";
    const d = deps([{ kind: "transport-error", message: leaky }]);
    const result = await createLinearProbe(d).probe();
    expect(result.state).toBe("unreachable");
    expect(result.cause).not.toContain("lin_api_9f8e7d6c5b4a");
    expect(result.cause).not.toContain("supersecretvalue");
    expect(result.cause).not.toContain("9f8e7d6c5b4a");
    expect(result.cause).toContain("[redacted]");
  });

  test("F2: redaction covers the shapes a JWT and an api key take", () => {
    const redacted = redactTransportMessage(
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc api_key="lin_api_abcdef123456"',
    );
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redacted).not.toContain("lin_api_abcdef123456");
    expect(redacted).toContain("[redacted]");
  });

  test("F3: handshake ok but NO listing verb → never ready, cause names what was missing", async () => {
    const d = deps([OK_INIT, { kind: "ok", tools: ["get_issue", "get_project"] }]);
    const result = await createLinearProbe(d).probe();
    expect(result.state).not.toBe("ready");
    expect(result.state).toBe("service-absent");
    expect(result.cause).toContain("no updatedAt-filtered listing verb");
    expect(result.cause).toContain("list_issues, search_issues");
  });

  test("F3: an empty tools page is not ready either", async () => {
    const d = deps([OK_INIT, { kind: "ok", tools: [] }]);
    expect((await createLinearProbe(d).probe()).state).toBe("service-absent");
  });

  test("F9: listIssues throws a named not-implemented instead of a fabricated empty page", async () => {
    const provider = createLinearProbe(deps([]));
    await expect(provider.listIssues(null)).rejects.toThrow(/\[linear\.list-unimplemented\]/);
  });

  test("the probe never prints a credential and never mutates anything", async () => {
    const d = deps([OK_INIT, OK_TOOLS]);
    const provider = createLinearProbe(d);
    const result = await provider.probe();
    for (const value of Object.values(result)) {
      expect(String(value).toLowerCase()).not.toContain("bearer");
      expect(String(value).toLowerCase()).not.toContain("lin_api");
    }
    expect(d.calls).toEqual(["initialize", "tools/list"]);
  });
});
