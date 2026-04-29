/**
 * MorningStarHarness plugin for OpenCode.
 *
 * - Injects one-time harness bootstrap into first user message.
 * - Registers skill paths for both repo-level and .opencode skills.
 * - Loads agent definitions from agents/*.md into runtime config.
 */
import type { Plugin } from "@opencode-ai/plugin";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonPrimitive = string | number | boolean | null;
type JsonObject = Record<string, unknown>;
type FrontmatterAndBody = {
  frontmatter: string;
  body: string;
};
type MessagePart = { type: string; text?: string };
type ChatMessage = { info: { role: string }; parts: MessagePart[] };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const skillsDirs = [
  path.join(repoRoot, "skills"),
  path.join(repoRoot, ".opencode", "skills"),
];
const agentsDir = path.join(repoRoot, "agents");
const bootstrapAgentsPath = path.join(repoRoot, ".opencode", "AGENTS.md");
const BOOTSTRAP_MARKER = "IMPORTANT_FOR_HARNESS";

const extractFrontmatterAndBody = (content: string): FrontmatterAndBody => {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: "", body: content };
  return { frontmatter: match[1], body: match[2] };
};

const parseScalar = (raw: string): JsonPrimitive => {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value === "allow" || value === "ask" || value === "deny") return value;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value.replace(/^["']|["']$/g, "");
};

const parseSimpleFrontmatter = (frontmatter: string): JsonObject => {
  const root: JsonObject = {};
  const stack: Array<{ indent: number; target: JsonObject }> = [{ indent: -1, target: root }];
  const lines = frontmatter.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.match(/^ */)?.[0]?.length ?? 0;
    const trimmed = line.trim();
    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1].target;

    if (rawValue === "" || rawValue === "{}") {
      current[key] = {};
      stack.push({ indent, target: current[key] as JsonObject });
      continue;
    }

    if (rawValue === "|-" || rawValue === "|") {
      const blockLines = [];
      const baseIndent = indent;
      for (let j = i + 1; j < lines.length; j += 1) {
        const blockLine = lines[j];
        const blockIndent = blockLine.match(/^ */)?.[0]?.length ?? 0;
        if (blockLine.trim() && blockIndent <= baseIndent) break;
        const normalized = blockLine.startsWith(" ".repeat(baseIndent + 2))
          ? blockLine.slice(baseIndent + 2)
          : blockLine.trim() ? blockLine.trim() : "";
        blockLines.push(normalized);
        i = j;
      }
      current[key] = blockLines.join("\n");
      continue;
    }

    current[key] = parseScalar(rawValue);
  }

  return root;
};

const loadBootstrapContent = (): string | null => {
  if (!fs.existsSync(bootstrapAgentsPath)) return null;
  const content = fs.readFileSync(bootstrapAgentsPath, "utf8").trim();
  if (!content) return null;
  return `<${BOOTSTRAP_MARKER}>
The following harness entry is ALREADY LOADED once for this session.
Do not reload it with skill tools unless explicitly requested.

${content}
</${BOOTSTRAP_MARKER}>`;
};

const normalizePath = (inputPath: string | undefined, homeDir: string): string | null => {
  if (!inputPath || typeof inputPath !== "string") return null;
  let normalized = inputPath.trim();
  if (!normalized) return null;
  if (normalized === "~") normalized = homeDir;
  if (normalized.startsWith("~/")) normalized = path.join(homeDir, normalized.slice(2));
  return path.resolve(normalized);
};

const loadAgentsFromMarkdown = (): Record<string, JsonObject> => {
  if (!fs.existsSync(agentsDir)) return {};

  const files = fs
    .readdirSync(agentsDir)
    .filter((name: string) => name.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b));

  const result: Record<string, JsonObject> = {};
  for (const file of files) {
    const filePath = path.join(agentsDir, file);
    const content = fs.readFileSync(filePath, "utf8");
    const { frontmatter, body } = extractFrontmatterAndBody(content);
    const parsed = parseSimpleFrontmatter(frontmatter);
    const parsedName = typeof parsed.name === "string" ? parsed.name : "";
    const id = parsedName || file.replace(/\.md$/, "");

    result[id] = {
      ...parsed,
      prompt: body.trim(),
    };
  }

  return result;
};

export const MorningStarHarnessPlugin: Plugin = async () => {
  const homeDir = os.homedir();
  const envConfigDir = normalizePath(process.env.OPENCODE_CONFIG_DIR, homeDir);
  const configDir = envConfigDir || path.join(homeDir, ".config/opencode");
  const isEnabledForProject = !!configDir;

  return {
    config: async (config: JsonObject) => {
      if (!isEnabledForProject) return;

      const runtimeConfig = config as JsonObject & {
        skills?: { paths?: string[] };
        agent?: Record<string, JsonObject>;
      };
      runtimeConfig.skills = runtimeConfig.skills || {};
      runtimeConfig.skills.paths = runtimeConfig.skills.paths || [];
      for (const skillPath of skillsDirs) {
        if (fs.existsSync(skillPath) && !runtimeConfig.skills.paths.includes(skillPath)) {
          runtimeConfig.skills.paths.push(skillPath);
        }
      }

      const markdownAgents = loadAgentsFromMarkdown();
      runtimeConfig.agent = runtimeConfig.agent || {};
      for (const [agentId, definition] of Object.entries(markdownAgents)) {
        runtimeConfig.agent[agentId] = {
          ...(runtimeConfig.agent[agentId] || {}),
          ...definition,
        };
      }
    },

    "experimental.chat.messages.transform": async (
      _input: unknown,
      output: { messages: ChatMessage[] },
    ) => {
      const bootstrap = loadBootstrapContent();
      if (!bootstrap || !output.messages.length) return;

      const firstUser = output.messages.find((message: ChatMessage) => message.info.role === "user");
      if (!firstUser || !firstUser.parts.length) return;

      const injected = firstUser.parts.some(
        (part: MessagePart) =>
          part.type === "text" &&
          typeof part.text === "string" &&
          part.text.includes(`<${BOOTSTRAP_MARKER}>`),
      );
      if (injected) return;

      const ref = firstUser.parts[0];
      firstUser.parts.unshift({
        ...ref,
        type: "text",
        text: bootstrap,
      });
    },
  };
};
