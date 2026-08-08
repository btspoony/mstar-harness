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
 *   Hook coverage follows `resolveHarnessDir` probing (`.mstar/` → `.agents/` →
 *   `.plans/`|`plans/`); repos with a non-probed harness root (e.g. `.harness/`)
 *   MUST set `MSTAR_HARNESS_DIR` in the OpenCode server env — see package README
 *   "Status write lint (hook coverage)" (qc2 F-006).
 * - Non-blocking `beforeDispatch` dispatch lint (roadmap §8.5, v1): on
 *   `task`-tool executions (subagent dispatch), validates the Assignment
 *   header — field presence (`Execute as` / `Delegation` / `Task category`,
 *   backward-compat `assignment.presence.*` codes), full field validation
 *   from the engine (`dispatch.validateAssignmentFields`: exactly-one
 *   Working-branch form, create-form `<base>`, Branch policy reason) and the
 *   default-branch gate (`dispatch.assertDefaultBranchProtected` with the
 *   CLI ea010f1 direct-on-exception wiring). Emits `warn` lines, never
 *   blocks (v1 hard constraint; hard gates are Slice 5 behind
 *   `Enforcement: hard`).
 */
import type { Plugin } from "@opencode-ai/plugin";
import {
  assertDefaultBranchProtected,
  resolveHarnessDir,
  validateAssignmentFields,
  validateStatus,
} from "@mstar-harness/engine";
import type { GateResult, Severity, StatusDoc, ValidationResult } from "@mstar-harness/engine";
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

/**
 * `## Assignment` heading marker: a document carrying this heading is treated
 * as Assignment-shaped and linted even when none of the three fields is found.
 */
const ASSIGNMENT_HEADING_RE = /^#{1,6}\s+Assignment\s*$/m;

/**
 * Line-anchored match of an Assignment header field, tolerating optional list
 * bullets and `**bold**` markers around the key (`- **Execute as**: x`). The
 * value must be non-empty (`(\S.*)`) — a bare `Delegation:` counts as missing.
 */
const ASSIGNMENT_FIELD_RE =
  /^[ \t]*(?:[-*][ \t]+)?\*{0,2}(Execute as|Delegation|Task category)\*{0,2}[ \t]*:[ \t]*(\S.*)$/gm;

type AssignmentPresenceKey = "Execute as" | "Delegation" | "Task category";

const ASSIGNMENT_PRESENCE_SPECS: Record<
  AssignmentPresenceKey,
  { code: string; severity: Severity; message: string; fix: string }
> = {
  "Execute as": {
    code: "assignment.presence.missing-execute-as",
    severity: "high",
    message: 'Assignment is missing "Execute as: <role-id>" — the identity lock that binds this dispatch to a role.',
    fix: 'add "Execute as: <role-id>" to the Assignment header',
  },
  Delegation: {
    code: "assignment.presence.missing-delegation",
    severity: "medium",
    message: 'Assignment is missing "Delegation: allowed|forbidden" — unset assignments default to forbidden.',
    fix: 'add "Delegation: allowed|forbidden" to the Assignment header',
  },
  "Task category": {
    code: "assignment.presence.missing-task-category",
    severity: "medium",
    message: 'Assignment is missing "Task category: <category>" — routing falls back to a generic worker.',
    fix: 'add "Task category: <category>" to the Assignment header',
  },
};

/**
 * Assignment header field-presence check (roadmap §4.3 + §8.5 `beforeDispatch`, v1).
 *
 * Parses the Assignment markdown for the PRESENCE of the three core fields
 * only — `Execute as: <role-id>` / `Delegation: allowed|forbidden` /
 * `Task category: <category>`. Missing fields come back as `medium`/`high`
 * violations (codes `assignment.presence.missing-*`). No value-level
 * validation (Working-branch forms, N→seat mapping, tri identity) — that is
 * Slice 3 via `dispatch.validateAssignmentFields`, which extends this hook.
 *
 * Text that is not Assignment-shaped (no `## Assignment` heading and none of
 * the three fields) returns `{ ok: true, violations: [] }` so unrelated
 * prompts never produce false-positive warnings.
 */
export function validateAssignmentPresence(assignmentText: string): GateResult {
  const present = new Set<string>();
  for (const match of assignmentText.matchAll(ASSIGNMENT_FIELD_RE)) {
    present.add(match[1]);
  }

  const violations: ValidationResult[] = [];
  for (const [key, spec] of Object.entries(ASSIGNMENT_PRESENCE_SPECS)) {
    if (present.has(key)) continue;
    violations.push({
      ok: false,
      severity: spec.severity,
      code: spec.code,
      message: spec.message,
      fix: spec.fix,
    });
  }

  if (
    violations.length === Object.keys(ASSIGNMENT_PRESENCE_SPECS).length &&
    !ASSIGNMENT_HEADING_RE.test(assignmentText)
  ) {
    return { ok: true, violations: [] };
  }
  return { ok: violations.length === 0, violations };
}

/**
 * True when the text looks like an Assignment: carries the `## Assignment`
 * heading or at least one core field line (`Execute as` / `Delegation` /
 * `Task category`). Non-Assignment prompts (plain task instructions) stay
 * silent — no false-positive warnings.
 */
function isAssignmentShaped(assignmentText: string): boolean {
  return ASSIGNMENT_HEADING_RE.test(assignmentText) || assignmentText.match(ASSIGNMENT_FIELD_RE) !== null;
}

/**
 * IO-only branch resolution for the default-branch gate (roadmap §8.5 —
 * the plugin keeps the Assignment parse, no git/file probes):
 * `Working branch: <existing>` → the branch; `Working branch: create <new>
 * from <base>` → the new branch being created; `Branch policy: direct on
 * <branch> — <reason>` → the exception branch. Undefined when the text
 * carries no usable branch form.
 */
function parseAssignmentBranch(assignmentText: string): string | undefined {
  for (const line of assignmentText.split(/\r?\n/)) {
    const match =
      line.match(/^\*\*\s*Working branch\s*\*\*\s*:\s*(.*)$/) ?? line.match(/^Working branch\s*:\s*(.*)$/);
    if (!match) continue;
    const value = match[1]!.trim();
    if (value === "") continue;
    // Case-insensitive create-form token match, same as the engine: the
    // created branch is the gate target; missing `<base>` is the engine's
    // `branch-missing-base` violation, not a gate input.
    const create = value.match(/^create\s+(\S+)(?:\s+from\s+(\S+))?$/i);
    if (create) return create[1]!;
    return value.split(/\s+/)[0]!;
  }
  for (const line of assignmentText.split(/\r?\n/)) {
    const match =
      line.match(/^\*\*\s*Branch policy\s*\*\*\s*:\s*(.*)$/) ?? line.match(/^Branch policy\s*:\s*(.*)$/);
    if (!match) continue;
    const direct = match[1]!.trim().match(/^direct\s+on\s+(\S+)/i);
    if (direct) return direct[1]!;
  }
  return undefined;
}

/**
 * Parse the Assignment's `Branch policy: direct on <branch> — <reason>`
 * form. Returns the exception branch only for the well-formed direct-on
 * form (branch + reason, same separator set as the engine's
 * `validateAssignmentFields`); undefined when absent or malformed — the
 * default-branch gate recognizes explicit direct-on exceptions only.
 * Mirrors the CLI helper (`packages/cli` fix ea010f1) so the plugin's
 * exception wiring stays byte-consistent with `mstar dispatch validate`.
 */
function parseBranchPolicyDirectOnBranch(assignmentText: string): string | undefined {
  for (const line of assignmentText.split(/\r?\n/)) {
    const match =
      line.match(/^\*\*\s*Branch policy\s*\*\*\s*:\s*(.*)$/) ?? line.match(/^Branch policy\s*:\s*(.*)$/);
    if (match) {
      const form = match[1]!.trim().match(/^direct\s+on\s+(\S+)(?:\s*(?:[—–]|--|-)\s*(.+))?$/);
      if (form && (form[2] ?? "").trim() !== "") return form[1]!.trim();
      return undefined;
    }
  }
  return undefined;
}

/**
 * Non-blocking dispatch-side lint (roadmap §8.5 `beforeDispatch`, v1).
 *
 * Full Assignment validation, warn-only: (1) the Slice-2 presence lint
 * (backward-compat `assignment.presence.*` codes for the three core
 * fields), (2) `dispatch.validateAssignmentFields` from the engine
 * (required fields, exactly-one Working-branch form, create-form `<base>`,
 * Branch policy reason) and (3) the default-branch gate via
 * `dispatch.assertDefaultBranchProtected` — the checked branch comes from
 * the Assignment's own Working branch / Branch policy forms, else
 * `$MSTAR_WORKING_BRANCH`; a well-formed `Branch policy: direct on
 * <branch> — <reason>` exception is honored only when its branch is the
 * one being checked (CLI ea010f1 wiring). One `warn` line per violation
 * through the `[mstar-harness]` channel. NEVER throws and NEVER blocks
 * (v1 hard constraint) — unexpected errors degrade to a single `error` log
 * and a `null` return.
 *
 * Returns the gate result for Assignment-shaped text, an ok result for
 * text that is not an Assignment, and `null` only when the check aborted.
 */
export function validateDispatchAssignment(
  assignmentText: string,
  opts: { log?: StatusLogger } = {},
): GateResult | null {
  const log = opts.log ?? defaultStatusLogger;
  try {
    // Shape guard: non-Assignment prompts stay silent (no false positives).
    if (!isAssignmentShaped(assignmentText)) return { ok: true, violations: [] };

    const violations: ValidationResult[] = [];
    // (1) Backward-compat presence lint (Slice 2 codes).
    violations.push(...validateAssignmentPresence(assignmentText).violations);
    // (2) Engine full field validation (writable default — read-only
    // assignments are not detectable from the prompt text alone).
    violations.push(...validateAssignmentFields(assignmentText).violations);
    // (3) Default-branch gate — IO-only branch resolution.
    const branch = parseAssignmentBranch(assignmentText) ?? process.env.MSTAR_WORKING_BRANCH;
    if (branch !== undefined && branch.trim() !== "") {
      const directOnException = parseBranchPolicyDirectOnBranch(assignmentText) === branch.trim();
      violations.push(...assertDefaultBranchProtected(branch.trim(), { directOnException }).violations);
    }

    const result: GateResult = { ok: violations.length === 0, violations };
    if (!result.ok) {
      for (const violation of result.violations) {
        const fix = violation.fix ? ` (fix: ${violation.fix})` : "";
        log(
          "warn",
          `assignment validation: [${violation.severity}] ${violation.code}: ${violation.message}${fix}`,
        );
      }
    }
    return result;
  } catch (error) {
    // v1 hard constraint: never throw, never block.
    log("error", `assignment validation aborted: ${(error as Error).message}`);
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
      const args = (output?.args ?? {}) as Record<string, unknown>;

      // beforeDispatch-equivalent (v1): non-blocking Assignment validation
      // warn on subagent dispatch. OpenCode's `task` tool carries the
      // subagent prompt — the harness Assignment markdown — in `args.prompt`;
      // missing core fields (Execute as / Delegation / Task category),
      // branch-form violations and default-protected-branch work are logged
      // as warnings. Never blocks, never modifies args (v1 hard constraint).
      if (input.tool === "task" && typeof args.prompt === "string") {
        validateDispatchAssignment(args.prompt);
        return;
      }

      // Non-blocking status.json write lint (v1): warn only — never modify
      // args, never throw. Structured file-write tools (`write`/`edit`) carry
      // the target path in `args.filePath`; bash-heredoc writes are out of v1
      // scope. Tool implementations may call `validateStatusWrite` directly.
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
        // v1 limitation (qc2 F-005 / qc3 F-7): validates the PRE-edit on-disk
        // file, not the patched result — an edit that turns a valid file
        // invalid is caught by the subsequent write, and editing an already
        // invalid file re-warns about the state being replaced. Computing the
        // patched doc for `edit` is a later-slice improvement.
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
