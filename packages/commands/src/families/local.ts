import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectHarnessKind,
  detectHost,
  emitGitignoreSnippet,
  hasHarnessRootDeclaration,
  resolveHarnessDir,
  resolveProjectDir,
  resolveScaffoldDirs,
  resolveSkillRoot,
  resolveSpecsDir,
  resolveWorkflowDir,
  scaffoldHarness,
  setArtifactStore,
  createFsStore,
  type HostId,
  type ToolSignal,
} from "@mstar-harness/engine";
import { z } from "zod";
import { commandEnvelopeSchema } from "../definitions.js";
import {
  diagnoseCodexHost,
  diagnoseCursorHost,
  diagnoseDshHost,
  diagnoseKimiHost,
  diagnoseOmpHost,
  diagnoseOpencodeHost,
  diagnoseZcodeHost,
  formatPluginVersionDoctorNote,
  parseOmpPluginList,
  resolveProjectRoot,
  validateAgentPlugin,
} from "../host-health.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";

const doctorTargets = ["opencode", "cursor", "codex", "zcode", "omp", "dsh", "kimi"] as const;
const hostSignals = [
  "subagent_type", "question", "task_subagent", "task_agent_batch", "ask", "hub", "Agent", "AgentSwarm",
  "AskUserQuestion", "EnterPlanMode", "TodoWrite", "plan_slash", "goal", "functions.*", "tool_search",
] as const;
const hostIds = ["opencode", "omp", "pi", "dsh", "cursor", "codex", "kimi", "zcode"] as const;
const harnessRepoPath = path.join(os.homedir(), ".mstar", "harness");
const harnessMarkers = [".codex-plugin/plugin.json", ".zcode-plugin/plugin.json", ".omp-plugin/plugin.json"];
const agentsTemplate = `# AGENTS.md — .mstar/ (harness layer)

- Path symbols: {HARNESS_DIR} = .mstar/; {PLAN_DIR} = plans/; {SDD_DIR} = sdd/<plan-id>/;
  {ITERATION_DIR} = iterations/; {KNOWLEDGE_DIR} = knowledge/; {SPECS_DIR} = specs/;
  {WORKFLOW_DIR} = workflows/; {PROJECT_DIR} = projects/ (SSOT: skills/mstar-conventions).
- Process vs results: process artifacts (plans/, iterations/, sdd/, status.json, workflows/,
  projects/) stay local and gitignored; results (this file, knowledge/, specs/) are tracked
  and shared across clones.
- Done: only @project-manager or @qa-engineer may set Done; implementers set InReview.
`;

function ok(id: string, data: unknown): CommandEnvelope {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function refused(id: string, code: string, message: string, details?: Record<string, unknown>): CommandEnvelope<never> {
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message, ...(details === undefined ? {} : { details }) };
}
function usage(id: string, message: string): CommandEnvelope<never> {
  return { version: 1, command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message };
}

function runBin(bin: string): (args: string[]) => string {
  return (args) => {
    try {
      return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const stdout = (error as { stdout?: string | Buffer }).stdout;
      if (typeof stdout === "string" && stdout !== "") return stdout;
      if (Buffer.isBuffer(stdout) && stdout.length > 0) return stdout.toString("utf8");
      throw error;
    }
  };
}

function localHarnessErrors(): string[] {
  if (!fs.existsSync(harnessRepoPath)) return [`Missing local harness repo: ${harnessRepoPath}`];
  const marker = harnessMarkers.map((entry) => path.join(harnessRepoPath, entry)).find((entry) => fs.existsSync(entry));
  return marker === undefined
    ? [`Local harness repo is missing a plugin marker (expected one of: ${harnessMarkers.join(", ")}).`]
    : [];
}

function gitWorkspaceRoot(startDir: string): string {
  try {
    const cdup = execFileSync("git", ["rev-parse", "--show-cdup"], {
      cwd: startDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!cdup) return startDir;
    let boundary = startDir;
    for (const segment of cdup.split(/[\\/]/)) {
      if (segment && segment !== ".") boundary = path.dirname(boundary);
    }
    return boundary;
  } catch {
    return startDir;
  }
}

function pluginRoot(explicit: string | undefined): string {
  if (explicit !== undefined) return path.resolve(explicit);
  let candidate = resolveProjectRoot();
  while (!fs.existsSync(path.join(candidate, "plugin.json"))) {
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return candidate;
}

async function diagnose(target: (typeof doctorTargets)[number], scope: "global" | "project"): Promise<{ location: string; errors: string[]; notes: string[] }> {
  if (target === "opencode") {
    const result = diagnoseOpencodeHost(resolveProjectRoot(), []);
    return { location: result.location, errors: result.errors, notes: result.warnings };
  }
  if (target === "cursor") {
    const result = diagnoseCursorHost(scope);
    return { location: result.location, errors: result.errors, notes: [] };
  }
  if (target === "kimi") return diagnoseKimiHost();
  if (target === "zcode") {
    const result = diagnoseZcodeHost(scope, { projectRoot: resolveProjectRoot(), harnessRepoPath });
    return { location: result.location, errors: result.errors, notes: [] };
  }
  if (target === "codex") {
    const result = diagnoseCodexHost(runBin("codex"), path.join(os.homedir(), ".agents", "plugins", "marketplace.json"));
    return { location: result.location, errors: [...localHarnessErrors(), ...result.errors], notes: result.notes };
  }
  if (target === "dsh") return diagnoseDshHost(runBin("dsh"));
  const projectRoot = scope === "project" ? resolveProjectRoot() : undefined;
  const gitignorePath = projectRoot === undefined ? undefined : path.join(projectRoot, ".gitignore");
  const gitignore = gitignorePath !== undefined && fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  let installed: Array<Record<string, unknown>> = [];
  let ompAvailable = true;
  try {
    installed = parseOmpPluginList(runBin("omp")(["plugin", "list", "--json"]));
  } catch {
    ompAvailable = false;
  }
  const present = new Set(gitignore.split(/\r?\n/));
  const missing = projectRoot === undefined || hasHarnessRootDeclaration(gitignore)
    ? []
    : emitGitignoreSnippet("mstar").split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#") && !present.has(line));
  const result = diagnoseOmpHost({
    harnessRepoPath,
    scope,
    ompAvailable,
    installedPlugins: installed,
    localHarnessRepoErrors: localHarnessErrors(),
    missingGitignoreEntries: missing,
  });
  return { location: result.location, errors: result.errors, notes: [] };
}
function command<I>(id: string, definition: Omit<CommandDefinition<I, unknown>, "id" | "output">): CommandDefinition<I, unknown> {
  return { id, output: commandEnvelopeSchema, ...definition };
}

export function getLocalCommandDefinitions(): readonly CommandDefinition[] {
  return [
    command("harness.scaffold", {
      cli: { path: ["harness", "scaffold"], aliases: [], arguments: [{ key: "path", required: false, variadic: false }], options: [] },
      input: z.object({ path: z.string().min(1).optional() }),
      effects: ["write"],
      description: "Create the harness directory, v2 status, default project, and the canonical ignore/AGENTS files when absent.",
      async execute(input) {
        const root = input.path === undefined ? process.cwd() : path.resolve(input.path);
        setArtifactStore(createFsStore(resolveScaffoldDirs(root).harnessDir));
        const harnessDir = await scaffoldHarness(root);
        const projectDir = resolveProjectDir(root, { harnessDir });
        const created: string[] = [];
        const skipped: string[] = [];
        const workspaceRoot = gitWorkspaceRoot(root);
        const defaultHarness = path.join(workspaceRoot, ".mstar");
        if (detectHarnessKind(harnessDir) === "mstar" && path.resolve(harnessDir) === defaultHarness) {
          const gitignorePath = path.join(workspaceRoot, ".gitignore");
          const current = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
          if (hasHarnessRootDeclaration(current)) skipped.push(".gitignore (author-owned harness-root declaration)");
          else {
            const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
            const snippetLines = emitGitignoreSnippet("mstar").split("\n").map((line) => line.trim());
            const missing = snippetLines.filter((line) => line !== "" && !lines.has(line));
            if (missing.length > 0) {
              const prefix = current !== "" && !current.endsWith("\n") ? "\n" : "";
              fs.appendFileSync(gitignorePath, `${prefix}${missing.join("\n")}\n`, "utf8");
              created.push(".gitignore (canonical harness snippet)");
            } else skipped.push(".gitignore (canonical harness snippet already present)");
          }
        } else skipped.push(".gitignore (canonical harness snippet) — custom harness layout manages its own ignore rules");
        const agentsPath = path.join(harnessDir, "AGENTS.md");
        if (!fs.existsSync(agentsPath)) {
          fs.writeFileSync(agentsPath, agentsTemplate, "utf8");
          created.push(`${path.basename(harnessDir)}/AGENTS.md`);
        } else skipped.push(`${path.basename(harnessDir)}/AGENTS.md (already present)`);
        return ok("harness.scaffold", { harnessDir, projectDir, created, skipped });
      },
    }),
    command("doctor", {
      cli: {
        path: ["doctor"], aliases: [], arguments: [],
        options: [
          { key: "target", flags: "--target <target>", required: false, defaultValue: "opencode" },
          { key: "scope", flags: "--scope <scope>", required: false, defaultValue: "project" },
          { key: "output", flags: "--output <path>", required: false },
        ],
      },
      input: z.object({
        target: z.enum(doctorTargets).default("opencode"),
        scope: z.enum(["global", "project"]).default("project"),
        output: z.string().optional(),
      }),
      effects: ["read"],
      description: "Validate Morning Star setup for one supported host target.",
      async execute(input, context) {
        const result = await diagnose(input.target, input.scope);
        const data = {
          ...result,
          target: input.target,
          scope: input.scope,
          pluginVersionNote: formatPluginVersionDoctorNote(input.target, context.versions.cli ?? "unknown", null),
          ...(input.output === undefined ? {} : { output: input.output }),
        };
        return result.errors.length === 0
          ? ok("doctor", data)
          : refused("doctor", "doctor.unhealthy", `${result.errors.length} issue(s)`, data);
      },
    }),
    command("plugin.validate", {
      cli: { path: ["plugin", "validate"], aliases: [], arguments: [], options: [{ key: "root", flags: "--root <path>", required: false }] },
      input: z.object({ root: z.string().optional() }),
      effects: ["validate"],
      description: "Validate a plugin package against Agent Plugins v1.0.0.",
      async execute(input) {
        const root = pluginRoot(input.root);
        const result = validateAgentPlugin(root);
        return result.ok
          ? ok("plugin.validate", { root, ...result })
          : refused("plugin.validate", "plugin.invalid", result.errors.join("\n"), { root, ...result });
      },
    }),
    command("path.resolve", {
      cli: { path: ["path", "resolve"], aliases: [], arguments: [{ key: "path", required: false, variadic: false }], options: [] },
      input: z.object({ path: z.string().min(1).optional() }),
      effects: ["read"],
      description: "Resolve harness, specs, workflow, and project directories from a start directory.",
      async execute(input, context) {
        const startDir = input.path === undefined ? context.cwd : path.resolve(context.cwd, input.path);
        const harnessDir = resolveHarnessDir(startDir);
        if (harnessDir === null) {
          return refused("path.resolve", "path.harness-not-found", `no harness dir found from ${startDir}`, {
            startDir, harnessDir: null, specsDir: null, workflowDir: null, projectDir: null,
          });
        }
        return ok("path.resolve", {
          startDir,
          harnessDir,
          specsDir: resolveSpecsDir(harnessDir, { create: false }),
          workflowDir: resolveWorkflowDir(startDir),
          projectDir: resolveProjectDir(startDir),
        });
      },
    }),
    command("host.detect", {
      cli: { path: ["host", "detect"], aliases: [], arguments: [], options: [{ key: "signals", flags: "--signals <list>", required: true }] },
      input: z.object({ signals: z.string().min(1) }),
      effects: ["read"],
      description: "Detect the active host from comma-separated tool-shape signals.",
      async execute(input) {
        const signals = input.signals.split(",").map((signal) => signal.trim()).filter((signal) => signal !== "");
        if (signals.length === 0) return usage("host.detect", "usage: host detect --signals <comma-list>");
        const unknown = signals.find((signal) => !hostSignals.includes(signal as (typeof hostSignals)[number]));
        if (unknown !== undefined) return usage("host.detect", `unknown signal ${JSON.stringify(unknown)}`);
        return ok("host.detect", { host: detectHost(signals as ToolSignal[]) });
      },
    }),
    command("host.skill-root", {
      cli: {
        path: ["host", "skill-root"], aliases: [], arguments: [],
        options: [
          { key: "host", flags: "--host <id>", required: true },
          { key: "skill", flags: "--skill <name>", required: true },
          { key: "rel", flags: "--rel <path>", required: false },
        ],
      },
      input: z.object({ host: z.string().min(1), skill: z.string().min(1), rel: z.string().optional() }),
      effects: ["read"],
      description: "Resolve the loaded skill root for a host.",
      async execute(input) {
        if (!hostIds.includes(input.host as (typeof hostIds)[number])) return usage("host.skill-root", `unknown host ${JSON.stringify(input.host)}`);
        return ok("host.skill-root", { root: resolveSkillRoot(input.host as HostId, { skill: input.skill, rel: input.rel }) });
      },
    }),
  ];
}
