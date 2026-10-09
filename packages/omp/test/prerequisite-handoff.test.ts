import { describe, expect, test } from "bun:test";
import { reserveHandoffBinding } from "../src/model-handoff-readiness";

describe("ACTIVE prerequisite handoff gates", () => {
  test("no ACTIVE root fails closed instead of reserving a legacy binding", async () => {
    const result = await reserveHandoffBinding(
      { workflowId: "workflow-fixture", entry: "iteration-start", intent: "new-iteration", authority: "coordinator" },
      { sessionId: "host-session", cwd: process.cwd(), taskSession: false, executionBinding: null },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid-root");
  });
});
