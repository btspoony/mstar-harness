import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { Context } from "@opencode/plugin/effect/plugin";
import type { SessionContext } from "@opencode/plugin/effect/session";

import { registerHooks } from "./mod";
import { addBootstrapToContext, formatBootstrap } from "./bootstrap";

type ContextMessage = SessionContext["messages"][number];
type ContextEvent = Pick<SessionContext, "messages" | "system">;

const message = (role: ContextMessage["role"], text = "hello"): ContextMessage => ({
  role,
  content: [{ type: "text", text }],
});

const bootstrap = "<IMPORTANT_FOR_HARNESS>rules</IMPORTANT_FOR_HARNESS>";

async function runContextHookRegistration() {
  const event: ContextEvent = { messages: [message("user")], system: [{ type: "text", text: "policy" }] };
  const registeredKinds: string[] = [];
  let callback: ((input: ContextEvent) => Effect.Effect<void>) | undefined;
  const context = {
    session: {
      hook: (kind: string, handler: (input: ContextEvent) => Effect.Effect<void>) => {
        registeredKinds.push(kind);
        callback = handler;
        return Effect.succeed({ dispose: Effect.void });
      },
    },
  } as unknown as Context;
  await Effect.runPromise(Effect.scoped(registerHooks(context)));
  if (!callback) throw new Error("context hook was not registered");
  await Effect.runPromise(callback(event));
  return { event, registeredKinds };
}

describe("OpenCode V2 context bootstrap", () => {
  test("prepends the bootstrap to the first user message only", () => {
    const event: ContextEvent = {
      messages: [message("assistant", "thinking"), message("user")],
      system: [{ type: "text", text: "system" }],
    };
    addBootstrapToContext(event, bootstrap);
    expect(event.messages[1]?.content[0]).toMatchObject({ type: "text", text: bootstrap });
    expect(event.messages[1]?.content[1]).toMatchObject({ type: "text", text: "hello" });
    expect(event.messages[0]?.content).toHaveLength(1);
  });

  test("uses the SDK's top-level role/content message shape", () => {
    const event: ContextEvent = { messages: [message("user")], system: [] };
    expect(() => addBootstrapToContext(event, bootstrap)).not.toThrow();
    expect(event.messages[0]?.content[0]).toMatchObject({ type: "text", text: bootstrap });
  });

  test("marker prevents duplicate injection across repeated context events", () => {
    const event: ContextEvent = { messages: [message("user")], system: [{ type: "text", text: "system" }] };
    addBootstrapToContext(event, bootstrap);
    const afterFirst = structuredClone(event.messages);
    addBootstrapToContext(event, bootstrap);
    expect(event.messages).toEqual(afterFirst);
  });

  test("empty messages are a no-op", () => {
    const event: ContextEvent = { messages: [], system: [{ type: "text", text: "system" }] };
    addBootstrapToContext(event, bootstrap);
    expect(event.messages).toEqual([]);
  });

  test("system policy and the original messages remain untouched", () => {
    const original = [message("user")];
    const outgoing = structuredClone(original);
    const system: ContextEvent["system"] = [{ type: "text", text: "system" }];
    const originalSnapshot = structuredClone(original);
    const systemSnapshot = structuredClone(system);
    addBootstrapToContext({ messages: outgoing, system }, bootstrap);
    expect(original).toEqual(originalSnapshot);
    expect(outgoing).not.toEqual(originalSnapshot);
    expect(system).toEqual(systemSnapshot);
  });

  test("bootstrap content uses the marker wrapper", () => {
    expect(formatBootstrap("  harness rules\n")).toBe("<IMPORTANT_FOR_HARNESS>\nharness rules\n</IMPORTANT_FOR_HARNESS>");
    expect(formatBootstrap("  \n")).toBeNull();
  });

  test("registers only context and injects bundled bootstrap through the hook", async () => {
    const { event, registeredKinds } = await runContextHookRegistration();
    expect(registeredKinds).toEqual(["context"]);
    expect(event.messages[0]?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("<IMPORTANT_FOR_HARNESS>") });
    expect(event.system).toEqual([{ type: "text", text: "policy" }]);
  });
});
