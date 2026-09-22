import { describe, expect, test } from "vitest";
import {
  createLocalExecutionIdentity,
  decodeExecutionSessionRef,
  encodeExecutionSessionRef,
  executionContextFor,
} from "./execution-session.js";
import type { ExecutionSessionRef } from "./execution-store.js";

const ref: ExecutionSessionRef = {
  storeId: "store-1",
  epoch: 3,
  workflowId: "workflow-1",
  role: "coordinator",
  sessionId: "native-session",
  planId: null,
};

describe("execution session transport", () => {
  test("encodes and decodes the canonical reference without adding authority", () => {
    const wire = encodeExecutionSessionRef(ref);
    expect(wire).toMatch(/^exec-session-v1:/);
    expect(decodeExecutionSessionRef(wire)).toEqual(ref);
    expect(decodeExecutionSessionRef(`${wire}AA`)).not.toEqual(ref);
  });

  test("rejects copied, stale-shaped, and extra-field references", () => {
    const wire = encodeExecutionSessionRef(ref);
    const decoded = JSON.parse(Buffer.from(wire.slice("exec-session-v1:".length), "base64url").toString("utf8")) as Record<string, unknown>;
    decoded.extra = true;
    const copied = `exec-session-v1:${Buffer.from(`${JSON.stringify(decoded)}\n`).toString("base64url")}`;
    expect(() => decodeExecutionSessionRef(copied)).toThrow();
    expect(() => decodeExecutionSessionRef("exec-session-v1:eyJzdG9yZUlkIjoiYSJ9")).toThrow();
  });

  test("mints a local id once and keeps explicit role scope", () => {
    const first = createLocalExecutionIdentity({ workflowId: "workflow-1", role: "coordinator", planId: null });
    const second = createLocalExecutionIdentity({ workflowId: "workflow-1", role: "coordinator", planId: null });
    expect(first.source).toBe("local");
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(executionContextFor({ harnessDir: "/tmp/harness" }, first).caller).toMatchObject({
      sessionId: first.sessionId,
      workflowId: "workflow-1",
      role: "coordinator",
      planId: null,
    });
  });
});
