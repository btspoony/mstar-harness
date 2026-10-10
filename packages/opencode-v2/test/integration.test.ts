import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve, join } from "node:path";
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
  const registrations: Array<{ dispose: Effect.Effect<void> }> = [];
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
      hook: (kind: string, handler: (event: ContextEvent) => Effect.Effect<void>) =>
        Effect.sync(() => {
          sessionHooks[kind] = handler;
          const registration = {
            dispose: Effect.sync(() => {
              if (sessionHooks[kind] === handler) delete sessionHooks[kind];
            }),
          };
          registrations.push(registration);
          return registration;
        }),
      prompt: (input: Record<string, unknown>) => Effect.sync(() => { prompts.push(input); }),
    },
    tool: { hook: (kind: string, handler: ToolHook) =>
      Effect.sync(() => {
        const entry = { kind, handler };
        toolHooks.push(entry);
        const registration = {
          dispose: Effect.sync(() => {
            const index = toolHooks.indexOf(entry);
            if (index >= 0) toolHooks.splice(index, 1);
          }),
        };
        registrations.push(registration);
        return registration;
      }) },
  } as unknown as Context;
  return { context, agents, commands, skills, sessionHooks, toolHooks, prompts, registrations };
}

async function setup(fixture: ReturnType<typeof hostFixture>) {
  for (const registration of fixture.registrations.splice(0)) {
    await Effect.runPromise(registration.dispose);
  }
  await Effect.runPromise(Effect.scoped(plugin.effect(fixture.context)));
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
    await setup(fixture);
    expect(plugin.id).toBe("morning-star-harness");
    expect(fixture.agents["project-manager"]).toMatchObject({ mode: "primary" });
    expect(fixture.agents["fullstack-dev"]).toMatchObject({ mode: "subagent" });
  });

  test("registers the PM entry skill with project-manager routing", async () => {
    const fixture = hostFixture();
    await setup(fixture);
    const skill = fixture.skills.pm;
    expect(skill).toBeDefined();
    if (!skill) return;
    const routedRoles = [...skill.content.matchAll(/→\s*\*\*`?([A-Za-z][\w-]*)`?\*\*/g)]
      .map((match) => match[1]!)
      .filter((roleId) => fixture.agents[roleId]?.mode === "primary");
    expect(routedRoles).toContain("project-manager");
  });

  test("registers a bundled command with its template through the built entry", async () => {
    const fixture = hostFixture();
    await setup(fixture);
    const command = fixture.commands["codebase-audit"];
    expect(command).toBeDefined();
    if (!command) return;
    await Effect.runPromise(command.execute({
      sessionID: "session-1",
      prompt: { text: "audit this repository", files: [], agents: [], skills: [] },
      delivery: "default",
    }));
    const text = fixture.prompts[0]?.text;
    expect(typeof text).toBe("string");
    if (typeof text !== "string") return;
    const userPrompt = "audit this repository";
    expect(text.length).toBeGreaterThan(userPrompt.length);
    expect(text.endsWith(`\n\n${userPrompt}`)).toBe(true);
  });

  test("resolves and reads nested role references from the registered skill location", async () => {
    const fixture = hostFixture();
    await setup(fixture);
    const skill = fixture.skills["mstar-roles"];
    expect(skill).toBeDefined();
    if (!skill) return;

    const skillSource = readFileSync(skill.path, "utf8");
    const reference = skillSource.match(/references\/[\w./-]+\.md/)?.[0];
    expect(reference).toBeDefined();
    if (!reference) return;

    const previousCwd = process.cwd();
    const consumerCwd = mkdtempSync(join(tmpdir(), "opencode-v2-consumer-"));
    try {
      const decoy = join(consumerCwd, reference);
      mkdirSync(dirname(decoy), { recursive: true });
      writeFileSync(decoy, "consumer cwd decoy");
      process.chdir(consumerCwd);

      expect(isAbsolute(skill.path)).toBe(true);
      const packageReference = resolve(dirname(skill.path), reference);
      const nestedContent = readFileSync(packageReference, "utf8");
      expect(nestedContent).not.toBe("consumer cwd decoy");
      expect(nestedContent.length).toBeGreaterThan(0);
    } finally {
      process.chdir(previousCwd);
      rmSync(consumerCwd, { recursive: true, force: true });
    }
  });

  test("registers bootstrap alongside editors and injects it once", async () => {
    const fixture = hostFixture();
    await setup(fixture);
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
      await setup(fixture);
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
        input: { path: join(root, "admitted.md"), oldString: "before", newString: "after" },
      };
      await expect(Effect.runPromise(writeGate!(admittedEdit))).resolves.toBeUndefined();

      const command = fixture.commands["codebase-audit"];
      expect(command).toBeDefined();
      if (!command) return;
      await Effect.runPromise(command.execute({
        sessionID: "session-1",
        prompt: { text: "post-refusal audit", files: [], agents: [], skills: [] },
        delivery: "default",
      }));
      const commandText = fixture.prompts.at(-1)?.text;
      expect(typeof commandText).toBe("string");
      if (typeof commandText !== "string") return;
      expect(commandText.endsWith("\n\npost-refusal audit")).toBe(true);

      const pmSkill = fixture.skills.pm;
      expect(pmSkill).toBeDefined();
      if (!pmSkill) return;
      const pmSource = readFileSync(pmSkill.path, "utf8");
      const pmDescription = pmSource.match(/^description:\s*"?(.+?)"?$/m)?.[1];
      expect(pmDescription?.toLowerCase()).toContain("project-manager");
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replaying setup converges assets and hook registrations", async () => {
    const fixture = hostFixture();
    await setup(fixture);
    const first = {
      agentIds: Object.keys(fixture.agents).sort(),
      commandNames: Object.keys(fixture.commands).sort(),
      skillIds: Object.keys(fixture.skills).sort(),
      sessionHookNames: Object.keys(fixture.sessionHooks).sort(),
      toolHookCount: fixture.toolHooks.length,
    };
    await setup(fixture);
    expect({
      agentIds: Object.keys(fixture.agents).sort(),
      commandNames: Object.keys(fixture.commands).sort(),
      skillIds: Object.keys(fixture.skills).sort(),
      sessionHookNames: Object.keys(fixture.sessionHooks).sort(),
      toolHookCount: fixture.toolHooks.length,
    }).toEqual(first);
  });
});
