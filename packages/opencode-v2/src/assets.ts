/**
 * Asset loaders + frontmatter projection for the OpenCode V2 native package.
 *
 * Consumes the bundled asset trees synced by `scripts/bundle-harness-assets.ts`
 * (`harness-skills/`, `harness-agents/`, `harness-commands/` — repo-root
 * `skills/`/`agents/`/`commands/` plus this package's V2-only `agents/`
 * overlays) and produces the loader/projection API the entry registers through
 * the V2 editor surface (`ctx.agent.update` upserts, `ctx.command.add`,
 * `ctx.skill.add`).
 *
 * Package-local resolution: every loader takes an explicit directory anchored
 * at this package's root (see `packageRoot`), never `process.cwd()` — the
 * OpenCode project cwd must not influence which assets load (same rule as V1
 * `packages/opencode/src/mstar.ts`).
 *
 * Projection semantics (shared contract §Q2, pinned from upstream tag
 * `v2.0.26` `packages/schema/src/config/agent.ts` + `packages/schema/src/permission.ts`):
 * - agent frontmatter `prompt` (the markdown body) → V2 `system`;
 * - legacy `tools` map and legacy `permission.*` tree are dropped and converted
 *   to an ordered V2 `permissions` ruleset (`{action, resource, effect}`,
 *   last-match-wins) — legacy `tools` enables become `effect: "allow"` rules
 *   first, then legacy permission-tree entries in source order;
 * - `mode` passes through only when it is one of the V2 agent-mode literals
 *   `["subagent", "primary", "all"]` (the enum expresses the V1 seat
 *   semantics: primary PM seat, subagent leaves); anything else is dropped;
 * - all other frontmatter keys are preserved verbatim.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonPrimitive = string | number | boolean | null;
type JsonObject = Record<string, unknown>;

/** V2 agent-mode literals — `packages/schema/src/config/agent.ts` @ v2.0.26:
 * `mode: Schema.Literals(["subagent", "primary", "all"])`. */
const V2_AGENT_MODES = ["subagent", "primary", "all"] as const;
export type V2AgentMode = (typeof V2_AGENT_MODES)[number];

/** V2 permission rule — `packages/schema/src/permission.ts` @ v2.0.26:
 * `Rule = { action: string, resource: string, effect: "allow"|"deny"|"ask" }`,
 * `Ruleset = Rule[]` (ordered, last-match-wins). */
export type PermissionRule = {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
};

export type ProjectedAgent = JsonObject & {
  system: string;
  mode?: V2AgentMode;
  permissions: PermissionRule[];
};

export type CommandDefinition = JsonObject & {
  template: string;
  description?: string;
  agent?: string;
  model?: string;
};

export type SkillEntry = { name: string; location: string };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Published layout: `dist/mstar.js` (or `src/assets.ts`) -> package root is one level up. */
export const packageRoot = path.resolve(__dirname, "..");

export const bundledSkillsDir = path.join(packageRoot, "harness-skills");
export const bundledAgentsDir = path.join(packageRoot, "harness-agents");
export const bundledCommandsDir = path.join(packageRoot, "harness-commands");

type FrontmatterAndBody = { frontmatter: string; body: string };

export const extractFrontmatterAndBody = (content: string): FrontmatterAndBody => {
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

/** Minimal nested-map frontmatter parser (ported from V1 mstar.ts — the
 * harness agent/role markdown uses only scalar and single-level map shapes). */
export const parseSimpleFrontmatter = (frontmatter: string): JsonObject => {
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

    const key = trimmed.slice(0, separator).trim().replace(/^["']|["']$/g, "");
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
      const blockLines: string[] = [];
      const baseIndent = indent;
      for (let j = i + 1; j < lines.length; j += 1) {
        const blockLine = lines[j];
        const blockIndent = blockLine.match(/^ */)?.[0]?.length ?? 0;
        if (blockLine.trim() && blockIndent <= baseIndent) break;
        const normalized = blockLine.startsWith(" ".repeat(baseIndent + 2))
          ? blockLine.slice(baseIndent + 2)
          : blockLine.trim()
            ? blockLine.trim()
            : "";
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

/** Join a readdir-derived entry name under the bundled directory it was listed
 * from; refuses a result that resolves outside that directory (same guard as
 * V1 mstar.ts). */
const joinBundledEntry = (dir: string, name: string): string => {
  const base = path.resolve(dir);
  const resolved = path.resolve(base, name);
  const withinEntry =
    resolved === base ||
    resolved.startsWith(base + path.sep) ||
    (base.endsWith(path.sep) && resolved.startsWith(base));
  if (!withinEntry) {
    throw new Error(`bundled entry escapes ${base}: ${name}`);
  }
  return resolved;
};

/** Explicit missing-directory behavior: a missing bundled directory yields an
 * empty result — overlay/optional trees legitimately may be absent — while a
 * listed entry that cannot be READ is a hard error naming the path. */
export function loadAgentsFromDir(agentsDirPath: string): Record<string, JsonObject> {
  if (!fs.existsSync(agentsDirPath)) return {};

  const files = fs
    .readdirSync(agentsDirPath)
    .filter((name: string) => name.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b));

  const result: Record<string, JsonObject> = {};
  for (const file of files) {
    const filePath = joinBundledEntry(agentsDirPath, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      throw new Error(`bundled agent unreadable: ${filePath} (${String((error as Error).message)})`, { cause: error });
    }
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
}

export function loadCommandsFromDir(commandsDirPath: string): Record<string, CommandDefinition> {
  if (!fs.existsSync(commandsDirPath)) return {};

  const files = fs
    .readdirSync(commandsDirPath)
    .filter((name: string) => /\.(?:md|mdc|markdown|txt)$/.test(name))
    .sort((a, b) => a.localeCompare(b));

  const result: Record<string, CommandDefinition> = {};
  for (const file of files) {
    const filePath = joinBundledEntry(commandsDirPath, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      throw new Error(`bundled command unreadable: ${filePath} (${String((error as Error).message)})`, { cause: error });
    }
    const { frontmatter, body } = extractFrontmatterAndBody(content);
    const parsed = parseSimpleFrontmatter(frontmatter);
    const parsedName =
      typeof parsed.name === "string" ? parsed.name : file.replace(/\.(?:md|mdc|markdown|txt)$/, "");

    const commandDef: CommandDefinition = {
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
}

/** Skill discovery: one `SkillEntry` per bundled skill directory containing a
 * `SKILL.md`, with the `location` resolved package-locally (absolute path under
 * the given skills dir) so the entry registers a location that resolves from
 * the installed package, never from consumer cwd. */
export function loadSkillsFromDir(skillsDirPath: string): SkillEntry[] {
  if (!fs.existsSync(skillsDirPath)) return [];

  const entries = fs
    .readdirSync(skillsDirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const result: SkillEntry[] = [];
  for (const name of entries) {
    const skillDir = joinBundledEntry(skillsDirPath, name);
    const skillFile = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    result.push({ name, location: skillFile });
  }

  return result;
}

export function loadBundledAgents(): Record<string, JsonObject> {
  return loadAgentsFromDir(bundledAgentsDir);
}

export function loadBundledCommands(): Record<string, CommandDefinition> {
  return loadCommandsFromDir(bundledCommandsDir);
}

export function loadBundledSkills(): SkillEntry[] {
  return loadSkillsFromDir(bundledSkillsDir);
}

const isV2AgentMode = (value: unknown): value is V2AgentMode =>
  typeof value === "string" && (V2_AGENT_MODES as readonly string[]).includes(value);

const isPermissionEffect = (value: unknown): value is PermissionRule["effect"] =>
  value === "allow" || value === "deny" || value === "ask";

/** Legacy frontmatter -> V2 agent info (conversion table; §Q2 semantics above).
 * Fails closed: a permission value that is not an effect literal throws naming
 * the offending action/resource — silent projection drift is never acceptable
 * on a claimed seam. */
export function projectAgentDefinition(raw: JsonObject): ProjectedAgent {
  const projected: JsonObject = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "prompt" || key === "tools" || key === "permission") continue;
    projected[key] = value;
  }

  projected.system = typeof raw.prompt === "string" ? raw.prompt : "";
  delete projected.mode;
  if (isV2AgentMode(raw.mode)) {
    projected.mode = raw.mode;
  }

  const rules: PermissionRule[] = [];

  if (typeof raw.tools === "object" && raw.tools !== null && !Array.isArray(raw.tools)) {
    for (const [action, enabled] of Object.entries(raw.tools)) {
      rules.push({ action, resource: "*", effect: enabled === true ? "allow" : "deny" });
    }
  }

  if (typeof raw.permission === "object" && raw.permission !== null && !Array.isArray(raw.permission)) {
    for (const [action, resourceMap] of Object.entries(raw.permission)) {
      if (typeof resourceMap !== "object" || resourceMap === null || Array.isArray(resourceMap)) {
        throw new Error(
          `agent projection: permission.${action} must be a resource -> effect map`,
        );
      }
      for (const [resource, effect] of Object.entries(resourceMap)) {
        if (!isPermissionEffect(effect)) {
          throw new Error(
            `agent projection: permission.${action}.${resource} carries non-effect value ${JSON.stringify(effect)} (expected allow|deny|ask)`,
          );
        }
        rules.push({ action, resource, effect });
      }
    }
  }

  projected.permissions = rules;
  return projected as ProjectedAgent;
}
