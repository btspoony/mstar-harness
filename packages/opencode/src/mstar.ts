/**
 * MorningStarHarness plugin for OpenCode.
 *
 * - Injects one-time harness bootstrap into first user message.
 * - Registers skill paths only inside this package: `harness-skills/` (synced at build / repo postinstall; includes `mstar-host`).
 * - Loads agents from `harness-agents/` only (same sync). Does not use `process.cwd()` so OpenCode project cwd does not matter.
 * - Loads custom commands from `harness-commands/` only (same sync).
 * - Non-blocking `status.json` write lint (roadmap §8.5 `beforeStatusWrite`, v1):
 *   on structured file-write tools targeting `{HARNESS_DIR}/status.json`, runs the
 *   engine `status.validateStatus` and emits a `warn` on violations. Never blocks.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { resolveHarnessDir, validateStatus } from "@mstar-harness/engine";
import type { GateResult, StatusDoc } from "@mstar-harness/engine";
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
/** Published layout: `dist/mstar.js` (or `src/mstar.ts`) -> package root is one level up. */
const packageRoot = path.resolve(__dirname, "..");

const bundledSkillsDir = path.join(packageRoot, "harness-skills");
const bundledAgentsDir = path.join(packageRoot, "harness-agents");
const bundledCommandsDir = path.join(packageRoot, "harness-commands");
const bootstrapAgentsPath = path.join(packageRoot, "AGENTS.md");
const BOOTSTRAP_MARKER = "IMPORTANT_FOR_HARNESS";

function resolveSkillPathCandidates(): string[] {
  if (fs.existsSync(bundledSkillsDir)) return [bundledSkillsDir];
  return [];
}

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

const loadAgentsFromDir = (agentsDirPath: string): Record<string, JsonObject> => {
  if (!fs.existsSync(agentsDirPath)) return {};

  const files = fs
    .readdirSync(agentsDirPath)
    .filter((name: string) => name.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b));

  const result: Record<string, JsonObject> = {};
  for (const file of files) {
    const filePath = path.join(agentsDirPath, file);
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

const loadBundledAgents = (): Record<string, JsonObject> => loadAgentsFromDir(bundledAgentsDir);

const loadBundledCommands = (): Record<string, JsonObject> => {
  if (!fs.existsSync(bundledCommandsDir)) return {};

  const files = fs
    .readdirSync(bundledCommandsDir)
    .filter((name: string) => /\.(?:md|mdc|markdown|txt)$/.test(name))
    .sort((a, b) => a.localeCompare(b));

  const result: Record<string, JsonObject> = {};
  for (const file of files) {
    const filePath = path.join(bundledCommandsDir, file);
    const content = fs.readFileSync(filePath, "utf8");
    const { frontmatter, body } = extractFrontmatterAndBody(content);
    const parsed = parseSimpleFrontmatter(frontmatter);
    const parsedName = typeof parsed.name === "string" ? parsed.name : file.replace(/\.(?:md|mdc|markdown|txt)$/, "");

    const commandDef: JsonObject = {
      template: body.trim(),
    };
    if (typeof parsed.description === "string") {
      commandDef.description = parsed.description;
    }
    if (typeof parsed.agent === "string") {
      commandDef.agent = parsed.agent;
    }
    if (typeof parsed.model === "string") {
      commandDef.model = parsed.model;
    }

    result[parsedName] = commandDef;
  }

  return result;
};

/**
 * Plugin log channel (roadmap §8.5 `HostAdapter.log`). v1 routes to the
 * console — OpenCode captures plugin stdout/stderr into its server log.
 */
export type StatusLogger = (level: "info" | "warn" | "error", message: string) => void;

const defaultStatusLogger: StatusLogger = (level, message) => {
  const line = `[mstar-harness] ${message}`;
  if (level === "warn") console.warn(line);
  else if (level === "error") console.error(line);
  else console.log(line);
};

const STATUS_FILE = "status.json";

/**
 * Non-blocking `status.json` write lint (roadmap §8.5 `beforeStatusWrite`, v1).
 *
 * Given the target path of a file write, resolves `{HARNESS_DIR}` from the
 * target via the engine (`path.resolveHarnessDir` find-first-stop) and runs
 * `status.validateStatus` on the document about to be written (`opts.doc`) or
 * on the current file. Violations are surfaced as `warn` through the plugin
 * log channel. NEVER throws and NEVER blocks (v1 hard constraint) — unexpected
 * errors degrade to a single `error` log and a `null` return.
 *
 * Returns the engine gate result when the target is the canonical harness
 * `status.json` and something could be validated; `null` otherwise (not a
 * harness status write, file does not exist yet, or validation aborted).
 */
export function validateStatusWrite(
  targetPath: string,
  opts: { doc?: unknown; log?: StatusLogger } = {},
): GateResult | null {
  const log = opts.log ?? defaultStatusLogger;
  try {
    const resolved = path.resolve(targetPath);
    if (path.basename(resolved) !== STATUS_FILE) return null;

    const harnessDir = resolveHarnessDir(path.dirname(resolved));
    if (!harnessDir || path.join(harnessDir, STATUS_FILE) !== resolved) return null;

    const result: GateResult | null =
      opts.doc !== undefined
        ? validateStatus(opts.doc as StatusDoc)
        : fs.existsSync(resolved)
          ? validateStatus(resolved)
          : null;
    if (!result) return null;

    if (!result.ok) {
      for (const violation of result.violations) {
        const fix = violation.fix ? ` (fix: ${violation.fix})` : "";
        log(
          "warn",
          `status.json validation: [${violation.severity}] ${violation.code}: ${violation.message}${fix}`,
        );
      }
    }
    return result;
  } catch (error) {
    // v1 hard constraint: never throw, never block.
    log("error", `status.json validation aborted: ${(error as Error).message}`);
    return null;
  }
}

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
        command?: Record<string, JsonObject>;
      };
      runtimeConfig.skills = runtimeConfig.skills || {};
      runtimeConfig.skills.paths = runtimeConfig.skills.paths || [];
      for (const skillPath of resolveSkillPathCandidates()) {
        if (fs.existsSync(skillPath) && !runtimeConfig.skills.paths.includes(skillPath)) {
          runtimeConfig.skills.paths.push(skillPath);
        }
      }

      const markdownAgents = loadBundledAgents();
      runtimeConfig.agent = runtimeConfig.agent || {};
      for (const [agentId, definition] of Object.entries(markdownAgents)) {
        runtimeConfig.agent[agentId] = {
          ...(runtimeConfig.agent[agentId] || {}),
          ...definition,
        };
      }

      const markdownCommands = loadBundledCommands();
      runtimeConfig.command = runtimeConfig.command || {};
      for (const [commandId, definition] of Object.entries(markdownCommands)) {
        runtimeConfig.command[commandId] = {
          ...(runtimeConfig.command[commandId] || {}),
          ...definition,
        };
      }
    },

    "tool.execute.before": async (input, output) => {
      // Non-blocking status.json write lint (v1): warn only — never modify
      // args, never throw. Structured file-write tools (`write`/`edit`) carry
      // the target path in `args.filePath`; bash-heredoc writes are out of v1
      // scope. Tool implementations may call `validateStatusWrite` directly.
      const args = (output?.args ?? {}) as Record<string, unknown>;
      if (typeof args.filePath !== "string") return;

      if (input.tool === "write") {
        // Validate the document about to be written when it parses as JSON;
        // otherwise fall back to the current on-disk state.
        const rawContent = args.content;
        let doc: unknown;
        if (typeof rawContent === "string") {
          try {
            doc = JSON.parse(rawContent);
          } catch {
            doc = undefined;
          }
        }
        validateStatusWrite(args.filePath, { doc });
      } else if (input.tool === "edit") {
        validateStatusWrite(args.filePath);
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
