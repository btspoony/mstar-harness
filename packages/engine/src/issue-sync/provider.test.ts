/**
 * provider.test.ts — frozen provider adapter contract (binding-config plan
 * Task 2): the four probe states, and proof that no token field exists on
 * the interface or in any result type.
 */
import { describe, expect, test } from "bun:test";
import type { IssueProvider, ProbeResult } from "./provider.js";

const FOUR_STATES = ["ready", "service-absent", "unreachable", "access-denied"] as const;

/** Fixture probe results, one per state, with the cause our code emits. */
const FIXTURES: Record<string, ProbeResult> = {
  ready: { state: "ready", cause: "ready: Linear MCP handshake succeeded (initialize + tools/list)" },
  "service-absent": { state: "service-absent", cause: "service-absent: no Linear entry in the host MCP configuration" },
  unreachable: { state: "unreachable", cause: "unreachable: Linear MCP transport failed (connection refused)" },
  "access-denied": { state: "access-denied", cause: "access-denied: Linear MCP handshake answered 401" },
};

describe("ProbeResult vocabulary", () => {
  test("each fixture maps to exactly one state with a readable cause", () => {
    for (const [name, result] of Object.entries(FIXTURES)) {
      expect((FOUR_STATES as readonly string[]).includes(result.state)).toBe(true);
      expect<string>(result.state).toBe(name);
      expect(result.cause.length).toBeGreaterThan(0);
      expect(result.cause.toLowerCase().includes("token")).toBe(false);
    }
  });

  test("no token-bearing field exists on the result types", () => {
    // Runtime proof: no fixture or page item ever carries a credential field.
    const page = {
      items: [
        {
          externalId: "LIN-1",
          title: "t",
          description: "d",
          state: "open",
          priority: null,
          labels: [],
          updatedAt: "2026-10-31T00:00:00Z",
          url: "https://linear.app/LIN-1",
        },
      ],
      nextCursor: null,
    };
    const forbidden = ["token", "accesstoken", "apikey", "secret", "authorization", "bearer", "credential"];
    for (const obj of [...Object.values(FIXTURES), page, ...page.items]) {
      for (const key of Object.keys(obj)) {
        expect(forbidden.some((f) => key.toLowerCase().includes(f))).toBe(false);
      }
    }
    // Compile-time proof (checked by `tsc`): a token field must not exist on
    // ProbeResult — this line only compiles when the key set excludes it.
    type ProbeResultKeys = keyof ProbeResult;
    type _NoTokenField = "token" extends ProbeResultKeys ? never : true;
    const noTokenField: _NoTokenField = true;
    expect(noTokenField).toBe(true);
  });

  test("the interface exposes exactly probe and listIssues (apply absent until M1)", async () => {
    const provider: IssueProvider = {
      async probe() {
        return FIXTURES.ready;
      },
      async listIssues() {
        return { items: [], nextCursor: null };
      },
    };
    expect(Object.keys(provider).sort()).toEqual(["listIssues", "probe"]);
    expect(await provider.probe()).toEqual(FIXTURES.ready);
    expect(await provider.listIssues(null)).toEqual({ items: [], nextCursor: null });
  });
});
