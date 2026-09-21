/**
 * OMP coordinator-identity adapter — prerequisite contract §3.2.
 *
 * The adapter is tested as the boundary it is: caller input first (an extra
 * field is never partially honored), then the host-derived facts, then the
 * engine verb. Every case asserts what the injected `bind` observed, so a
 * refusal that forgot to stop before the write is visible.
 */
import { describe, expect, test } from "bun:test";
import {
  COORDINATOR_BIND_INPUT_KEYS,
  COORDINATOR_TOOL_NAME,
  bindCoordinatorIdentity,
  classifyCoordinatorShellCall,
  type CoordinatorIdentityFacts,
} from "../src/coordinator-identity";
import type { CoordinationResult } from "@mstar-harness/engine";

const FACTS: CoordinatorIdentityFacts = {
  sessionId: "native-session-a",
  cwd: "/repo/main",
  harnessRoot: "/repo/main/.mstar",
  leaf: false,
  scopedPlanEntry: false,
};

/** A fake engine verb that records its input and returns a plausible result. */
function fakeBind(): { calls: Array<Record<string, unknown>>; bind: (input: Record<string, unknown>) => Promise<CoordinationResult> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    bind: async (input: Record<string, unknown>) => {
      calls.push(input);
      return {
        ok: true,
        operation: "bind",
        outcome: "bound",
        session: { schema_version: 1, role: "coordinator", session_id: input.sessionId as string, workflow_id: input.workflowId as string, harness_root: input.harnessDir as string },
        session_file: "/repo/main/.mstar/workflows/wf-a/sessions/coordinator-native-session-a.json",
      } as unknown as CoordinationResult;
    },
  };
}

describe("prerequisite identity — coordinator identity adapter input", () => {
  test("accepts only operation and workflowId; every identity-shaped field is refused by name", async () => {
    expect([...COORDINATOR_BIND_INPUT_KEYS]).toEqual(["operation", "workflowId"]);
    expect(COORDINATOR_TOOL_NAME).toBe("mstar_coordinator");
    for (const forged of [
      { operation: "bind", workflowId: "wf-a", sessionId: "attacker" },
      { operation: "bind", workflowId: "wf-a", harnessRoot: "/elsewhere/.mstar" },
      { operation: "bind", workflowId: "wf-a", root: "/elsewhere/.mstar" },
      { operation: "bind", workflowId: "wf-a", role: "coordinator" },
      { operation: "bind", workflowId: "wf-a", authority: true },
      { operation: "bind", workflowId: "wf-a", credentialPath: "/tmp/creds.json" },
    ]) {
      const engine = fakeBind();
      const result = await bindCoordinatorIdentity(forged, FACTS, engine.bind);
      expect({ forged, ok: result.ok, code: result.code }).toEqual({ forged, ok: false, code: "forbidden-field" });
      expect(engine.calls).toHaveLength(0);
    }
  });

  test("a malformed call shape and a non-bind operation refuse without touching the engine", async () => {
    const engine = fakeBind();
    for (const bad of [null, "bind", 7, []]) {
      const result = await bindCoordinatorIdentity(bad, FACTS, engine.bind);
      expect(result.code).toBe("invalid-input");
    }
    expect((await bindCoordinatorIdentity({ operation: "recover", workflowId: "wf-a" }, FACTS, engine.bind)).code).toBe(
      "unknown-operation",
    );
    expect((await bindCoordinatorIdentity({ operation: "bind", workflowId: "  " }, FACTS, engine.bind)).code).toBe(
      "invalid-input",
    );
    expect(engine.calls).toHaveLength(0);
  });

  test("host facts gate the bind: no native id, a leaf session and a scoped-plan entry all refuse before the engine", async () => {
    const cases = [
      { facts: { ...FACTS, sessionId: "" }, code: "identity-missing" },
      { facts: { ...FACTS, leaf: true }, code: "leaf-session" },
      { facts: { ...FACTS, scopedPlanEntry: true }, code: "scoped-plan-route" },
      { facts: { ...FACTS, harnessRoot: null }, code: "harness-not-found" },
    ] as const;
    for (const entry of cases) {
      const engine = fakeBind();
      const result = await bindCoordinatorIdentity({ operation: "bind", workflowId: "wf-a" }, entry.facts, engine.bind);
      expect({ code: result.code, ok: result.ok }).toEqual({ code: entry.code, ok: false });
      expect(engine.calls).toHaveLength(0);
    }
  });

  test("a lawful call binds the derived identity — never a caller value — through the engine", async () => {
    const engine = fakeBind();
    const result = await bindCoordinatorIdentity({ operation: "bind", workflowId: "wf-a" }, FACTS, engine.bind);
    expect(result.ok).toBe(true);
    expect(result.code).toBe("bound");
    expect(engine.calls).toEqual([
      {
        coordinator: true,
        workflowId: "wf-a",
        harnessDir: "/repo/main/.mstar",
        cwd: "/repo/main",
        sessionId: "native-session-a",
      },
    ]);
    expect(result.details).toMatchObject({ workflowId: "wf-a", sessionId: "native-session-a", role: "coordinator" });
  });

  test("an engine refusal is reported with its own code, and the adapter never fabricates a success", async () => {
    const refusal = Object.assign(new Error("duplicate coordinator holder"), { code: "coordination.duplicate-holder" });
    const result = await bindCoordinatorIdentity({ operation: "bind", workflowId: "wf-a" }, FACTS, async () => {
      throw refusal;
    });
    expect(result).toMatchObject({ ok: false, isError: true, code: "coordination.duplicate-holder" });
    expect(result.text).toBe("duplicate coordinator holder");
  });
});

describe("prerequisite identity — managed coordinator bind transport classifier", () => {
  const bindCommand = "mstar plan bind --coordinator --workflow fixture-iteration";

  test("a bare or namespaced shell coordinator bind is refused before execution with a redirect to the tool", () => {
    for (const toolName of ["bash", "functions.bash"]) {
      const refusal = classifyCoordinatorShellCall({ toolName, input: { command: bindCommand } });
      expect(refusal?.block).toBe(true);
      expect(refusal?.reason).toContain("mstar_coordinator");
    }
  });

  test("unrelated shell calls and unsupported tool identities are left untouched", () => {
    for (const [toolName, input] of [
      ["bash", { command: "git status" }],
      ["bash", { command: "mstar plan bind --workflow wf-a --plan plan-a --session-id s" }],
      ["bash", { command: "true" }],
      ["bash", { command: 42 }],
      ["bash", "not-an-object"],
      ["bash", { command: "true", env: "FOO=bar" }],
      ["read", { command: bindCommand }],
      ["mstar_model_handoff", { command: bindCommand }],
    ] as const) {
      expect({ toolName, result: classifyCoordinatorShellCall({ toolName, input }) }).toEqual({ toolName, result: undefined });
    }
  });

  test("the classifier is pure: it never returns an input revision, so an absent env field cannot invalidate a call", () => {
    const refused = classifyCoordinatorShellCall({ toolName: "bash", input: { command: bindCommand } });
    expect(Object.keys(refused ?? {}).sort()).toEqual(["block", "reason"]);
    const untouched = classifyCoordinatorShellCall({ toolName: "bash", input: { command: "true" } });
    expect(untouched).toBeUndefined();
  });
});
