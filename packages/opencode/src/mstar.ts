/**
 * MorningStarHarness plugin for OpenCode.
 *
 * - Injects one-time harness bootstrap into first user message.
 * - Registers skill paths only inside this package: `harness-skills/` (synced at build / repo postinstall; includes `mstar-host`).
 * - Loads agents from `harness-agents/` only (same sync). Does not use `process.cwd()` so OpenCode project cwd does not matter.
 * - Loads custom commands from `harness-commands/` only (same sync).
 * - Dual-mode `status.json` write lint (roadmap §8.5 `beforeStatusWrite`):
 *   on structured file-write tools targeting `{HARNESS_DIR}/status.json`, runs
 *   the engine `status.validateStatus`. Default (no `Enforcement: hard`):
 *   `warn` lines on violations, never blocks. Hard mode (repo iteration
 *   compass frontmatter `enforcement: hard`, engine
 *   `status.resolveCompassEnforcement`): error-level lines with a skill-text
 *   pointer + a GateResult carrying `hardBlocked: true` (a refusal-capable
 *   caller MUST refuse the write — this hook itself cannot abort the tool).
 *   Never throws raw exceptions in either mode — OpenCode's plugin API
 *   (`@opencode-ai/plugin` 1.4.8) `tool.execute.before` returns
 *   `Promise<void>` with no refusal channel, so hard mode is surfaced as the
 *   error logs + structured result (see `validateStatusWrite`).
 *   Hook coverage follows `resolveHarnessDir` — a repo `.mstarc`
 *   `[config] harness_dir`, else probing (`.mstar/` → `.agents/` →
 *   `.plans/`|`plans/`); repos with a non-probed harness root
 *   MUST set `MSTAR_HARNESS_DIR` in the OpenCode server env or declare
 *   `.mstarc` — see package README
 *   "Status write lint (hook coverage)" (qc2 F-006).
 * - Dual-mode `beforeDispatch` dispatch lint (roadmap §8.5): on `task`-tool
 *   executions (subagent dispatch), validates the Assignment header — field
 *   presence (`Execute as` / `Delegation` / `Task category`, backward-compat
 *   `assignment.presence.*` codes), full field validation from the engine
 *   (`dispatch.validateAssignmentFields`: exactly-one Working-branch form,
 *   create-form `<base>`, Branch policy reason), the default-branch gate
 *   (`dispatch.assertDefaultBranchProtected` with the CLI ea010f1
 *   direct-on-exception wiring) and the anti-recursion binding check. The
 *   Assignment's OWN `Enforcement: hard` flag (bold or plain) switches the
 *   hook to hard mode: error-level lines + a GateResult carrying
 *   `hardBlocked: true`; flag absent (or `Enforcement: soft`) stays warn-only.
 *   Never throws raw exceptions in either mode (refusal-channel limitation as
 *   above — see `validateDispatchAssignment`).
 */
import type { Plugin } from "@opencode-ai/plugin";
import {
  applyEnforcement,
  composeDispatchGate,
  isReadOnlyAssignmentRole,
  parseAssignmentFields,
  resolveHarnessDir,
  resolveRepoEnforcement,
  validateStatus,
} from "@mstar-harness/engine";
import type { EnforcementFlag, GateResult, StatusDoc } from "@mstar-harness/engine";
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
 * `status.json` write lint (roadmap §8.5 `beforeStatusWrite`).
 *
 * Given the target path of a file write, resolves `{HARNESS_DIR}` from the
 * target via the engine (`path.resolveHarnessDir` find-first-stop) and runs
 * `status.validateStatus` on the document about to be written (`opts.doc`) or
 * on the current file.
 *
 * Enforcement (roadmap §8.5 C4/D2, Slice 5):
 * - **Warn mode (default)** — flag absent: violations are surfaced as `warn`
 *   through the plugin log channel; `hardBlocked` is false. Unchanged v1
 *   behavior.
 * - **Hard mode** — the write context carries `Enforcement: hard` via
 *   `opts.enforcement`, or (when omitted) the repo's iteration compass
 *   frontmatter declares `enforcement: hard` (engine
 *   `status.resolveCompassEnforcement`): violations are surfaced as `error`
 *   lines with a skill-text pointer and the returned GateResult carries
 *   `hardBlocked: true` — a refusal-capable caller MUST refuse the write
 *   (this hook itself cannot abort the tool; see the blocking-channel note).
 *   Never throws a raw exception: hard mode is the structured result +
 *   error log channel.
 *
 * Blocking channel note (documented behavior): OpenCode's plugin API
 * (`@opencode-ai/plugin` 1.4.8) `tool.execute.before` returns `Promise<void>`
 * — there is no error/refusal return channel on this host. The plugin
 * therefore surfaces hard mode as error-level log lines (captured into the
 * OpenCode server log) + the structured `hardBlocked` result; host bindings
 * with a refusal channel (pi/dsh when their APIs land) must refuse the write
 * when `hardBlocked === true`.
 *
 * Returns the engine gate result when the target is the canonical harness
 * `status.json` and something could be validated; `null` otherwise (not a
 * harness status write, file does not exist yet, or validation aborted).
 */
export function validateStatusWrite(
  targetPath: string,
  opts: { doc?: unknown; log?: StatusLogger; enforcement?: EnforcementFlag } = {},
): GateResult | null {
  const log = opts.log ?? defaultStatusLogger;
  try {
    // Host tool args are `any` — refuse non-string paths before path.resolve
    // (Bun: `The "paths[0]" property must be of type string, got object`).
    if (typeof targetPath !== "string" || targetPath.trim() === "") return null;

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

    const enforcement: EnforcementFlag = opts.enforcement ?? resolveRepoEnforcement(harnessDir);
    if (!result.ok) {
      for (const violation of result.violations) {
        const fix = violation.fix ? ` (fix: ${violation.fix})` : "";
        if (enforcement.hard) {
          log(
            "error",
            `status.json validation (hard gate): [${violation.severity}] ${violation.code}: ${violation.message}${fix} — hardBlocked per Enforcement: hard; refusal requires a host refusal channel (skill: mstar-plan-artifacts/references/status-and-residuals.md)`,
          );
        } else {
          log(
            "warn",
            `status.json validation: [${violation.severity}] ${violation.code}: ${violation.message}${fix}`,
          );
        }
      }
    }
    return applyEnforcement(result, { hard: enforcement.hard });
  } catch (error) {
    // Never throw, never block unexpectedly: unexpected errors degrade to a
    // single `error` log and a `null` return in BOTH modes (hard gates are
    // opt-in — an engine failure must not harden a workflow that was soft).
    log("error", `status.json validation aborted: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Dispatch-side Assignment validation (roadmap §8.5 `beforeDispatch`).
 *
 * Delegates the entire composition to the engine's single shared
 * `dispatch.composeDispatchGate` (qc1 F-001/F-006 — no local composition
 * left in the host adapter):
 * (1) Shape guard — `## Assignment` heading or a core field line
 * (`Execute as` / `Delegation` / `Task category`); non-Assignment prompts
 * stay silent (no false positives).
 * (2) `validateAssignmentFields` — required fields, exactly-one
 * Working-branch form, create-form `<base>`, Branch policy reason; the
 * legacy `assignment.presence.*` codes are engine ALIASES on the three
 * core-field violations (single parser — no local presence parser, qc1
 * F-002). Read-only roles (scout/explore) pass `writable: false` so no
 * spurious `branch-missing` fires (qc3 F-1 / qc2 S-5).
 * (3) Anti-recursion NEVER red line — when the task tool's role binding
 * (`args.subagent` / `args.subagent_type`) equals the Assignment's
 * `Execute as`, a critical-severity violation is logged (qc1 F-004 /
 * qc2 S-2).
 * (4) The default-branch gate — the checked branch comes from the
 * Assignment's own branch forms (create-form name / Working branch /
 * Branch policy branch), else `$MSTAR_WORKING_BRANCH`; a well-formed
 * `Branch policy: direct on <branch> — <reason>` exception is honored only
 * when its branch is the one being checked. Skipped entirely for read-only
 * roles (no writable work on a branch).
 *
 * Enforcement (roadmap §8.5 C4/D2, Slice 5) — the Assignment's OWN flag
 * decides (engine `dispatch.parseEnforcementFlag` via
 * `composeDispatchGate`; per-Assignment, never global):
 * - **Warn mode (default)** — no `Enforcement: hard` on the Assignment: one
 *   `warn` line per violation through the `[mstar-harness]` channel;
 *   `hardBlocked` is false. Unchanged v1 behavior.
 * - **Hard mode** — the Assignment header carries `Enforcement: hard`
 *   (bold or plain): one `error` line per violation with a skill-text
 *   pointer and the returned GateResult carries `hardBlocked: true` — a
 *   refusal-capable caller MUST refuse the dispatch (this hook itself
 *   cannot abort the tool; see the blocking-channel note). Never throws a
 *   raw exception: hard mode is the structured result + error log channel.
 *   `Enforcement: soft` (explicit non-hard) stays warn-only; rollback =
 *   unset the flag. The flag is read from the Assignment HEADER region
 *   only — an example `**Enforcement**: hard` line in the task body does
 *   not harden (qc1 F-003 / qc2 F-003).
 *
 * Blocking channel note (documented behavior): OpenCode's plugin API
 * (`@opencode-ai/plugin` 1.4.8) `tool.execute.before` returns `Promise<void>`
 * — no error/refusal return channel on this host. The plugin therefore
 * surfaces hard mode as error-level log lines (captured into the OpenCode
 * server log) + the structured `hardBlocked` result; host bindings with a
 * refusal channel (pi/dsh when their APIs land) must refuse the dispatch
 * when `hardBlocked === true`.
 *
 * Returns the gate result for Assignment-shaped text, an ok result for
 * text that is not an Assignment, and `null` only when the check aborted.
 */
export function validateDispatchAssignment(
  assignmentText: string,
  opts: { log?: StatusLogger; subagentType?: string } = {},
): GateResult | null {
  const log = opts.log ?? defaultStatusLogger;
  try {
    // Non-string host args (typed string here, but tool args are `any`) stay
    // silent with the exact v1 result shape (`assignmentText.match is not a
    // function` regression guard — qc1 F-004).
    if (typeof assignmentText !== "string") {
      return { ok: true, violations: [] };
    }
    // Read-only roles (scout/explore) skip the branch-form/default-branch
    // gates — the engine composition's `writable` flag.
    const writable = isReadOnlyAssignmentRole(parseAssignmentFields(assignmentText).executeAs ?? "") ? false : undefined;
    const composed = composeDispatchGate(assignmentText, { agent: opts.subagentType ?? "", writable });

    if (!composed.ok) {
      for (const violation of composed.violations) {
        const fix = violation.fix ? ` (fix: ${violation.fix})` : "";
        if (composed.enforcement.hard) {
          log(
            "error",
            `assignment validation (hard gate): [${violation.severity}] ${violation.code}: ${violation.message}${fix} — hardBlocked per Enforcement: hard; refusal requires a host refusal channel (skill: mstar-dispatch-gates)`,
          );
        } else {
          log(
            "warn",
            `assignment validation: [${violation.severity}] ${violation.code}: ${violation.message}${fix}`,
          );
        }
      }
    }
    return composed;
  } catch (error) {
    // Never throw, never block unexpectedly: unexpected errors degrade to a
    // single `error` log and a `null` return in BOTH modes (hard gates are
    // opt-in — an engine failure must not harden a workflow that was soft).
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
      // Snapshot once: host `args` may be getter/Proxy-backed; re-reading
      // `args.prompt` / `args.filePath` between a typeof check and the call
      // can observe a different type (then `.match` / `path.resolve` throw
      // into the abort log channel).
      const args = (output?.args ?? {}) as Record<string, unknown>;
      const prompt = args.prompt;
      const rawFilePath = args.filePath;
      const rawPath = args.path;
      const filePath =
        typeof rawFilePath === "string" ? rawFilePath : typeof rawPath === "string" ? rawPath : undefined;

      // beforeDispatch-equivalent (Slice 5, dual-mode): Assignment
      // validation on subagent dispatch. OpenCode's `task` tool carries the
      // subagent prompt — the harness Assignment markdown — in `args.prompt`;
      // missing core fields (Execute as / Delegation / Task category),
      // branch-form violations, default-protected-branch work and
      // self-recursion (binding == Execute as) surface per the Assignment's
      // own enforcement flag: warn lines by default, error lines +
      // `hardBlocked` result under `Enforcement: hard`. Never modifies args
      // and never throws in either mode; `tool.execute.before` returns void
      // on this host (`@opencode-ai/plugin` 1.4.8 — no refusal channel), so a
      // hard gate degrades to the explicit refusal-channel log below. The
      // role binding key is `subagent` (OpenCode) / `subagent_type` (Cursor).
      if (input.tool === "task" && typeof prompt === "string") {
        const subagentType =
          typeof args.subagent === "string"
            ? args.subagent
            : typeof args.subagent_type === "string"
              ? args.subagent_type
              : "";
        const gate = validateDispatchAssignment(prompt, { subagentType });
        if (gate?.hardBlocked) {
          defaultStatusLogger(
            "error",
            "hard-gate blocked (hardBlocked=true) — refusal requires a host refusal channel",
          );
        }
        return;
      }

      // status.json write lint (Slice 5, dual-mode): warn-only by default;
      // hard mode (repo compass `enforcement: hard`) logs error-level lines
      // + a `hardBlocked` result. Never modifies args and never throws in
      // either mode. Structured file-write tools (`write`/`edit`) carry the
      // target path in `args.filePath` (fallback `args.path`); bash-heredoc
      // writes are out of scope. Tool implementations may call
      // `validateStatusWrite` directly.
      if (typeof filePath !== "string") return;

      if (input.tool === "write") {
        // Validate the document about to be written when it is already an
        // object or parses as JSON; otherwise fall back to on-disk state.
        const rawContent = args.content;
        let doc: unknown;
        if (typeof rawContent === "string") {
          try {
            doc = JSON.parse(rawContent);
          } catch {
            doc = undefined;
          }
        } else if (rawContent !== null && typeof rawContent === "object") {
          doc = rawContent;
        }
        const gate = validateStatusWrite(filePath, { doc });
        if (gate?.hardBlocked) {
          defaultStatusLogger(
            "error",
            "hard-gate blocked (hardBlocked=true) — refusal requires a host refusal channel",
          );
        }
      } else if (input.tool === "edit") {
        // v1 limitation (qc2 F-005 / qc3 F-7): validates the PRE-edit on-disk
        // file, not the patched result — an edit that turns a valid file
        // invalid is caught by the subsequent write, and editing an already
        // invalid file re-warns about the state being replaced. Computing the
        // patched doc for `edit` is a later-slice improvement.
        const gate = validateStatusWrite(filePath);
        if (gate?.hardBlocked) {
          defaultStatusLogger(
            "error",
            "hard-gate blocked (hardBlocked=true) — refusal requires a host refusal channel",
          );
        }
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

/**
 * OpenCode plugin entry (v1 PluginModule).
 *
 * OpenCode's legacy loader treats **every function export** on the package
 * entry as a plugin (`getLegacyPlugins` → `Object.values(mod)`). Our named
 * helpers (`validateStatusWrite` / `validateDispatchAssignment`) are also
 * functions — when invoked with `PluginInput` they return `null` / a
 * GateResult, which then gets pushed into the hooks list and blows up as
 * `plugin config hook failed: null is not an object (evaluating 'N.config')`.
 *
 * Default-exporting `{ server }` makes `readV1Plugin` win and skip the legacy
 * scan, so only `MorningStarHarnessPlugin` is registered. Named helper
 * exports stay available for tests and direct callers.
 */
export default {
  server: MorningStarHarnessPlugin,
};
