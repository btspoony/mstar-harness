import { describe, expect, test } from "bun:test";
import {
  createLocalExecutionIdentity,
  decodeExecutionSessionRef,
  encodeExecutionSessionRef,
  executionContextFor,
  resumeExecutionSession,
} from "./execution-session.js";
import { serializeExecutionValue } from "./execution-store.js";
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
    const decoded = { ...ref, extra: true };
    const copied = `exec-session-v1:${Buffer.from(serializeExecutionValue(decoded), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "")}`;
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

  test("refuses foreign caller and role/plan scope before any store read", async () => {
    const identity = createLocalExecutionIdentity({ workflowId: "workflow-1", role: "coordinator", planId: null });
    const context = executionContextFor({ harnessDir: "/tmp/harness" }, identity);
    await expect(
      resumeExecutionSession({ ...context, caller: { ...context.caller, sessionId: "foreign-session" } }, ref),
    ).rejects.toMatchObject({ code: "execution.scope-mismatch" });
    await expect(
      resumeExecutionSession({ ...context, caller: { ...context.caller, role: "plan-pm", planId: "p-1" } }, ref),
    ).rejects.toMatchObject({ code: "execution.scope-mismatch" });
  });
});