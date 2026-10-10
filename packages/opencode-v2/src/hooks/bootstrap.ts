import fs from "node:fs";
import path from "node:path";
import type { SessionContext } from "@opencode/plugin/effect/session";

import { packageRoot } from "../assets";

const BOOTSTRAP_MARKER = "IMPORTANT_FOR_HARNESS";
const BOOTSTRAP_FILE = path.join(packageRoot, "AGENTS.md");

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

  // `@opencode/plugin` 2.0.26 declares SessionContext.messages as Message[]
  // (`dist/effect/session.d.ts:22-29`); Message carries top-level `role` and
  // `content` (`@opencode/ai/dist/schema/messages.d.ts:426-433`).
  const firstUser = event.messages.find((message) => message.role === "user");
  if (!firstUser || firstUser.content.length === 0) return;

  if (firstUser.content.some(
    (part) => part.type === "text" && part.text.includes(`<${BOOTSTRAP_MARKER}>`),
  )) return;

  firstUser.content.unshift({ type: "text", text: bootstrap });
}
