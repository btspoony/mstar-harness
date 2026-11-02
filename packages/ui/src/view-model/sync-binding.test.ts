/**
 * The binding view's transform: identity, correspondence, readiness.
 *
 * The rules asserted here are the ones Task 4's screen renders and cannot
 * invent: a state is never shown without the cause the read supplied, the
 * five readiness states stay distinct, and a missing `[linear]` declaration
 * is not the same answer as a probe nobody ran.
 */
import { describe, expect, test } from "bun:test";
import type { SyncBindingDTO } from "@mstar-harness/engine";

import { syncBindingModel } from "./sync-binding.ts";

const BOUND: SyncBindingDTO["binding"] = { enabled: true, mode: "mirror", workspace: "acme", team: "ENG" };

function dto(over: Partial<SyncBindingDTO> = {}): SyncBindingDTO {
  return {
    binding: BOUND,
    bindingError: null,
    projectBindings: [{ projectId: "_default", remoteProject: "MST-BACKLOG" }],
    readiness: { state: "ready", cause: "ready: linear-mcp answered initialize and tools/list" },
    ...over,
  };
}

describe("identity", () => {
  test("a bound .mstarc summary passes through verbatim", () => {
    expect(syncBindingModel(dto()).identity).toEqual({ kind: "bound", ...BOUND });
  });

  test("a null binding carries the reader's refusal, never a readiness state", () => {
    const message = "linear.binding-absent: .mstarc declares no [linear] section";
    const notProbed = "not-probed: readiness is host-owned; no probe result was supplied";
    const model = syncBindingModel(
      dto({ binding: null, bindingError: message, readiness: { state: "not-probed", cause: notProbed } }),
    );
    expect(model.identity).toEqual({ kind: "unbound", message });
    expect(model.identity).not.toHaveProperty("state");
    // The same payload with nobody probing: the unbound answer and the unasked
    // question are two different answers and stay two different records.
    expect(model.readiness).toEqual({ kind: "probed", state: "not-probed", cause: notProbed, tone: "neutral" });
  });
});

describe("correspondence", () => {
  test("rows pass through verbatim", () => {
    const rows = [
      { projectId: "_default", remoteProject: "MST-BACKLOG" },
      { projectId: "engine", remoteProject: "MST-ENGINE" },
    ];
    expect(syncBindingModel(dto({ projectBindings: rows })).correspondence).toEqual({ kind: "populated", value: rows });
  });

  test("an empty list stays empty while the binding is still bound", () => {
    const model = syncBindingModel(dto({ projectBindings: [] }));
    expect(model.correspondence).toEqual({ kind: "empty" });
    expect(model.identity.kind).toBe("bound");
  });
});

describe("readiness", () => {
  test("a state without a cause is refused", () => {
    const model = syncBindingModel(dto({ readiness: { state: "ready", cause: "   " } }));
    expect(model.readiness).toEqual({ kind: "refused", reason: "readiness.ready carries no cause" });
  });

  test("each state keeps its own cause", () => {
    const pairs = [
      ["ready", "ready: linear-mcp answered initialize and tools/list", "success"],
      ["service-absent", "service-absent: the host declares no linear-mcp entry", "warning"],
      ["unreachable", "unreachable: the handshake did not answer within the probe deadline", "warning"],
      ["access-denied", "access-denied: the credential was rejected or has expired", "danger"],
      ["not-probed", "not-probed: readiness is host-owned; no probe result was supplied", "neutral"],
    ] as const;
    for (const [state, cause, tone] of pairs) {
      expect(syncBindingModel(dto({ readiness: { state, cause } })).readiness).toEqual({
        kind: "probed",
        state,
        cause,
        tone,
      });
    }
  });
});

test("no record carries a token or credential field", () => {
  const model = syncBindingModel(dto());
  const keys: string[] = [];
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      walk(child);
    }
  };
  walk(model);
  expect(keys.filter((key) => /token|secret|credential/i.test(key))).toEqual([]);
});
