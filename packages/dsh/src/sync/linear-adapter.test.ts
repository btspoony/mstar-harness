/**
 * linear-adapter.test.ts — dsh listing adapter (mirror-import plan Task 2):
 * cursor pagination, embedded-errors failure, empty page termination, and the
 * no-credential rule, all over injected fixture transports (no live call).
 */
import { describe, expect, test } from "bun:test";
import { SyncError } from "@mstar-harness/engine";
import { createLinearAdapter, LINEAR_PAGE_SIZE, type LinearCallOutcome, type LinearListDeps } from "./linear-adapter.js";

const ENTRY = { url: "https://mcp.linear.app/sse" };
const VERBS = ["list_issues", "search_issues"];

function issue(identifier: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `uuid-${identifier}`,
    identifier,
    title: `Title ${identifier}`,
    description: `Body ${identifier}`,
    state: { name: "In Progress" },
    priority: 2,
    priorityLabel: "High",
    labels: [{ name: "bug" }, "risk"],
    updatedAt: "2026-11-01T00:00:00.000Z",
    url: `https://linear.app/acme/issue/${identifier}`,
    ...overrides,
  };
}

/** Deps whose scripted outcomes are consumed in order; records every request. */
function deps(
  outcomes: LinearCallOutcome[],
  override: Partial<LinearListDeps> = {},
): LinearListDeps & { requests: Array<{ tool: string; arguments: Record<string, unknown> }> } {
  const requests: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
  return {
    requests,
    findLinearEntry: () => ENTRY,
    call: async (_entry, request) => {
      requests.push(request);
      const next = outcomes.shift();
      if (next === undefined) throw new Error("unexpected call");
      return next;
    },
    listingVerbs: VERBS,
    ...override,
  };
}

function errorTextOf(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => {
      throw new Error("expected the call to refuse");
    },
    (error: unknown) => (error as Error).message,
  );
}

function codeOf(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => {
      throw new Error("expected the call to refuse");
    },
    (error: unknown) => {
      if (error instanceof SyncError) return error.code;
      throw error;
    },
  );
}

describe("listIssues pagination", () => {
  test("two pages advance the cursor and stop on a null nextCursor", async () => {
    const d = deps([
      { kind: "ok", payload: { issues: [issue("LIN-1"), issue("LIN-2")], nextCursor: "c-2" } },
      { kind: "ok", payload: { issues: [issue("LIN-3")], nextCursor: null } },
    ]);
    const adapter = createLinearAdapter(d);

    const first = await adapter.listIssues(null);
    expect(first.items.map((item) => item.externalId)).toEqual(["LIN-1", "LIN-2"]);
    expect(first.nextCursor).toBe("c-2");

    const second = await adapter.listIssues(first.nextCursor);
    expect(second.items.map((item) => item.externalId)).toEqual(["LIN-3"]);
    expect(second.nextCursor).toBeNull();

    // Exactly one request per page, carrying the page size and the cursor.
    expect(d.requests).toEqual([
      { tool: "list_issues", arguments: { limit: LINEAR_PAGE_SIZE } },
      { tool: "list_issues", arguments: { limit: LINEAR_PAGE_SIZE, cursor: "c-2" } },
    ]);
  });

  test("an empty page terminates the run without inventing an item", async () => {
    const d = deps([{ kind: "ok", payload: { issues: [], nextCursor: null } }]);
    expect(await createLinearAdapter(d).listIssues(null)).toEqual({ items: [], nextCursor: null });
  });

  test("an item maps to the narrow internal record", async () => {
    const d = deps([{ kind: "ok", payload: { issues: [issue("LIN-7", { priority: null, priorityLabel: undefined, labels: [] })] } }]);
    const page = await createLinearAdapter(d).listIssues(null);
    expect(page.items[0]).toEqual({
      externalId: "LIN-7",
      title: "Title LIN-7",
      description: "Body LIN-7",
      state: "In Progress",
      priority: null,
      labels: [],
      updatedAt: "2026-11-01T00:00:00.000Z",
      url: "https://linear.app/acme/issue/LIN-7",
    });
  });
});

describe("page failures (never an empty page)", () => {
  test("an embedded errors array fails the page even with partial data", async () => {
    const d = deps([{ kind: "ok", payload: { issues: [issue("LIN-1")], errors: [{ message: "Ratelimit exceeded" }] } }]);
    expect(await codeOf(() => createLinearAdapter(d).listIssues(null))).toBe("linear.query-failed");
    expect(await errorTextOf(() => createLinearAdapter(deps([{ kind: "ok", payload: { errors: [{ message: "boom" }] } }])).listIssues(null)))
      .toContain("boom");
  });

  test("an unmappable payload is a failure, not an empty project", async () => {
    for (const payload of [{}, { data: { issues: [] } }, "nope", { issues: "many" }]) {
      const d = deps([{ kind: "ok", payload }]);
      expect(await codeOf(() => createLinearAdapter(d).listIssues(null))).toBe("linear.query-failed");
    }
  });

  test("a missing required item field is a page failure", async () => {
    const d = deps([{ kind: "ok", payload: { issues: [issue("LIN-1", { updatedAt: undefined })] } }]);
    expect(await codeOf(() => createLinearAdapter(d).listIssues(null))).toBe("linear.query-failed");
  });

  test("transport and HTTP failures refuse linear.query-failed", async () => {
    expect(await codeOf(() => createLinearAdapter(deps([{ kind: "transport-error", message: "ECONNREFUSED" }])).listIssues(null))).toBe(
      "linear.query-failed",
    );
    expect(await codeOf(() => createLinearAdapter(deps([{ kind: "http-status", status: 500 }])).listIssues(null))).toBe(
      "linear.query-failed",
    );
  });

  test("no configured entry or no listing verb refuses, never lists", async () => {
    expect(
      await codeOf(() => createLinearAdapter(deps([], { findLinearEntry: () => null })).listIssues(null)),
    ).toBe("linear.query-failed");
    expect(await codeOf(() => createLinearAdapter(deps([], { listingVerbs: [] })).listIssues(null))).toBe(
      "linear.list-unimplemented",
    );
  });
});

describe("credential rule", () => {
  test("a transport message carrying a token is redacted before it reaches the refusal", async () => {
    const d = deps([
      { kind: "transport-error", message: "request failed: Authorization: Bearer lin_api_ABC1234567890 (https://user:pw@mcp.linear.app/sse)" },
    ]);
    const message = await errorTextOf(() => createLinearAdapter(d).listIssues(null));
    expect(message).not.toContain("lin_api_ABC1234567890");
    expect(message).not.toContain("user:pw");
    expect(message).toContain("[redacted]");
  });
});
