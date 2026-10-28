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
    // recover or adopt can run under the attested leaf. The tuple is the DSH
    // ADAPTER'S shape (`native-commands.ts`): `source: "host"`, the carrying
    // session id, and the leaf fact spread from the shared session-header
    // predicate — never a hand-built object.
    const header: { origin?: string; delegationDepth?: number } = { origin: "subagent" };
    const attested: ExecutionIdentity = {
      source: "host",
      sessionId: "session-1",
      workflowId: "wf-1",
      role: "coordinator",
      ...(header.origin === "subagent" || (header.delegationDepth ?? 0) > 0 ? { leafSeat: true as const } : {}),
    };
    let refusal: CoordinationError | undefined;
    try {
      executionContextFor({ harnessDir: "/tmp/unused-harness" }, attested);
    } catch (error) {
      refusal = error as CoordinationError;
    }
    expect(refusal?.code).toBe("coordination.leaf-seat");
    expect(refusal?.message).toContain("a leaf seat cannot mint or mutate a workflow coordinator registration");
  });

  test("a non-true leafSeat value is refused, never ignored; the plain tuple is untouched", () => {
    // `true` is the only legal attestation: `false`/other values stay refused by
    // the exact-key contract instead of passing as "not attested".
    expect(refusalOf({ ...base, leafSeat: false as unknown as true }).code).toBe("coordination.forbidden-field");
    expect(refusalOf({ ...base, leafSeat: "subagent" as unknown as true }).code).toBe("coordination.forbidden-field");
    expect(() => validateExecutionIdentity(base, { workflowId: base.workflowId, role: "coordinator" })).not.toThrow();
  });
});
