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
import { refusalEnvelope } from "../envelope.js";
import { commandEnvelopeSchema } from "../definitions.js";
import {
  diagnoseCodexHost,
  diagnoseCursorHost,
  diagnoseDshHost,
  diagnoseKimiHost,
  diagnoseMcpTarget,
  diagnoseOmpHost,
  diagnoseZcodeHost,
  formatPluginVersionDoctorNote,
  parseOmpPluginList,
  resolveDshProfileDir,
  resolveProjectRoot,
  validateAgentPlugin,
} from "../host-health.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";
import {
  classifyOpencodeProbeError,
  diagnoseOpencodeV2Host,
  OPENCODE_VERSION_TIMEOUT_MS,
  opencodeProbeFailureMessage,
  parseOpencodeVersionOutput,
  type OpencodeGeneration,
} from "../host-health/opencode-v2.js";

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

/**
 * Bounded `opencode --version` probe for the doctor's generation resolution
 * (same precedence as init: explicit flag → probe → fail-closed refusal).
 * The parse and refusal wording are shared with the CLI's probe module via
 * `host-health/opencode-v2`; only the subprocess boundary lives here.
 * Failures refuse with the failure mode and the `--opencode-generation
 * <v1|v2>` recovery — never a guess.
 */
function probeOpencodeGenerationForDoctor(): OpencodeGeneration {
  let output = "";
  try {
    output = execFileSync("opencode", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENCODE_VERSION_TIMEOUT_MS,
    });
  } catch (error) {
    const mode = classifyOpencodeProbeError(error);
    const stdoutField = error !== null && typeof error === "object" && "stdout" in error ? error.stdout : undefined;
    const text = typeof stdoutField === "string" ? stdoutField : Buffer.isBuffer(stdoutField) ? stdoutField.toString("utf8") : "";
    const detail = text.trim() === "" ? undefined : text.trim().split(/\r?\n/, 1)[0]?.slice(0, 120);
    throw new Error(opencodeProbeFailureMessage(mode, detail));
  }
  const generation = parseOpencodeVersionOutput(output);
  if (generation === null) {
    throw new Error(opencodeProbeFailureMessage("unparseable", output.trim().split(/\r?\n/, 1)[0]?.slice(0, 120)));
  }
  return generation;
}

function diagnoseOpencodeTarget(root: string, generation: OpencodeGeneration | undefined): {
  location: string;
  errors: string[];
  notes: string[];
  generations?: OpencodeGeneration[];
  generationSource?: string;
} {
  if (generation !== undefined) {
    // Explicit selection scopes the doctor to one generation and skips the probe entirely.
    const result = diagnoseOpencodeV2Host(root, [], { resolved: generation, explicitSelection: true });
    return { location: result.location, errors: result.errors, notes: result.warnings, generations: result.generations, generationSource: result.generationSource };
  }
  try {
    const probed = probeOpencodeGenerationForDoctor();
    const result = diagnoseOpencodeV2Host(root, [], { resolved: probed });
    return { location: result.location, errors: result.errors, notes: result.warnings, generations: result.generations, generationSource: result.generationSource };
  } catch (error) {
    // Probe failure is the doctor's fail-closed refusal: no generation is
    // guessed, the message names the failure mode and the flag recovery.
    return {
      location: path.join(root, "opencode.json"),
      errors: [error instanceof Error ? error.message : String(error)],
      notes: [],
    };
  }
}

async function diagnose(target: (typeof doctorTargets)[number], scope: "global" | "project", generation?: OpencodeGeneration): Promise<{ location: string; errors: string[]; notes: string[]; generations?: OpencodeGeneration[]; generationSource?: string }> {
  if (target === "opencode") {
    const root = scope === "global"
      ? path.join(os.homedir(), ".config", "opencode")
      : resolveProjectRoot();
    return diagnoseOpencodeTarget(root, generation);
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
          { key: "generation", flags: "--opencode-generation <generation>", required: false },
        ],
      },
      input: z.object({
        target: z.enum(doctorTargets).default("opencode"),
        scope: z.enum(["global", "project"]).default("project"),
        output: z.string().optional(),
        generation: z.enum(["v1", "v2"]).optional(),
      }),
      effects: ["read"],
      description: "Validate Morning Star setup for one supported host target.",
      async execute(input, context) {
        const result = await diagnose(input.target, input.scope, input.generation);
        // MCP configs are global by default; project-scoped OpenCode uses the
        // project's own opencode.json, while dsh composes rows in its profile.
        const projectOpencodeMcpPath = input.target === "opencode" && input.scope === "project"
          ? path.join(resolveProjectRoot(), "opencode.json")
          : undefined;
        const mcpHealth = input.target === "dsh"
          ? diagnoseMcpTarget("dsh", resolveDshProfileDir())
          : diagnoseMcpTarget(input.target, os.homedir(), undefined,
            projectOpencodeMcpPath === undefined ? {} : { configFilePath: projectOpencodeMcpPath });
        const errors = [...result.errors, ...mcpHealth.errors];
        const data = {
          ...result,
          errors,
          notes: [...result.notes, ...mcpHealth.notes],
          mcpHealth,
          target: input.target,
          scope: input.scope,
          // The transport that owns per-host discovery supplies the installed
          // version; without the hook the note degrades to the not-installed
          // text instead of inventing a version.
          pluginVersionNote: formatPluginVersionDoctorNote(
            input.target,
            context.versions.cli ?? "unknown",
            context.effects.detectPluginVersion?.({ target: input.target, scope: input.scope }) ?? null,
          ),
          ...(input.output === undefined ? {} : { output: input.output }),
        };
        return errors.length === 0
          ? ok("doctor", data)
          : refusalEnvelope({ command: "doctor", status: "refused", code: "doctor.unhealthy", exitCode: 1, message: `${errors.length} issue(s)`, details: data , recovery: "Resolve the health findings listed in the doctor report. Run mstar doctor."});
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
          : refusalEnvelope({ command: "plugin.validate", status: "refused", code: "plugin.invalid", exitCode: 1, message: result.errors.join("\n"), details: { root, ...result } , recovery: "Correct the plugin package errors listed in the validation report. Run mstar plugin validate."});
      },
    }),
    command("path.resolve", {
      cli: { path: ["path", "resolve"], aliases: [], arguments: [{ key: "path", required: false, variadic: false }], options: [] },
      input: z.object({ path: z.string().min(1).optional() }),
      effects: ["read"],
      description: "Resolve harness, specs, workflow, and project directories from a start directory.",
      async execute(input, context) {
        const startDir = input.path === undefined ? context.cwd : path.resolve(context.cwd, input.path);
        // `controlRoot` is a HARNESS dir, not a workspace boundary; feeding it
        // as `workspaceRoot` makes the resolver refuse the very harness it
        // sits inside (the boundary contains the answer). Resolve from the
        // start directory alone, as the contract's canonical form does.
        const harnessDir = resolveHarnessDir(startDir);
        if (harnessDir === null) {
          return refusalEnvelope({ command: "path.resolve", status: "refused", code: "path.harness-not-found", exitCode: 1, message: `no harness dir found from ${startDir}`, details: {
            startDir, harnessDir: null, specsDir: null, workflowDir: null, projectDir: null,
          } , recovery: "Set the starting path to a directory inside an existing harness. Run mstar path resolve."});
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
        if (signals.length === 0) return refusalEnvelope({ command: "host.detect", status: "usage", code: "command.invalid-input", exitCode: 2, message: "usage: host detect --signals <comma-list>" });
        const unknown = signals.find((signal) => !hostSignals.includes(signal as (typeof hostSignals)[number]));
        if (unknown !== undefined) return refusalEnvelope({ command: "host.detect", status: "usage", code: "command.invalid-input", exitCode: 2, message: `unknown signal ${JSON.stringify(unknown)}` });
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
        if (!hostIds.includes(input.host as (typeof hostIds)[number])) return refusalEnvelope({ command: "host.skill-root", status: "usage", code: "command.invalid-input", exitCode: 2, message: `unknown host ${JSON.stringify(input.host)}` });
        return ok("host.skill-root", { root: resolveSkillRoot(input.host as HostId, { skill: input.skill, rel: input.rel }) });
      },
    }),
  ];
}
