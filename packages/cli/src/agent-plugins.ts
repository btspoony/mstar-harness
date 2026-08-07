import fs from "node:fs";
import path from "node:path";
import { readJson } from "./utils";

/**
 * Agent Plugins v1.0.0 conformance validator (https://agent-plugins.org/specification).
 *
 * Implements the closed plugin.json manifest schema (§5), mcp.json component
 * configuration (§7.2.1), and skills discovery (§6.1/§7.1) without any runtime
 * schema fetching. All validation rules are implemented locally in TS.
 *
 * Severity model:
 * - `errors` — findings that make the package non-conformant (missing/invalid
 *   manifest, `$schema`, `name`, or metadata types; mcp.json violations). Each
 *   line carries a `plugin.json:` / `mcp.json:` / `skills:` prefix.
 * - `warnings` — report-and-ignore findings that do not fail validation:
 *   unknown top-level plugin.json fields are reported and ignored while the
 *   plugin keeps loading (§5.2), non-object `extensions` fields and namespace
 *   entries are reported and ignored without validating their contents
 *   (§5.2/§8.1), and non-conforming skills are skipped while other skills and
 *   component types keep loading (§7.1). A child directory under skills/
 *   without SKILL.md is simply not a skill.
 *
 * Validation continues past report-and-ignore findings so one run aggregates
 * every issue; `ok` is false when any error was recorded.
 */

export type AgentPluginValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

const PLUGIN_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const PLUGIN_TOP_LEVEL_FIELDS: Record<string, true> = {
  $schema: true,
  name: true,
  version: true,
  description: true,
  author: true,
  homepage: true,
  repository: true,
  license: true,
  keywords: true,
  extensions: true,
};

/** §5.5: lowercase alphanumerics, hyphens, periods; no `--` or `..`; alnum start/end; 1-64 chars. */
const PLUGIN_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/**
 * §7.2.1 stdio path containment: cwd/command values must begin with a
 * recognized prefix (`./`, `${PLUGIN_ROOT}/`, `${PLUGIN_DATA}/` — or the bare
 * `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` variable forms for cwd) and the
 * remainder must resolve to a path inside the plugin root. Returns the
 * remainder after the matched prefix, or null when no prefix matches.
 */
function stripMcpPathPrefix(raw: string): string | null {
  if (raw.startsWith("./")) return raw.slice(2);
  if (raw.startsWith("${PLUGIN_ROOT}/")) return raw.slice("${PLUGIN_ROOT}/".length);
  if (raw.startsWith("${PLUGIN_DATA}/")) return raw.slice("${PLUGIN_DATA}/".length);
  if (raw === "${PLUGIN_ROOT}" || raw === "${PLUGIN_DATA}") return "";
  return null;
}

/**
 * True when a prefix-stripped relative path escapes the plugin root after
 * POSIX normalization (leading `..` or an absolute remainder). Pure textual
 * check — no filesystem access.
 */
function escapesPluginRoot(remainder: string): boolean {
  const normalized = path.posix.normalize(remainder);
  return normalized.startsWith("..") || path.posix.isAbsolute(normalized);
}

/** Agent Skills name rules: lowercase alphanumerics + hyphens, no `--`, no leading/trailing hyphen. */
const SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** RFC 7230 token: valid HTTP header field name. */
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const MCP_SERVER_TYPES: Record<string, true> = {
  stdio: true,
  "streamable-http": true,
  sse: true,
};
const STDIO_FIELDS: Record<string, true> = { type: true, command: true, args: true, env: true, cwd: true };
const REMOTE_FIELDS: Record<string, true> = { type: true, url: true, headers: true };
const AUTHOR_FIELDS: Record<string, true> = { name: true, email: true, url: true };

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Minimal YAML frontmatter extractor for SKILL.md files. Returns the parsed
 * key/value map (string scalars only) or null when no `---` block is present.
 */
function parseFrontmatter(filePath: string): Record<string, string> | null {
  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    result[field[1]] = parseScalar(field[2]);
  }
  return result;
}

function isValidMcpUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (!parsed.hostname) return false;
  // §7.2.1: no user information, no fragment.
  if (parsed.username || parsed.password || parsed.hash) return false;
  const host = parsed.hostname;
  const isLoopback =
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(host);
  // Non-loopback endpoints MUST use HTTPS.
  if (!isLoopback && parsed.protocol !== "https:") return false;
  return true;
}

function validateManifest(manifest: unknown, errors: string[], warnings: string[]) {
  if (!isPlainObject(manifest)) {
    errors.push("plugin.json: manifest must be a JSON object");
    return;
  }
  const doc = manifest as Record<string, unknown>;

  // §5.2: unknown top-level fields are reported and ignored; loading continues
  // when the manifest otherwise satisfies this section.
  for (const key of Object.keys(doc)) {
    if (!Object.hasOwn(PLUGIN_TOP_LEVEL_FIELDS, key)) {
      warnings.push(
        `plugin.json: unknown top-level field "${key}" (ignored; client-specific data belongs under "extensions")`,
      );
    }
  }

  // §5.3: required $schema + name.
  const schema = doc["$schema"];
  if (typeof schema !== "string") {
    errors.push(`plugin.json: "$schema" is required and must be the string ${PLUGIN_SCHEMA_URL}`);
  } else if (schema !== PLUGIN_SCHEMA_URL) {
    errors.push(
      `plugin.json: unsupported "$schema" ${JSON.stringify(schema)} (expected ${PLUGIN_SCHEMA_URL})`,
    );
  }

  const name = doc.name;
  if (typeof name !== "string" || name.length === 0) {
    errors.push('plugin.json: "name" is required and must be a non-empty string');
  } else {
    if (name.length > 64) {
      errors.push(`plugin.json: "name" must be 1-64 characters (got ${name.length})`);
    }
    if (!PLUGIN_NAME_PATTERN.test(name)) {
      errors.push(
        `plugin.json: "name" ${JSON.stringify(name)} violates Agent Plugins name rules ` +
          `(lowercase alphanumerics, hyphens, periods; no "--" or ".."; must start and end alphanumeric)`,
      );
    }
  }

  // §5.4: metadata field types.
  for (const field of ["version", "description", "homepage", "repository", "license"] as const) {
    const value = doc[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      errors.push(`plugin.json: "${field}" must be a string (got ${describeType(value)})`);
    }
  }

  if (doc.author !== undefined) {
    if (!isPlainObject(doc.author)) {
      errors.push('plugin.json: "author" must be an object with optional string fields name/email/url');
    } else {
      const author = doc.author as Record<string, unknown>;
      for (const key of Object.keys(author)) {
        if (!Object.hasOwn(AUTHOR_FIELDS, key)) {
          errors.push(
            `plugin.json: "author" has unknown field "${key}" (only name, email, url are allowed)`,
          );
        }
      }
      for (const key of ["name", "email", "url"]) {
        const value = author[key];
        if (value !== undefined && typeof value !== "string") {
          errors.push(`plugin.json: "author.${key}" must be a string (got ${describeType(value)})`);
        }
      }
    }
  }

  if (doc.keywords !== undefined) {
    if (!Array.isArray(doc.keywords) || doc.keywords.some((entry) => typeof entry !== "string")) {
      errors.push('plugin.json: "keywords" must be an array of strings');
    }
  }

  // §5.2/§8.1: a non-object extensions field (or namespace entry) is
  // report-and-ignore, not fatal. The validator implements no client
  // namespaces, so all extensions content is unimplemented-namespace content:
  // report it, ignore it, and never validate its values.
  if (doc.extensions !== undefined) {
    if (!isPlainObject(doc.extensions)) {
      warnings.push('plugin.json: "extensions" is not an object — ignored');
    } else {
      for (const [namespace, value] of Object.entries(doc.extensions as Record<string, unknown>)) {
        if (!isPlainObject(value)) {
          warnings.push(`plugin.json: "extensions.${namespace}" is not an object — ignored`);
        }
      }
    }
  }
}

function validateMcpServer(name: string, entry: unknown, errors: string[]) {
  const prefix = `mcp.json: mcpServers.${name}`;
  if (!isPlainObject(entry)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  const server = entry as Record<string, unknown>;
  const type = server.type;
  if (typeof type !== "string" || !Object.hasOwn(MCP_SERVER_TYPES, type)) {
    errors.push(
      `${prefix}: "type" must be one of "stdio" | "streamable-http" | "sse" (got ${JSON.stringify(type)})`,
    );
    return;
  }

  if (type === "stdio") {
    for (const key of Object.keys(server)) {
      if (!Object.hasOwn(STDIO_FIELDS, key)) {
        errors.push(
          `${prefix}: unknown field "${key}" for stdio server (allowed: type, command, args, env, cwd)`,
        );
      }
    }
    const command = server.command;
    if (typeof command !== "string" || command.length === 0) {
      errors.push(`${prefix}: "command" is required and must be a non-empty string`);
    } else {
      if (/\s/.test(command)) {
        errors.push(
          `${prefix}: "command" must be a single executable token, not a shell command string`,
        );
      } else if (command.includes("/") && !command.startsWith("./")) {
        errors.push(
          `${prefix}: "command" must be a bare executable name or a plugin-relative path beginning with "./"`,
        );
      } else if (command.startsWith("./") && escapesPluginRoot(command.slice(2))) {
        errors.push(
          `${prefix}: "command" must remain within the plugin root (got "${command}")`,
        );
      }
    }
    if (server.args !== undefined) {
      if (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string")) {
        errors.push(`${prefix}: "args" must be an array of strings`);
      }
    }
    if (server.env !== undefined) {
      if (!isPlainObject(server.env)) {
        errors.push(`${prefix}: "env" must be an object of strings`);
      } else {
        for (const [key, value] of Object.entries(server.env as Record<string, unknown>)) {
          if (key === "PLUGIN_ROOT" || key === "PLUGIN_DATA") {
            errors.push(
              `${prefix}: "env" must not set reserved variable "${key}" (clients supply it themselves)`,
            );
          }
          if (typeof value !== "string") {
            errors.push(`${prefix}: "env.${key}" must be a string`);
          }
        }
      }
    }
    if (server.cwd !== undefined) {
      if (typeof server.cwd !== "string") {
        errors.push(`${prefix}: "cwd" must be a string`);
      } else {
        const remainder = stripMcpPathPrefix(server.cwd);
        if (remainder === null) {
          errors.push(
            `${prefix}: "cwd" must be "./…", "${"${PLUGIN_ROOT}"}…", or "${"${PLUGIN_DATA}"}…"`,
          );
        } else if (escapesPluginRoot(remainder)) {
          errors.push(
            `${prefix}: "cwd" must remain within the plugin root (got "${server.cwd}")`,
          );
        }
      }
    }
    return;
  }

  // streamable-http / sse
  for (const key of Object.keys(server)) {
    if (!Object.hasOwn(REMOTE_FIELDS, key)) {
      errors.push(
        `${prefix}: unknown field "${key}" for ${type} server (allowed: type, url, headers)`,
      );
    }
  }
  const url = server.url;
  if (typeof url !== "string" || url.length === 0) {
    errors.push(`${prefix}: "url" is required and must be a non-empty string`);
  } else if (!isValidMcpUrl(url)) {
    errors.push(
      `${prefix}: "url" must be an absolute http(s) URL without user info or fragment; non-loopback endpoints must use https`,
    );
  }
  if (server.headers !== undefined) {
    if (!isPlainObject(server.headers)) {
      errors.push(`${prefix}: "headers" must be an object of strings`);
    } else {
      const seen = new Set<string>();
      for (const [key, value] of Object.entries(server.headers as Record<string, unknown>)) {
        if (typeof value !== "string") {
          errors.push(`${prefix}: "headers.${key}" must be a string`);
          continue;
        }
        if (value.includes("\r") || value.includes("\n")) {
          errors.push(`${prefix}: "headers.${key}" value must be a single HTTP header value`);
        }
        if (!HTTP_HEADER_NAME_PATTERN.test(key)) {
          errors.push(`${prefix}: "headers.${key}" is not a valid HTTP header name`);
        } else {
          const lower = key.toLowerCase();
          if (seen.has(lower)) {
            errors.push(`${prefix}: header "${key}" is duplicated (case-insensitive)`);
          }
          seen.add(lower);
        }
      }
    }
  }
}

function validateMcp(root: string, manifestSchema: unknown, errors: string[]) {
  const mcpPath = path.join(root, "mcp.json");
  if (!fs.existsSync(mcpPath)) return; // §6.2: absent fixed location is not an error.
  let parsed: unknown;
  try {
    parsed = readJson(mcpPath);
  } catch (error) {
    errors.push(`mcp.json: ${(error as Error).message}`);
    return;
  }
  if (!isPlainObject(parsed)) {
    errors.push("mcp.json: configuration must be a JSON object");
    return;
  }
  const doc = parsed as Record<string, unknown>;

  // §7.2.1: closed top level — exactly $schema + mcpServers.
  for (const key of Object.keys(doc)) {
    if (key !== "$schema" && key !== "mcpServers") {
      errors.push(`mcp.json: unknown top-level field "${key}" (only "$schema" and "mcpServers" allowed)`);
    }
  }

  const schema = doc["$schema"];
  if (typeof schema !== "string") {
    errors.push(`mcp.json: "$schema" is required and must be the string ${MCP_SCHEMA_URL}`);
  } else if (schema !== MCP_SCHEMA_URL) {
    errors.push(`mcp.json: unsupported "$schema" ${JSON.stringify(schema)} (expected ${MCP_SCHEMA_URL})`);
  } else {
    // §10.1: mcp.json $schema version MUST match plugin.json's version.
    const manifestVersion =
      typeof manifestSchema === "string"
        ? manifestSchema.match(/^https:\/\/agent-plugins\.org\/schemas\/([^/]+)\/plugin\.schema\.json$/)?.[1]
        : undefined;
    const mcpVersion = schema.match(/^https:\/\/agent-plugins\.org\/schemas\/([^/]+)\/mcp\.schema\.json$/)?.[1];
    if (manifestVersion && mcpVersion && manifestVersion !== mcpVersion) {
      errors.push(
        `mcp.json: "$schema" targets Agent Plugins ${mcpVersion} but plugin.json targets ${manifestVersion} (versions must match)`,
      );
    }
  }

  const servers = doc.mcpServers;
  if (!isPlainObject(servers)) {
    errors.push('mcp.json: "mcpServers" is required and must be an object');
    return;
  }
  for (const [serverName, entry] of Object.entries(servers as Record<string, unknown>)) {
    validateMcpServer(serverName, entry, errors);
  }
}

function validateSkills(root: string, errors: string[], warnings: string[]) {
  const skillsPath = path.join(root, "skills");
  try {
    if (!fs.existsSync(skillsPath)) return; // §6.2: absent fixed location is not an error.
    if (!fs.statSync(skillsPath).isDirectory()) {
      errors.push("skills: skills/ is not a directory (component type invalid)");
      return;
    }
    const entries = fs.readdirSync(skillsPath, { withFileTypes: true });
    const realRoot = fs.realpathSync(root);
    for (const entry of entries) {
      // §7.1: only immediate child directories can be skills. A symlink to a
      // directory counts when its target stays inside the plugin root.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDir = entry.name;
      // §4.1: package paths must resolve within the plugin root; a symlinked
      // skill that resolves outside the root is skipped with a warning.
      let realSkillPath: string;
      try {
        realSkillPath = fs.realpathSync(path.join(skillsPath, skillDir));
      } catch (error) {
        warnings.push(
          `skills: ${skillDir}/ cannot be resolved (${(error as Error).message}; skill skipped)`,
        );
        continue;
      }
      const relative = path.relative(realRoot, realSkillPath);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        warnings.push(
          `skills: ${skillDir}/ resolves outside the plugin root (${realSkillPath}; skill skipped)`,
        );
        continue;
      }
      const skillMdPath = path.join(skillsPath, skillDir, "SKILL.md");
      if (!fs.existsSync(skillMdPath) || !fs.statSync(skillMdPath).isFile()) {
        warnings.push(
          `skills: ${skillDir}/ has no SKILL.md (directory is not a skill; ignored)`,
        );
        continue;
      }
      const frontmatter = parseFrontmatter(skillMdPath);
      if (!frontmatter) {
        // §7.1: missing frontmatter means the skill does not conform; report and skip it.
        warnings.push(
          `skills: ${skillDir}/SKILL.md is missing YAML frontmatter (name and description are required; skill skipped)`,
        );
        continue;
      }
      const skillName = frontmatter.name;
      const problems: string[] = [];
      if (skillName !== skillDir) {
        problems.push(
          `frontmatter "name" ${JSON.stringify(skillName)} must equal the directory name "${skillDir}"`,
        );
      } else if (!SKILL_NAME_PATTERN.test(skillName)) {
        problems.push(
          `frontmatter "name" violates Agent Skills name rules ` +
            `(lowercase alphanumerics and hyphens, no "--", no leading or trailing hyphen)`,
        );
      }
      if (typeof skillName === "string" && skillName.length > 64) {
        problems.push(`frontmatter "name" must be at most 64 characters (got ${skillName.length})`);
      }
      const description = frontmatter.description;
      if (typeof description !== "string" || description.trim().length === 0) {
        problems.push(`frontmatter "description" is required and must be non-empty`);
      } else if (description.length > 1024) {
        problems.push(
          `frontmatter "description" must be at most 1024 characters (got ${description.length})`,
        );
      }
      // §7.1: a non-conforming skill is skipped; the remaining skills still load.
      for (const problem of problems) {
        warnings.push(`skills: ${skillDir}/SKILL.md ${problem} (skill skipped)`);
      }
    }
  } catch (error) {
    // Filesystem/permission failures keep the structured `skills:` prefix
    // instead of escaping to the generic command-level catch.
    errors.push(`skills: ${(error as Error).message}`);
  }
}

export function validateAgentPlugin(root: string): AgentPluginValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const manifestPath = path.join(root, "plugin.json");
  if (!fs.existsSync(manifestPath)) {
    errors.push(`plugin.json: manifest not found at ${manifestPath} (plugin root must contain plugin.json)`);
    return { ok: false, errors, warnings };
  }
  let manifest: unknown;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    errors.push(`plugin.json: ${(error as Error).message}`);
    return { ok: false, errors, warnings };
  }

  validateManifest(manifest, errors, warnings);
  // Keep checking components even after manifest errors: aggregated diagnostics
  // help authors fix every issue in one run. `ok` stays false on any error.
  const manifestSchema = isPlainObject(manifest) ? (manifest as Record<string, unknown>)["$schema"] : undefined;
  validateMcp(root, manifestSchema, errors);
  validateSkills(root, errors, warnings);

  return { ok: errors.length === 0, errors, warnings };
}
