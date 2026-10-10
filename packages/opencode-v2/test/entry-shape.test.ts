import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { Plugin as EffectPlugin } from "@opencode/plugin/effect";
import type { Context } from "@opencode/plugin/effect/plugin";

import plugin from "../src/entry";

const makeContext = (userPreseed: Record<string, Record<string, unknown>> = {}) => {
  const agents = new Map<string, Record<string, unknown>>([
    ["project-manager", { name: "project-manager", model: "user/provider-model", ...userPreseed["project-manager"] }],
  ]);
  for (const [id, def] of Object.entries(userPreseed)) {
    if (id !== "project-manager") agents.set(id, { name: id, ...def });
  }
  const commands = new Map<string, unknown>();
  const skills = new Map<string, unknown>();
  let agentUpdates = 0;
  let commandAdds = 0;
  let skillAdds = 0;

  return {
    context: {
      agent: {
        transform: (update: (editor: { update: (id: string, fn: (agent: Record<string, unknown>) => void) => void }) => void) =>
          Effect.sync(() => update({
            update: (id, fn) => {
              agentUpdates += 1;
              const current = agents.get(id) ?? { name: id };
              fn(current);
              agents.set(id, current);
            },
          })).pipe(Effect.as({ dispose: Effect.void })),
      },
      command: {
        transform: (update: (editor: { add: (definition: { name: string; [key: string]: unknown }) => void }) => void) =>
          Effect.sync(() => update({
            add: (definition) => {
              commandAdds += 1;
              commands.set(definition.name, definition);
            },
          })).pipe(Effect.as({ dispose: Effect.void })),
      },
      session: {
        hook: (kind: string, handler: (event: unknown) => unknown) =>
          Effect.succeed({ dispose: Effect.void }),
      },
      tool: {
        hook: (kind: string, handler: (event: unknown) => unknown) =>
          Effect.succeed({ dispose: Effect.void }),
      },
      skill: {
        transform: (update: (editor: { add: (definition: { name: string; location: string }) => void }) => void) =>
          Effect.sync(() => update({
            add: (definition) => {
              skillAdds += 1;
              skills.set(definition.name, definition);
            },
          })).pipe(Effect.as({ dispose: Effect.void })),
      },
      session: {
        hook: () => Effect.succeed({ dispose: Effect.void }),
      },
      tool: {
        hook: () => Effect.succeed({ dispose: Effect.void }),
      },
    } as unknown as Context,
    agents,
    commands,
    skills,
    counts: () => ({ agentUpdates, commandAdds, skillAdds }),
  };
};

const runSetup = async (context: Context) => {
  await Effect.runPromise(Effect.scoped((plugin as EffectPlugin).effect(context)));
};

describe("OpenCode V2 native entry registration", () => {
  test("exports the native id and Effect lifecycle without the V1 server key", () => {
    expect(plugin.id).toBe("morning-star-harness");
    expect(typeof plugin.effect).toBe("function");
    expect("server" in plugin).toBe(false);
  });

  test("a preconfigured stricter user permission rule survives registration as the last (winning) rule", async () => {
    const userDeny = { action: "shell", resource: "*", effect: "deny" };
    const fixture = makeContext({
      "project-manager": {
        name: "project-manager",
        permissions: [userDeny],
      },
    });
    await runSetup(fixture.context);

    const registered = fixture.agents.get("project-manager") as {
      permissions?: Array<{ action: string; resource: string; effect: string }>;
    };
    expect(Array.isArray(registered.permissions)).toBe(true);
    const rules = registered.permissions!;
    expect(rules[rules.length - 1]).toEqual(userDeny);
    expect(rules.filter((rule) => rule.effect === "deny" && rule.resource === "*").length).toBeGreaterThanOrEqual(1);
    // Bundled defaults may precede the user rule but must never follow it.
    const userDenyIndex = rules.indexOf(userDeny);
    for (const rule of rules.slice(userDenyIndex + 1)) {
      expect(rule).toEqual(userDeny);
    }
  });

  test("registers bundled assets through editor operations and preserves user agent keys", async () => {
    const fixture = makeContext();
    await runSetup(fixture.context);

    expect(fixture.agents.get("project-manager")?.model).toBe("user/provider-model");
    expect(fixture.agents.size).toBeGreaterThan(0);
    expect(fixture.commands.size).toBeGreaterThan(0);
    expect(fixture.skills.size).toBeGreaterThan(0);
    expect(fixture.counts().agentUpdates).toBe(fixture.agents.size);
    expect(fixture.counts().commandAdds).toBe(fixture.commands.size);
    expect(fixture.counts().skillAdds).toBe(fixture.skills.size);
    for (const definition of fixture.skills.values()) {
      if (!definition || typeof definition !== "object" || !("path" in definition)) {
        throw new Error("registered skill is missing its package-local path");
      }
      expect(typeof definition.path).toBe("string");
      expect(definition.path).toContain("harness-skills");
    }
  });

  test("setup replay converges on one registration per stable asset id", async () => {
    const fixture = makeContext();
    await runSetup(fixture.context);
    const firstCounts = fixture.counts();
    await runSetup(fixture.context);

    expect(fixture.agents.size).toBe(firstCounts.agentUpdates);
    expect(fixture.commands.size).toBe(firstCounts.commandAdds);
    expect(fixture.skills.size).toBe(firstCounts.skillAdds);
    expect(fixture.counts().agentUpdates).toBe(firstCounts.agentUpdates * 2);
    expect(fixture.counts().commandAdds).toBe(firstCounts.commandAdds * 2);
    expect(fixture.counts().skillAdds).toBe(firstCounts.skillAdds * 2);
    expect(fixture.agents.get("project-manager")?.model).toBe("user/provider-model");
  });
});
