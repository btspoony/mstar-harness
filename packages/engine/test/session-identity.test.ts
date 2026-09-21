/**
 * Engine adapter-only execution identity — prerequisite contract §3.1.
 *
 * One shared tuple `(canonical harness root, workflowId, role, planId, session
 * id)` plus its scope validator. The tests pin the *refusals* (an identity is
 * acquired, never synthesized) and the deliberate boundary: canonical root
 * equality is the caller's check, not this validator's.
 */
import { describe, expect, test } from "bun:test";
import { CoordinationError } from "../src/coordination-write.js";
import { validateExecutionIdentity, type ExecutionIdentity } from "../src/session-identity.js";

const ROOT = "/control/.mstar";

function identity(overrides: Partial<ExecutionIdentity> = {}): ExecutionIdentity {
  return {
    harnessRoot: ROOT,
    workflowId: "wf-a",
    role: "coordinator",
    planId: null,
    sessionId: "native-session-a",
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

  test("a missing canonical root or workflow id is identity-missing", () => {
    const scope = { workflowId: "wf-a", role: "coordinator", planId: null } as const;
    expect(
      codeOf(() => validateExecutionIdentity(identity({ harnessRoot: "" }), scope)),
    ).toBe("coordination.identity-missing");
    expect(
      codeOf(() => validateExecutionIdentity(identity({ workflowId: "" }), scope)),
    ).toBe("coordination.identity-missing");
    expect(
      codeOf(() => validateExecutionIdentity(null as unknown as ExecutionIdentity, scope)),
    ).toBe("coordination.identity-missing");
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

  test("canonical root equality is the caller's check: this validator only requires a non-empty root", () => {
    // Two different roots both validate — an adapter compares the root it
    // resolved itself against the tuple, because a mismatch there addresses a
    // different control harness rather than a malformed identity.
    expect(() =>
      validateExecutionIdentity(identity({ harnessRoot: "/elsewhere/.mstar" }), {
        workflowId: "wf-a",
        role: "coordinator",
        planId: null,
      }),
    ).not.toThrow();
  });
});
