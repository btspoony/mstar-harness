/** OpenCode's native hook identity and decision-only capability contract. */
import { describe, expect, test } from "bun:test";
import {
  encodeExecutionSessionRef,
  ExecutionError,
  type ExecutionSessionRef,
} from "@mstar-harness/engine";
import {
  openCodeNativeAssociationDecision,
  openCodeExecutionIdentity,
  resumeOpenCodeExecutionSession,
} from "../src/mstar.js";
const scope = { workflowId: "wf-opencode", role: "coordinator" as const, planId: null };
const reference: ExecutionSessionRef = {
  storeId: "11111111-1111-1111-1111-111111111111",
  epoch: 1,
  workflowId: scope.workflowId,
  role: scope.role,
  sessionId: "native-opencode-session",
  planId: null,
};

describe("OpenCode native execution identity", () => {
  test("uses the hook sessionID and ignores the spawn target", () => {
    const identity = openCodeExecutionIdentity({ sessionID: "native-opencode-session" }, scope);
    expect(identity).toEqual({
      source: "host",
      sessionId: reference.sessionId,
      workflowId: scope.workflowId,
      role: scope.role,
      planId: null,
    });
  });
  test("missing or blank native identity refuses before any store access", () => {
    expect(() => openCodeExecutionIdentity({}, scope)).toThrow(/session id/);
    expect(() => openCodeExecutionIdentity({ sessionID: "   " }, scope)).toThrow(/session id/);
  });

  test("a copied native identity cannot resume a reference for another session", async () => {
    const wire = encodeExecutionSessionRef(reference);
    await expect(
      resumeOpenCodeExecutionSession(
        { harnessDir: "/fixture" },
        { sessionID: "copied-session" },
        scope,
        wire,
      ),
    ).rejects.toBeInstanceOf(ExecutionError);
  });

  test("reports native association as unsupported decision-only", () => {
    expect(openCodeNativeAssociationDecision({ sessionID: "native-opencode-session" })).toEqual({
      kind: "unsupported",
      capability: "decision-only",
      sessionId: "native-opencode-session",
    });
    expect(openCodeNativeAssociationDecision({})).toMatchObject({
      kind: "unavailable",
      capability: "decision-only",
    });
  });
});
