import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tool } from "@opencode/schema/tool";
import { Effect } from "effect";
import * as Engine from "@mstar-harness/engine";
import type { Context } from "@opencode/plugin/effect/plugin";
import type { ToolHooks } from "@opencode/plugin/effect/tool";

import { registerDispatchGate } from "../hooks/mod";
import { dispatchBefore } from "./dispatch";

// why: The dispatch gate reads the process control root. Keep it on a clean temp
// Git worktree so the developer's checkout state cannot decide the test.
let previousCwd: string;
let controlRoot: string;
beforeAll(() => {
  previousCwd = process.cwd();
  controlRoot = mkdtempSync(join(tmpdir(), "opencode-v2-gate-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: controlRoot });
  mkdirSync(join(controlRoot, ".mstar"), { recursive: true });
  writeFileSync(join(controlRoot, ".gitignore"), ".mstar/\n");
  writeFileSync(join(controlRoot, ".mstarc"), "[config]\n");
  execFileSync("git", ["add", ".gitignore", ".mstarc"], { cwd: controlRoot });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: controlRoot });
  process.chdir(controlRoot);
});
afterAll(() => {
  process.chdir(previousCwd);
  rmSync(controlRoot, { recursive: true, force: true });
});

type ExecuteBeforeEvent = ToolHooks["execute.before"];
type GateCallback = (event: ExecuteBeforeEvent) => Effect.Effect<void, Tool.Error>;
type GateLogger = (level: "info" | "warn" | "error", message: string) => void;

const validAssignment = (executeAs = "fullstack-dev", enforcement = ""): string => [
  "---",
  `execute_as: ${executeAs}`,
  "delegation: forbidden",
  "task_category: logic",
  "task_budget: one implementer round",
  "working_branch: feature/opencode-v2-dispatch-test",
  enforcement,
  "---",
  "",
  "## Assignment",
  "",
  "Do the thing, evidence-first.",
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

function withEnforcement(text: string, enforcement: "hard"): string {
  return text.replace("---\n", `---\nenforcement: ${enforcement}\n`);
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
    const prompt = validAssignment().replace("execute_as: fullstack-dev\n", "");
    await harness.invoke(makeEvent("project-manager", "fullstack-dev", prompt));
    expect(harness.bodyCalls()).toBe(1);
    expect(logs.join("\n")).toContain("assignment.field.execute-as");
  });

  test("hard mode returns typed Tool.Error before the body for missing core fields", async () => {
    const harness = await fixture();
    const prompt = withEnforcement(validAssignment().replace("execute_as: fullstack-dev\n", ""), "hard");
    await expect(harness.invoke(makeEvent("project-manager", "fullstack-dev", prompt))).rejects.toBeInstanceOf(Tool.Error);
    expect(harness.bodyCalls()).toBe(0);
  });

  test("warn mode proceeds on missing branch form and hard mode refuses it", async () => {
    const logs: string[] = [];
    const warn = await fixture((_level, message) => logs.push(message));
    const missingBranch = validAssignment().replace("working_branch: feature/opencode-v2-dispatch-test", "");
    expect(Engine.parseAssignmentFields(missingBranch).workingBranch).toBeUndefined();
    expect(Engine.composeDispatchGate(missingBranch, { caller: "project-manager", callerRequired: true }).violations.map((violation) => violation.code)).toContain("assignment.field.branch-missing");
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
    await harness.invoke(makeEvent("project-manager", "fullstack-dev", validAssignment("fullstack-dev", "enforcement: hard")));
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

/** The retired body-label format of the same dispatch — same fields as
 * `**Label**` body lines (the format front matter replaced). */
const LEGACY_BODY_LABEL = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/opencode-v2-dispatch-test
**Task budget (implement / ops rounds)**: one implementer round

Do the thing, evidence-first.
`;

describe("D14/D16 assignment source (pointer parity and legacy refusal)", () => {
  test("a pointer under an accepted assignment home produces the SAME decision as the inline form", async () => {
    const logs: string[] = [];
    // Inline: missing-branch violations in warn mode.
    const inlineBranchless = validAssignment().replace("working_branch: feature/opencode-v2-dispatch-test", "");
    const warnInline = await fixture((_level, message) => logs.push("inline: " + message));
    await warnInline.invoke(makeEvent("project-manager", "fullstack-dev", inlineBranchless));
    const inlineCodes = logs.filter((l) => l.startsWith("inline: ")).join("\n");

    const logs2: string[] = [];
    const warnPointer = await fixture((_level, message) => logs2.push(message));
    mkdirSync(join(controlRoot, ".mstar", "assignments"), { recursive: true });
    const file = join(controlRoot, ".mstar", "assignments", "pointer-target.md");
    writeFileSync(file, inlineBranchless);
    await warnPointer.invoke(makeEvent("project-manager", "fullstack-dev", `Assignment file: ${file}`));
    expect(warnPointer.bodyCalls()).toBe(1);
    expect(logs2.join("\n")).toContain("assignment.field.branch-missing");
    // Same decision as inline: the one violation code matches.
    expect(inlineCodes).toContain("assignment.field.branch-missing");
  });

  test("an out-of-home pointer refuses dispatch.assignment.path", async () => {
    const logs: string[] = [];
    const harness = await fixture((_level, message) => logs.push(message));
    const outside = join(controlRoot, "outside-assignment.md");
    writeFileSync(outside, validAssignment());
    await harness.invoke(makeEvent("project-manager", "fullstack-dev", `Assignment file: ${outside}`));
    // Warn mode: advisory log, no refusal.
    expect(harness.bodyCalls()).toBe(1);
    expect(logs.join("\n")).toContain("dispatch.assignment.path");
  });

  test("an out-of-home pointer under repo-level hard refuses the dispatch", async () => {
    writeFileSync(join(controlRoot, ".mstarc"), "[config]\nenforcement=hard\n");
    try {
      const harness = await fixture();
      const outside = join(controlRoot, "outside-hard-assignment.md");
      writeFileSync(outside, validAssignment());
      await expect(harness.invoke(makeEvent("project-manager", "fullstack-dev", `Assignment file: ${outside}`))).rejects.toMatchObject({
        _tag: "Tool.Error",
        message: expect.stringContaining("dispatch.assignment.path"),
      });
      expect(harness.bodyCalls()).toBe(0);
    } finally {
      writeFileSync(join(controlRoot, ".mstarc"), "[config]\n");
    }
  });

  test("a body-label prompt refuses dispatch.assignment.legacy-format with both recoveries", async () => {
    const logs: string[] = [];
    const harness = await fixture((_level, message) => logs.push(message));
    await harness.invoke(makeEvent("project-manager", "fullstack-dev", LEGACY_BODY_LABEL));
    expect(harness.bodyCalls()).toBe(1);
    const joined = logs.join("\n");
    expect(joined).toContain("dispatch.assignment.legacy-format");
    expect(joined).toContain("front-matter document");
    expect(joined).toContain("Assignment file:");
    expect(joined).not.toContain("document.frontmatter.absent");
  });

  test("the legacy refusal under repo-level hard refuses the dispatch", async () => {
    writeFileSync(join(controlRoot, ".mstarc"), "[config]\nenforcement=hard\n");
    try {
      const harness = await fixture();
      await expect(harness.invoke(makeEvent("project-manager", "fullstack-dev", LEGACY_BODY_LABEL))).rejects.toMatchObject({
        _tag: "Tool.Error",
        message: expect.stringContaining("dispatch.assignment.legacy-format"),
      });
      expect(harness.bodyCalls()).toBe(0);
    } finally {
      writeFileSync(join(controlRoot, ".mstarc"), "[config]\n");
    }
  });
});
