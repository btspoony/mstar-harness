/**
 * linear-write.test.ts — SDD task 2, brief case (g2) write-side and the receipt
 * classification: the request argument names are real (observed schema), the
 * response envelope is a DOCUMENTED FIXTURE parsed strictly.
 *
 * No network, no credential: the transport is injected.
 * Run with `bun test packages/engine/src/issue-sync/linear-write.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { LinearCallOutcome } from "./linear-adapter.js";
import { createLinearWrite, LINEAR_LABEL_VERBS, LINEAR_STATE_VERBS, LINEAR_WRITE_VERBS } from "./linear-write.js";
import type { ProviderWritePayload } from "./provider.js";

const payload = (overrides: Partial<ProviderWritePayload> = {}): ProviderWritePayload => ({
  title: "A title",
  description: "body\n\n<!-- mstar-sync: acme/ENG/store-alpha/I-1 -->",
  priority: 2,
  state: "Todo",
  labels: ["bug"],
  ...overrides,
});

type Call = { tool: string; arguments: Record<string, unknown> };

function side(
  outcomes: LinearCallOutcome[],
  options: {
    listed?: readonly string[] | null;
    advertised?: Record<string, readonly string[]> | null;
    writeVerbs?: readonly string[];
    labelVerbs?: readonly string[];
    stateVerbs?: readonly string[];
    team?: string;
  } = {},
) {
  const calls: Call[] = [];
  const listed = options.listed === undefined ? ["save_issue", "list_issue_labels", "list_issue_statuses"] : options.listed;
  const advertised =
    options.advertised === undefined
      ? { save_issue: ["id", "title", "description", "priority", "state", "labels", "addLabels", "removeLabels"] }
      : options.advertised;
  const write = createLinearWrite({
    findLinearEntry: () => ({ url: "https://mcp.example/mcp" }),
    call: async (_entry, request) => {
      calls.push(request);
      const outcome = outcomes.shift();
      if (outcome === undefined) return { kind: "ok", payload: { issue: { identifier: "LIN-1" } } };
      return outcome;
    },
    listedVerbs: () => listed,
    advertisedArguments: (tool) => (advertised === null ? null : (advertised[tool] ?? null)),
    ...(options.writeVerbs === undefined ? {} : { writeVerbs: options.writeVerbs }),
    ...(options.labelVerbs === undefined ? {} : { labelVerbs: options.labelVerbs }),
    ...(options.stateVerbs === undefined ? {} : { stateVerbs: options.stateVerbs }),
    ...(options.team === undefined ? {} : { scope: { team: options.team } }),
  });
  return { write, calls };
}

describe("the verb is resolved from the handshake, never assumed", () => {
  test("the candidate sets are declared as candidates", () => {
    expect(LINEAR_WRITE_VERBS).toEqual(["save_issue"]);
    expect(LINEAR_LABEL_VERBS).toEqual(["list_issue_labels"]);
  });

  test("an absent handshake refuses by name and sends nothing", async () => {
    const { write, calls } = side([], { listed: null });
    const receipt = await write.applyWrite({ kind: "create", payload: payload() });
    expect(receipt).toMatchObject({ kind: "refused", code: "linear.host-unavailable" });
    expect((receipt as { cause: string }).cause).toContain("save_issue");
    expect(calls).toEqual([]);
  });

  test("a handshake listing no write verb refuses by name", async () => {
    const { write } = side([], { listed: ["list_issues"] });
    const receipt = await write.applyWrite({ kind: "create", payload: payload() });
    expect(receipt).toMatchObject({ kind: "refused", code: "linear.host-unavailable" });
  });
});

describe("request arguments come from the advertised schema", () => {
  test("create sends team, title, description, priority, state and addLabels (never the full-replace labels)", async () => {
    const { write, calls } = side([], { team: "ENG" });
    await write.applyWrite({ kind: "create", payload: payload() });
    const args = calls[0]!.arguments;
    expect(args).toEqual({
      team: "ENG",
      title: "A title",
      description: payload().description,
      priority: 2,
      state: "Todo",
      addLabels: ["bug"],
    });
    expect(args.labels).toBeUndefined();
    expect(calls[0]!.tool).toBe("save_issue");
  });

  test("update sends id and no team (the save schema forbids a team change alongside label edits)", async () => {
    const { write, calls } = side([], { team: "ENG" });
    await write.applyWrite({ kind: "update", externalId: "LIN-9", payload: payload() });
    const args = calls[0]!.arguments;
    expect(args.id).toBe("LIN-9");
    expect(args.team).toBeUndefined();
    expect(args.addLabels).toEqual(["bug"]);
    expect(args.removeLabels).toBeUndefined();
  });

  test("a create with no bound team refuses before any write", async () => {
    const { write, calls } = side([]);
    const receipt = await write.applyWrite({ kind: "create", payload: payload() });
    expect(receipt).toMatchObject({ kind: "refused", code: "linear.write-refused" });
    expect(calls).toEqual([]);
  });
});

describe("(g2) the recorded-label replace is refused when the schema cannot prove it", () => {
  test("removeLabels is sent with exactly the recorded label when advertised", async () => {
    const { write, calls } = side([]);
    await write.applyWrite({
      kind: "update",
      externalId: "LIN-9",
      payload: payload({ labels: ["risk"], removeLabels: ["bug"] }),
    });
    expect(calls[0]!.arguments.removeLabels).toEqual(["bug"]);
    expect(calls[0]!.arguments.addLabels).toEqual(["risk"]);
  });

  test("a handshake lacking removeLabels refuses BEFORE the write, naming the argument", async () => {
    const without = { save_issue: ["id", "title", "description", "priority", "state", "addLabels"] };
    const { write, calls } = side([], { advertised: without });
    const receipt = await write.applyWrite({
      kind: "update",
      externalId: "LIN-9",
      payload: payload({ labels: ["risk"], removeLabels: ["bug"] }),
    });
    expect(receipt).toMatchObject({ kind: "refused", code: "linear.write-refused" });
    expect((receipt as { cause: string }).cause).toContain("removeLabels");
    expect(calls).toEqual([]);
  });

  test("a handshake carrying no schema for the verb refuses the same way", async () => {
    const { write, calls } = side([], { advertised: null });
    const receipt = await write.applyWrite({
      kind: "update",
      externalId: "LIN-9",
      payload: payload({ removeLabels: ["bug"] }),
    });
    expect(receipt).toMatchObject({ kind: "refused", code: "linear.write-refused" });
    expect(calls).toEqual([]);
  });

  test("an update with no removal does NOT need the argument", async () => {
    const { write, calls } = side([], { advertised: { save_issue: ["id", "title", "addLabels"] } });
    const receipt = await write.applyWrite({ kind: "update", externalId: "LIN-9", payload: payload() });
    expect(receipt.kind).toBe("confirmed");
    expect(calls).toHaveLength(1);
  });
});

describe("the receipt is three-valued and never upgrades doubt to success", () => {
  test("a strict fixture envelope is confirmed with the identifier", async () => {
    const { write } = side([{ kind: "ok", payload: { issue: { identifier: "LIN-42", updatedAt: "2026-11-02T00:00:00Z" } } }], { team: "ENG" });
    expect(await write.applyWrite({ kind: "create", payload: payload() })).toEqual({
      kind: "confirmed",
      externalId: "LIN-42",
      updatedAt: "2026-11-02T00:00:00Z",
    });
  });

  test("`id` alone is accepted when no identifier was returned", async () => {
    const { write } = side([{ kind: "ok", payload: { issue: { id: "uuid-1" } } }], { team: "ENG" });
    expect(await write.applyWrite({ kind: "create", payload: payload() })).toMatchObject({ kind: "confirmed", externalId: "uuid-1" });
  });

  for (const [label, payloadValue] of [
    ["an embedded errors array", { errors: [{ message: "boom" }], issue: { identifier: "LIN-1" } }],
    ["a missing issue object", { ok: true }],
    ["an issue with no identifier", { issue: { title: "t" } }],
    ["a non-object payload", "ok"],
  ] as const) {
    test(`${label} is ambiguous, never success and never an invented id`, async () => {
      const { write } = side([{ kind: "ok", payload: payloadValue }], { team: "ENG" });
      const receipt = await write.applyWrite({ kind: "create", payload: payload() });
      expect(receipt.kind).toBe("ambiguous");
      expect(receipt).not.toHaveProperty("externalId");
    });
  }

  test("a transport failure is ambiguous: the mutation may already have run", async () => {
    const { write } = side([{ kind: "transport-error", message: "socket hang up" }], { team: "ENG" });
    const receipt = await write.applyWrite({ kind: "create", payload: payload() });
    expect(receipt.kind).toBe("ambiguous");
    expect(receipt).not.toHaveProperty("externalId");
  });

  test("HTTP 5xx is ambiguous and HTTP 4xx is a provable refusal", async () => {
    const server = side([{ kind: "http-status", status: 503 }], { team: "ENG" });
    const ambiguous = await server.write.applyWrite({ kind: "create", payload: payload() });
    expect(ambiguous.kind).toBe("ambiguous");
    const client = side([{ kind: "http-status", status: 422 }], { team: "ENG" });
    const receipt = await client.write.applyWrite({ kind: "create", payload: payload() });
    expect(receipt).toMatchObject({ kind: "refused", code: "linear.write-refused" });
  });
});

describe("label discovery", () => {
  test("returns the workspace label names and ignores group rows", async () => {
    const { write, calls } = side([
      { kind: "ok", payload: { labels: [{ name: "bug" }, { name: "Bug group", isGroup: true }, { name: "risk" }] } },
    ], { team: "ENG" });
    const names = await write.discoverLabels();
    expect([...names].sort()).toEqual(["bug", "risk"]);
    expect(calls[0]!.tool).toBe("list_issue_labels");
    expect(calls[0]!.arguments.team).toBe("ENG");
  });

  test("an absent discovery verb refuses the run, naming the candidates", async () => {
    const { write, calls } = side([], { listed: [] });
    await expect(write.discoverLabels()).rejects.toThrow(/list_issue_labels/);
    expect(calls).toEqual([]);
  });

  test("an unmappable discovery response refuses the run", async () => {
    const { write } = side([{ kind: "ok", payload: { items: [] } }]);
    await expect(write.discoverLabels()).rejects.toThrow(/documented envelope/);
  });

  test("a transport failure during discovery refuses the run", async () => {
    const { write } = side([{ kind: "transport-error", message: "ECONNRESET" }]);
    await expect(write.discoverLabels()).rejects.toThrow(/nothing was written/);
  });
});

describe("state discovery", () => {
  test("the candidate set is declared, and the bare-array envelope is read", () => {
    expect(LINEAR_STATE_VERBS).toEqual(["list_issue_statuses"]);
  });

  test("returns the team's workflow state names from the observed envelope", async () => {
    const { write, calls } = side(
      [
        {
          kind: "ok",
          payload: [
            { id: "s1", type: "unstarted", name: "Ready for Dev" },
            { id: "s2", type: "completed", name: "Done" },
            { id: "s3", type: "canceled", name: "Canceled" },
          ],
        },
      ],
      { team: "ENG" },
    );
    const names = await write.discoverStates();
    expect([...names].sort()).toEqual(["Canceled", "Done", "Ready for Dev"]);
    expect(calls[0]!.tool).toBe("list_issue_statuses");
    expect(calls[0]!.arguments.team).toBe("ENG");
  });

  test("an absent state verb refuses the run, naming the candidate", async () => {
    const { write, calls } = side([], { listed: ["save_issue", "list_issue_labels"] });
    await expect(write.discoverStates()).rejects.toThrow(/list_issue_statuses/);
    expect(calls).toEqual([]);
  });

  test("a label envelope is NOT accepted as a state envelope", async () => {
    // The two calls answer different shapes; one parser accepting both would
    // turn a wire change into a silent empty set that refuses every item.
    const { write } = side([{ kind: "ok", payload: { labels: [{ name: "Todo" }] } }]);
    await expect(write.discoverStates()).rejects.toThrow(/documented envelope/);
  });

  test("a transport failure during state discovery refuses the run", async () => {
    const { write } = side([{ kind: "http-status", status: 503 }]);
    await expect(write.discoverStates()).rejects.toThrow(/nothing was written/);
  });
});
