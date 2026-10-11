import { describe, expect, test } from "bun:test";
import { Tool } from "@opencode/schema/tool";
import { Effect } from "effect";
import type { Context } from "@opencode/plugin/effect/plugin";
import type { ToolHooks } from "@opencode/plugin/effect/tool";

import { registerDispatchGate } from "../hooks/mod";
import { dispatchBefore } from "./dispatch";
import { loadDispatchGateApi } from "../engine-seams";

type ExecuteBeforeEvent = ToolHooks["execute.before"];
type GateCallback = (event: ExecuteBeforeEvent) => Effect.Effect<void, Tool.Error>;
type GateLogger = (level: "info" | "warn" | "error", message: string) => void;

const validAssignment = (executeAs = "fullstack-dev", enforcement = ""): string => [
  "## Assignment",
  `Execute as: ${executeAs}`,
  "Delegation: forbidden",
  "Task category: logic",
  "**Task budget (implement / ops rounds)**: one implementer round",
  "Working branch: feature/opencode-v2-dispatch-test",
  enforcement,
].filter(Boolean).join("\n");

function makeEvent(caller: string, target: string, prompt: unknown): ExecuteBeforeEvent {
  return {
    tool: "subagent",
    sessionID: "session-1" as ExecuteBeforeEvent["sessionID"],
    agent: caller as ExecuteBeforeEvent["agent"],
    messageID: "message-1" as ExecuteBeforeEvent["messageID"],
    id: "call-1" as ExecuteBeforeEvent["id"],
    input: { agent: target, description: "dispatch", prompt },
  };
}

async function fixture(logger?: GateLogger) {
  const kinds: string[] = [];
  let callback: GateCallback | undefined;
  const context = {
    tool: {
      hook: (kind: string, handler: GateCallback) => {
        kinds.push(kind);
        callback = handler;
        return Effect.succeed({ dispose: Effect.void });
      },
    },
  } as unknown as Context;
  await Effect.runPromise(Effect.scoped(registerDispatchGate(context, logger === undefined ? undefined : { logger })));
  if (!callback) throw new Error("dispatch hook was not registered");
  let bodyCalls = 0;
  return {
    kinds,
    invoke: async (event: ExecuteBeforeEvent) => {
      await Effect.runPromise(callback!(event));
      bodyCalls++;
    },
    bodyCalls: () => bodyCalls,
  };
}

function withEnforcement(text: string, enforcement: "hard" | "soft"): string {
  return text.replace("## Assignment\n", `## Assignment\nEnforcement: ${enforcement}\n`);
}

describe("OpenCode V2 subagent dispatch gate", () => {
  test("allows a target whose input.agent matches the Assignment Execute as", async () => {
    const harness = await fixture();
    await harness.invoke(makeEvent("project-manager", "fullstack-dev", validAssignment()));
    expect(harness.kinds).toEqual(["execute.before"]);
    expect(harness.bodyCalls()).toBe(1);
  });

  test("warn mode logs missing core-field violations and still reaches the tool body", async () => {
    const logs: string[] = [];
    const harness = await fixture((_level, message) => logs.push(message));
    const prompt = validAssignment().replace("Execute as: fullstack-dev\n", "");
    await harness.invoke(makeEvent("project-manager", "fullstack-dev", prompt));
    expect(harness.bodyCalls()).toBe(1);
    expect(logs.join("\n")).toContain("assignment.field.missing-execute-as");
  });

  test("hard mode returns typed Tool.Error before the body for missing core fields", async () => {
    const harness = await fixture();
    const prompt = withEnforcement(validAssignment().replace("Execute as: fullstack-dev\n", ""), "hard");
    await expect(harness.invoke(makeEvent("project-manager", "fullstack-dev", prompt))).rejects.toBeInstanceOf(Tool.Error);
    expect(harness.bodyCalls()).toBe(0);
  });

  test("warn mode proceeds on missing branch form and hard mode refuses it", async () => {
    const logs: string[] = [];
    const warn = await fixture((_level, message) => logs.push(message));
    const missingBranch = validAssignment().replace("Working branch: feature/opencode-v2-dispatch-test", "");
    const engine = await loadDispatchGateApi();
    expect(engine).not.toBeNull();
    expect(engine?.parseAssignmentFields(missingBranch).workingBranch).toBeUndefined();
    expect(engine?.composeDispatchGate(missingBranch, { caller: "project-manager", callerRequired: true }).violations.map((violation) => violation.code)).toContain("assignment.field.branch-missing");
    await warn.invoke(makeEvent("project-manager", "fullstack-dev", missingBranch));
    expect(warn.bodyCalls()).toBe(1);
    expect(logs.join("\n")).toContain("assignment.field.branch-missing");

    const hard = await fixture();
    const prompt = withEnforcement(missingBranch, "hard");
    await expect(hard.invoke(makeEvent("project-manager", "fullstack-dev", prompt))).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringContaining("assignment.field.branch-missing"),
    });
    expect(hard.bodyCalls()).toBe(0);
  });

  test("warn mode proceeds and hard mode refuses the protected default branch", async () => {
    const logs: string[] = [];
    const unsafeBranch = validAssignment().replace("feature/opencode-v2-dispatch-test", "main");
    const warn = await fixture((_level, message) => logs.push(message));
    await warn.invoke(makeEvent("project-manager", "fullstack-dev", unsafeBranch));
    expect(warn.bodyCalls()).toBe(1);
    expect(logs.join("\n")).toContain("dispatch.default-branch.protected");

    const hard = await fixture();
    const prompt = withEnforcement(unsafeBranch, "hard");
    await expect(hard.invoke(makeEvent("project-manager", "fullstack-dev", prompt))).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringContaining("dispatch.default-branch.protected"),
    });
    expect(hard.bodyCalls()).toBe(0);
  });

  test("uses event.agent as caller rather than input.agent target", async () => {
    const harness = await fixture();
    await harness.invoke(makeEvent("project-manager", "fullstack-dev", validAssignment("fullstack-dev", "Enforcement: hard")));
    expect(harness.bodyCalls()).toBe(1);
  });

  test("refuses target/Execute as mismatch before a self-dispatch bypass", async () => {
    const harness = await fixture();
    const prompt = withEnforcement(validAssignment("project-manager"), "hard");
    await expect(harness.invoke(makeEvent("fullstack-dev", "fullstack-dev", prompt))).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringMatching(/input\.agent.*fullstack-dev[\s\S]*Execute as.*project-manager[\s\S]*align.*correct.*no subagent was spawned/i),
    });
    expect(harness.bodyCalls()).toBe(0);
  });

  test("refuses a writable target disguised as a read-only Execute as role", async () => {
    const harness = await fixture();
    const prompt = withEnforcement(validAssignment("explore"), "hard");
    await expect(harness.invoke(makeEvent("project-manager", "fullstack-dev", prompt))).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringMatching(/dispatch\.target-role-mismatch[\s\S]*"fullstack-dev"[\s\S]*"explore"[\s\S]*align.*correct/i),
    });
    expect(harness.bodyCalls()).toBe(0);
  });

  test("refuses a read-only target disguised as a writable Execute as role", async () => {
    const harness = await fixture();
    const prompt = withEnforcement(validAssignment("fullstack-dev"), "hard");
    await expect(harness.invoke(makeEvent("project-manager", "explore", prompt))).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringMatching(/dispatch\.target-role-mismatch[\s\S]*"explore"[\s\S]*"fullstack-dev"[\s\S]*align.*correct/i),
    });
    expect(harness.bodyCalls()).toBe(0);
  });

  test("refuses a missing input.agent target before dispatch admission", async () => {
    const harness = await fixture();
    const event = makeEvent("project-manager", "fullstack-dev", validAssignment());
    event.input = { description: "dispatch", prompt: validAssignment() };
    await expect(harness.invoke(event)).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringContaining("dispatch.target-role-missing"),
    });
    expect(harness.bodyCalls()).toBe(0);
  });

  test("hard mode refuses caller/target recursion with engine code and recovery", async () => {
    const harness = await fixture();
    const prompt = withEnforcement(validAssignment(), "hard");
    await expect(harness.invoke(makeEvent("fullstack-dev", "fullstack-dev", prompt))).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringMatching(/dispatch\.anti-recursion\.self-type[\s\S]*complete the work in this session/),
    });
    expect(harness.bodyCalls()).toBe(0);
  });

  test("empty caller warns and proceeds, but hard mode refuses even when target matches Execute as", async () => {
    const logs: string[] = [];
    const warn = await fixture((_level, message) => logs.push(message));
    await warn.invoke(makeEvent("", "fullstack-dev", validAssignment()));
    expect(warn.bodyCalls()).toBe(1);
    expect(logs.join("\n")).toContain("dispatch.anti-recursion.empty-binding");

    const hard = await fixture();
    const prompt = withEnforcement(validAssignment(), "hard");
    await expect(hard.invoke(makeEvent("", "fullstack-dev", prompt))).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringContaining("dispatch.anti-recursion.empty-binding"),
    });
    expect(hard.bodyCalls()).toBe(0);
  });


  test("null engine seam fails closed with typed engine-unavailable refusal", async () => {
    await expect(Effect.runPromise(dispatchBefore(
      makeEvent("project-manager", "fullstack-dev", validAssignment()),
      { loadEngine: async () => null },
    ))).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringContaining("[dispatch.engine-unavailable]"),
    });
  });
  test("missing prompt refuses as typed schema drift instead of skipping validation", async () => {
    const harness = await fixture();
    const event = makeEvent("project-manager", "fullstack-dev", undefined);
    event.input = { agent: "fullstack-dev", description: "dispatch" };
    await expect(harness.invoke(event)).rejects.toMatchObject({
      _tag: "Tool.Error",
      message: expect.stringContaining("input.prompt"),
    });
    expect(harness.bodyCalls()).toBe(0);
  });
});
