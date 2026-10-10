import fs from "node:fs";
import path from "node:path";
import type { SessionContext } from "@opencode/plugin/effect/session";

import { packageRoot } from "../assets";

const BOOTSTRAP_MARKER = "IMPORTANT_FOR_HARNESS";
const BOOTSTRAP_FILE = path.join(packageRoot, "AGENTS.md");

type MessagePart = { type: string; text?: string; [key: string]: unknown };
type ChatMessage = { info: { role: string }; parts: MessagePart[] };
type ContextEvent = Pick<SessionContext, "messages" | "system">;

export function formatBootstrap(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return `<${BOOTSTRAP_MARKER}>\n${trimmed}\n</${BOOTSTRAP_MARKER}>`;
}

export function loadBootstrapContent(filePath = BOOTSTRAP_FILE): string | null {
  if (!fs.existsSync(filePath)) return null;
  return formatBootstrap(fs.readFileSync(filePath, "utf8"));
}

/** Mutates only the SDK-provided model-input messages; OpenCode persists its
 * separate session history, and its system policy is deliberately untouched. */
export function addBootstrapToContext(event: ContextEvent, bootstrap: string | null): void {
  if (!bootstrap || event.messages.length === 0) return;

  // V2's SessionContext messages use the same `{info.role, parts}` model-input
  // shape as the V1 chat-message transform at SDK 2.0.26.
  const messages = event.messages as unknown as ChatMessage[];
  const firstUser = messages.find((message) => message.info.role === "user");
  if (!firstUser || firstUser.parts.length === 0) return;

  if (firstUser.parts.some(
    (part) => part.type === "text" && typeof part.text === "string" && part.text.includes(`<${BOOTSTRAP_MARKER}>`),
  )) return;

  const reference = firstUser.parts[0];
  firstUser.parts.unshift({ ...reference, type: "text", text: bootstrap });
}
