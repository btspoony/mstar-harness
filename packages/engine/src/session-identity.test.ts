import { describe, expect, test } from "bun:test";
import { CoordinationError } from "./coordination-write.js";
import { executionContextFor } from "./execution-session.js";
import { validateExecutionIdentity, type ExecutionIdentity } from "./session-identity.js";

const base: ExecutionIdentity = { source: "host", sessionId: "session-1", workflowId: "wf-1", role: "coordinator" };

function refusalOf(identity: ExecutionIdentity): CoordinationError {
  try {
    validateExecutionIdentity(identity, { workflowId: identity.workflowId, role: "coordinator" });
  } catch (error) {
    return error as CoordinationError;
  }
  throw new Error("expected validateExecutionIdentity to refuse");
}

describe("the leaf-seat attestation guard", () => {
  test("a leaf-attested identity refuses coordination.leaf-seat with the recovery, fail-closed", () => {
    const refusal = refusalOf({ ...base, leafSeat: true });
    expect(refusal.code).toBe("coordination.leaf-seat");
    expect(refusal.message).toContain('origin "subagent"');
    expect(refusal.message).toContain("delegationDepth > 0");
    // The recovery names the supported route: the coordinating session performs
    // the registration itself.
    expect(refusal.message).toContain("the non-leaf coordinating session must acquire its own identity");
  });

  test("a leaf-attested identity never converts into a trusted caller context", () => {
    // The adapter seam (executionContextFor) validates through the same rule, so
    // the refusal fires before any caller exists — no coordinator bind, register,
    // recover or adopt can run under the attested leaf.
    expect(() => executionContextFor({ harnessDir: "/tmp/unused-harness" }, { ...base, leafSeat: true })).toThrow();
  });

  test("a non-true leafSeat value refuses as identity-mismatch; the plain tuple is untouched", () => {
    expect(refusalOf({ ...(base as ExecutionIdentity), leafSeat: "subagent" as unknown as true }).code).toBe("coordination.identity-mismatch");
    expect(() => validateExecutionIdentity(base, { workflowId: base.workflowId, role: "coordinator" })).not.toThrow();
  });
});
