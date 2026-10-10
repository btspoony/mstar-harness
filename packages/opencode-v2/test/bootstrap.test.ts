import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { Context } from "@opencode/plugin/effect/plugin";

import { registerHooks } from "../src/hooks/mod";

import { addBootstrapToContext, formatBootstrap } from "../src/hooks/bootstrap";

type ChatMessage = { info: { role: string }; parts: Array<{ type: string; text?: string; [key: string]: unknown }> };

const message = (role: string, text = "hello"): ChatMessage => ({
  info: { role },
  parts: [{ type: "text", text }],
});

const bootstrap = "<IMPORTANT_FOR_HARNESS>rules</IMPORTANT_FOR_HARNESS>";

async function runContextHookRegistration() {
  const event = { messages: [message("user")], system: ["policy"] };
  const registeredKinds: string[] = [];
  let callback: ((input: typeof event) => Effect.Effect<void>) | undefined;
  const context = {
    session: {
      hook: (kind: string, handler: (input: typeof event) => Effect.Effect<void>) => {
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
    const event = { messages: [message("assistant", "thinking"), message("user")], system: ["system"] };
    addBootstrapToContext(event, bootstrap);
    expect(event.messages[1]?.parts[0]?.text).toBe(bootstrap);
    expect(event.messages[1]?.parts[1]?.text).toBe("hello");
    expect(event.messages[0]?.parts).toHaveLength(1);
  });

  test("marker prevents duplicate injection across repeated context events", () => {
    const event = { messages: [message("user")], system: ["system"] };
    addBootstrapToContext(event, bootstrap);
    const afterFirst = structuredClone(event.messages);
    addBootstrapToContext(event, bootstrap);
    expect(event.messages).toEqual(afterFirst);
  });

  test("empty messages are a no-op", () => {
    const event = { messages: [] as ChatMessage[], system: ["system"] };
    addBootstrapToContext(event, bootstrap);
    expect(event.messages).toEqual([]);
  });

  test("system policy and the original messages remain untouched", () => {
    const original = [message("user")];
    const outgoing = structuredClone(original);
    const system = ["system"];
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
    expect(event.messages[0]?.parts[0]?.text).toContain("<IMPORTANT_FOR_HARNESS>");
    expect(event.system).toEqual(["policy"]);
  });
});

