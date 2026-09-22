/**
 * Engine adapter-only execution identity — prerequisite contract §3.1.
 *
 * One shared tuple `(source, sessionId, workflowId, role, planId)` plus its
 * scope validator. The tests pin the *refusals* (an identity is acquired, never
 * synthesized) and the deliberate boundary: the canonical control-harness root
 * is not an identity member, so a root cannot be smuggled through the tuple.
 */
import { describe, expect, test } from "bun:test";
import { CoordinationError } from "../src/coordination-write.js";
import { validateExecutionIdentity, type ExecutionIdentity } from "../src/session-identity.js";

function identity(overrides: Partial<ExecutionIdentity> = {}): ExecutionIdentity {
  return {
    source: "host",
    sessionId: "native-session-a",
    workflowId: "wf-a",
    role: "coordinator",
    planId: null,
    ...overrides,
  };
}

function codeOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof CoordinationError) return error.code;
    throw error;
  }
  throw new Error("expected the identity validation to fail");
}

describe("prerequisite identity — execution identity validation", () => {
  test("accepts a coordinator identity and a plan-pm identity addressing their own scope", () => {
    expect(() =>
      validateExecutionIdentity(identity(), { workflowId: "wf-a", role: "coordinator", planId: null }),
    ).not.toThrow();
    expect(() =>
      validateExecutionIdentity(identity({ role: "plan-pm", planId: "plan-a", sessionId: "native-session-b" }), {
        workflowId: "wf-a",
        role: "plan-pm",
        planId: "plan-a",
      }),
    ).not.toThrow();
  });

  test("an absent, blank or non-string session id is identity-missing, never repaired", () => {
    const scope = { workflowId: "wf-a", role: "coordinator", planId: null } as const;
    for (const sessionId of ["", "   ", undefined, null, 42]) {
      expect(
        codeOf(() =>
          validateExecutionIdentity(identity({ sessionId: sessionId as unknown as string }), scope),
        ),
      ).toBe("coordination.identity-missing");
    }
  });

  test("a missing or invalid provenance source is refused, never inferred", () => {
    const scope = { workflowId: "wf-a", role: "coordinator", planId: null } as const;
    for (const [source, code] of [
      [undefined, "coordination.identity-missing"],
      [null, "coordination.identity-missing"],
      ["", "coordination.identity-mismatch"],
      ["env", "coordination.identity-mismatch"],
      ["native", "coordination.identity-mismatch"],
    ] as ReadonlyArray<readonly [unknown, string]>) {
      expect(
        codeOf(() => validateExecutionIdentity(identity({ source: source as unknown as "host" }), scope)),
      ).toBe(code);
    }
  });

  test("a missing workflow id is identity-missing, and null is never an identity", () => {
    const scope = { workflowId: "wf-a", role: "coordinator", planId: null } as const;
    expect(
      codeOf(() => validateExecutionIdentity(identity({ workflowId: "" }), scope)),
    ).toBe("coordination.identity-missing");
    expect(
      codeOf(() => validateExecutionIdentity(null as unknown as ExecutionIdentity, scope)),
    ).toBe("coordination.identity-missing");
  });

  test("a caller can no longer smuggle a harness root through the identity object", () => {
    const scope = { workflowId: "wf-a", role: "coordinator", planId: null } as const;
    // The retired shape — a canonical root where §3.1 requires `source` — is
    // not an identity: the root is supplied separately at the adapter boundary
    // and a tuple that still carries it (and no provenance) is refused.
    const legacy = {
      harnessRoot: "/elsewhere/.mstar",
      sessionId: "native-session-a",
      workflowId: "wf-a",
      role: "coordinator",
      planId: null,
    } as unknown as ExecutionIdentity;
    expect(codeOf(() => validateExecutionIdentity(legacy, scope))).toBe("coordination.identity-missing");
    // A §3.1 identity ignores an extra root key rather than adopting it: the
    // root is not read, compared or returned by this validator.
    const withRoot = { ...identity(), harnessRoot: "/elsewhere/.mstar" } as ExecutionIdentity;
    expect(() => validateExecutionIdentity(withRoot, scope)).not.toThrow();
  });

  test("role/plan incoherence, a non-coordination role and any scope disagreement are identity-mismatch", () => {
    expect(
      codeOf(() =>
        validateExecutionIdentity(identity({ planId: "plan-a" }), {
          workflowId: "wf-a",
          role: "coordinator",
          planId: null,
        }),
      ),
    ).toBe("coordination.identity-mismatch");
    expect(
      codeOf(() =>
        validateExecutionIdentity(identity({ role: "observer" as unknown as "coordinator" }), {
          workflowId: "wf-a",
          role: "coordinator",
          planId: null,
        }),
      ),
    ).toBe("coordination.identity-mismatch");
    expect(
      codeOf(() =>
        validateExecutionIdentity(identity(), { workflowId: "wf-b", role: "coordinator", planId: null }),
      ),
    ).toBe("coordination.identity-mismatch");
    expect(
      codeOf(() =>
        validateExecutionIdentity(identity(), { workflowId: "wf-a", role: "plan-pm", planId: "plan-a" }),
      ),
    ).toBe("coordination.identity-mismatch");
    expect(
      codeOf(() =>
        validateExecutionIdentity(identity({ role: "plan-pm", planId: "plan-a" }), {
          workflowId: "wf-a",
          role: "plan-pm",
          planId: "plan-b",
        }),
      ),
    ).toBe("coordination.identity-mismatch");
  });

  test("a plan-pm identity carries a non-empty plan id (identity-missing when it does not)", () => {
    expect(
      codeOf(() =>
        validateExecutionIdentity(identity({ role: "plan-pm", planId: null }), {
          workflowId: "wf-a",
          role: "plan-pm",
          planId: null,
        }),
      ),
    ).toBe("coordination.identity-missing");
  });
});
