import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Tool } from "@opencode/schema/tool";
import type { Context } from "@opencode/plugin/effect/plugin";
import type { SessionContext } from "@opencode/plugin/effect/session";
import type { ToolHooks } from "@opencode/plugin/effect/tool";
import plugin from "../dist/mstar.js";

type ContextMessage = SessionContext["messages"][number];
type ContextEvent = Pick<SessionContext, "messages" | "system">;
type ExecuteBeforeEvent = ToolHooks["execute.before"];
type ToolHook = (event: ExecuteBeforeEvent) => Effect.Effect<void, Tool.Error>;
type HostCommand = {
  name: string;
  execute: (input: {
    sessionID: string;
    prompt: { text: string; files: unknown[]; agents: unknown[]; skills: unknown[] };
    delivery: string;
  }) => Effect.Effect<void>;
};

const message = (role: ContextMessage["role"], text = "hello"): ContextMessage => ({
  role,
  content: [{ type: "text", text }],
});

function hostFixture() {
  const agents: Record<string, Record<string, unknown>> = {};
  const commands: Record<string, HostCommand> = {};
  const skills: Record<string, { id: string; name: string; path: string; content: string }> = {};
  const sessionHooks: Record<string, (event: ContextEvent) => Effect.Effect<void>> = {};
  const toolHooks: Array<{ kind: string; handler: ToolHook }> = [];
  const prompts: Array<Record<string, unknown>> = [];
  const context = {
    agent: { transform: (edit: (editor: { update: (id: string, update: (current: Record<string, unknown>) => void) => void }) => void) =>
      Effect.sync(() => edit({ update: (id, update) => {
        const current = agents[id] ?? {};
        update(current);
        agents[id] = current;
      } })) },
    command: { transform: (edit: (editor: { add: (command: HostCommand) => void }) => void) =>
      Effect.sync(() => edit({ add: (command) => { commands[command.name] = command; } })) },
    skill: { transform: (edit: (editor: { add: (skill: (typeof skills)[string]) => void }) => void) =>
      Effect.sync(() => edit({ add: (skill) => { skills[skill.id] = skill; } })) },
    session: {
      hook: (kind: string, handler: (event: ContextEvent) => Effect.Effect<void>) => {
        sessionHooks[kind] = handler;
        return Effect.succeed({ dispose: Effect.void });
      },
      prompt: (input: Record<string, unknown>) => Effect.sync(() => { prompts.push(input); }),
    },
    tool: { hook: (kind: string, handler: ToolHook) => {
      toolHooks.push({ kind, handler });
      return Effect.succeed({ dispose: Effect.void });
    } },
  } as unknown as Context;
  return { context, agents, commands, skills, sessionHooks, toolHooks, prompts };
}

async function setup(context: Context) {
  await Effect.runPromise(Effect.scoped(plugin.effect(context)));
}

const validAssignment = [
  "## Assignment",
  "Enforcement: hard",
  "Execute as: fullstack-dev",
  "Delegation: forbidden",
  "Task category: logic",
  "**Task budget (implement / ops rounds)**: one implementer round",
  "Working branch: feature/integration-fixture",
].join("\n");

const dispatchEvent = (caller: string, target: string, prompt: unknown, id = "call-1"): ExecuteBeforeEvent => ({
  tool: "subagent",
  sessionID: "session-1" as ExecuteBeforeEvent["sessionID"],
  agent: caller as ExecuteBeforeEvent["agent"],
  messageID: "message-1" as ExecuteBeforeEvent["messageID"],
  id: id as ExecuteBeforeEvent["id"],
  input: { agent: target, description: "dispatch", prompt },
});

describe("built OpenCode V2 package integration", () => {
  test("registers PM primary seat and spawnable leaf role", async () => {
    const fixture = hostFixture();
    await setup(fixture.context);
    expect(plugin.id).toBe("morning-star-harness");
    expect(fixture.agents["project-manager"]).toMatchObject({ mode: "primary" });
    expect(fixture.agents["fullstack-dev"]).toMatchObject({ mode: "subagent" });
  });

  test("registers /pm command with its template and agent binding", async () => {
    const fixture = hostFixture();
    await setup(fixture.context);
    const command = fixture.commands.pm;
    expect(command).toBeDefined();
    if (!command) return;
    await Effect.runPromise(command.execute({
      sessionID: "session-1",
      prompt: { text: "coordinate this", files: [], agents: [], skills: [] },
      delivery: "default",
    }));
    expect(fixture.prompts).toHaveLength(1);
    expect(fixture.prompts[0]).toMatchObject({ text: expect.stringContaining("coordinate this") });
    expect(fixture.prompts[0]?.agent).toBe("project-manager");
  });

  test("resolves nested role references from the package-local skill", async () => {
    const fixture = hostFixture();
    await setup(fixture.context);
    const skill = fixture.skills["mstar-roles"];
    expect(skill).toBeDefined();
    if (!skill) return;
    expect(skill.path).toContain("/packages/opencode-v2/harness-skills/mstar-roles/SKILL.md");
    expect(skill.content).toContain("references/fullstack-dev-shared.md");
    expect(skill.content).toContain("Role Reference Mapping");
  });

  test("registers bootstrap alongside editors and injects it once", async () => {
    const fixture = hostFixture();
    await setup(fixture.context);
    const event: ContextEvent = { messages: [message("user")], system: [] };
    await Effect.runPromise(fixture.sessionHooks.context!(event));
    await Effect.runPromise(fixture.sessionHooks.context!(event));
    expect(event.messages[0]?.content.filter((part) =>
      part.type === "text" && part.text.includes("<IMPORTANT_FOR_HARNESS>"),
    )).toHaveLength(1);
    expect(fixture.sessionHooks.context).toBeDefined();
  });

  test("refuses recursive dispatch and authority writes while admitted paths remain usable", async () => {
    const fixture = hostFixture();
    const previousCwd = process.cwd();
    const root = mkdtempSync(join(tmpdir(), "opencode-v2-integration-"));
    try {
      mkdirSync(join(root, ".mstar", "projects", "_default"), { recursive: true });
      writeFileSync(join(root, ".mstarc"), "[config]\nenforcement=hard\n");
      writeFileSync(join(root, ".mstar", "status.json"), JSON.stringify({ version: 2, updated_at: "2026-10-10", workflows: [] }));
      writeFileSync(join(root, ".mstar", "store.db"), "fixture");
      process.chdir(root);
      await setup(fixture.context);
      const [dispatchGate, writeGate] = fixture.toolHooks.map(({ handler }) => handler);
      expect(dispatchGate).toBeDefined();
      expect(writeGate).toBeDefined();
      await Effect.runPromise(dispatchGate!(dispatchEvent("project-manager", "fullstack-dev", validAssignment)));
      expect(fixture.agents["fullstack-dev"]).toBeDefined();
      await expect(Effect.runPromise(dispatchGate!(dispatchEvent("fullstack-dev", "architect", validAssignment))))
        .rejects.toMatchObject({ _tag: "Tool.Error" });
      const refusedWrite: ExecuteBeforeEvent = {
        tool: "write",
        sessionID: "session-1" as ExecuteBeforeEvent["sessionID"],
        agent: "project-manager" as ExecuteBeforeEvent["agent"],
        messageID: "message-2" as ExecuteBeforeEvent["messageID"],
        id: "call-2" as ExecuteBeforeEvent["id"],
        input: { path: resolve(root, ".mstar/store.db"), content: "unauthorized" },
      };
      await expect(Effect.runPromise(writeGate!(refusedWrite))).rejects.toMatchObject({ _tag: "Tool.Error" });
      const admittedEdit: ExecuteBeforeEvent = {
        ...refusedWrite,
        tool: "edit",
        id: "call-3" as ExecuteBeforeEvent["id"],
        input: { path: "/tmp/opencode-v2-admitted.md", oldString: "before", newString: "after" },
      };
      await expect(Effect.runPromise(writeGate!(admittedEdit))).resolves.toBeUndefined();
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replaying setup converges assets and hook registrations", async () => {
    const fixture = hostFixture();
    await setup(fixture.context);
    const first = {
      agentIds: Object.keys(fixture.agents).sort(),
      commandNames: Object.keys(fixture.commands).sort(),
      skillIds: Object.keys(fixture.skills).sort(),
      sessionHookNames: Object.keys(fixture.sessionHooks).sort(),
      toolHookCount: fixture.toolHooks.length,
    };
    await setup(fixture.context);
    expect({
      agentIds: Object.keys(fixture.agents).sort(),
      commandNames: Object.keys(fixture.commands).sort(),
      skillIds: Object.keys(fixture.skills).sort(),
      sessionHookNames: Object.keys(fixture.sessionHooks).sort(),
      toolHookCount: fixture.toolHooks.length,
    }).toEqual(first);
  });
});
