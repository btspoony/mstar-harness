import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CoordinationError,
  checkPathOwnership,
  detectHarnessKind,
  detectHost,
  emitGitignoreSnippet,
  hasHarnessRootDeclaration,
  isResultPath,
  nearestExistingDir,
  pathOwnershipWarning,
  probeCheckoutRoot,
  probePathOwnership,
  readMainWorktree,
  resolveAdrDir,
  resolveHarnessDir,
  resolveIterationDir,
  resolveKnowledgeDir,
  resolvePlanDir,
  resolveProcessHarnessDir,
  resolveProjectDir,
  resolveProjectRoot as projectRootFrom,
  resolveReviewDir,
  resolveScaffoldDirs,
  resolveSddDir,
  resolveSkillRoot,
  resolveSpecsDir,
  resolveTrackedResultDir,
  resolveWorkflowDir,
  scaffoldHarness,
  setArtifactStore,
  createFsStore,
  type HostId,
  type PathOwnershipFinding,
  type PathOwnershipTarget,
  type PathOwnershipWarning,
  type ToolSignal,
} from "@mstar-harness/engine";
import { z } from "zod";
import { refusalEnvelope } from "../envelope.js";
import { commandEnvelopeSchema } from "../envelope.js";
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
  probePathNodeRuntime,
  projectInstallPath,
  resolveCliPath,
  resolveDshProfileDir,
  validateAgentPlugin,
} from "../host-health.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";
import { launchDirectoryRefusal } from "./launch-workspace.js";
import {
  classifyOpencodeProbeError,
  diagnoseOpencodeV2Host,
  OPENCODE_VERSION_TIMEOUT_MS,
  OPENCODE_V2_NODE_FLOOR,
  opencodeProbeFailureMessage,
  parseOpencodeVersionOutput,
  type OpencodeGeneration,
} from "../host-health/opencode-v2.js";
import { compareSemver } from "../host-health/version-compare.js";

const doctorTargets = ["opencode", "cursor", "codex", "zcode", "omp", "dsh", "kimi"] as const;
const hostSignals = [
  "subagent_type", "question", "task_subagent", "task_agent_batch", "ask", "hub", "subagent", "spawn_teammate",
  "team_task_create", "Agent", "AgentSwarm", "AskUserQuestion", "EnterPlanMode", "TodoWrite", "plan_slash", "goal",
  "functions.*", "tool_search",
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
- Done: only @project-manager may set Done; implementers set InReview.
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

/**
 * The project root this invocation operates on: the workspace the CALLER named
 * (`context.cwd`), never the directory this process happens to run in. On an MCP
 * server the two differ exactly when the launcher declared a workspace
 * (`--workspace`, or a pinned root's parent), and resolving the process-global
 * project root there would answer about the host's checkout instead. The CLI's
 * `context.cwd` is the directory the operator ran from, so its behavior is
 * unchanged.
 */
function projectRootAt(workspace: string): string {
  return projectRootFrom(workspace);
}

function pluginRoot(explicit: string | undefined, workspace: string): string {
  if (explicit !== undefined) return resolveCliPath(explicit, workspace);
  let candidate = projectRootAt(workspace);
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
      // A host that ignores SIGTERM must not keep the doctor waiting past
      // the advertised bound: escalate straight to an unignorable kill.
      killSignal: "SIGKILL",
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

async function diagnose(target: (typeof doctorTargets)[number], scope: "global" | "project", generation: OpencodeGeneration | undefined, projectRoot: string): Promise<{ location: string; errors: string[]; notes: string[]; generations?: OpencodeGeneration[]; generationSource?: string }> {
  if (target === "opencode") {
    const root = scope === "global"
      ? path.join(os.homedir(), ".config", "opencode")
      : projectRoot;
    return diagnoseOpencodeTarget(root, generation);
  }
  if (target === "cursor") {
    const result = diagnoseCursorHost(scope, { project: projectInstallPath(projectRoot) });
    return { location: result.location, errors: result.errors, notes: [] };
  }
  if (target === "kimi") return diagnoseKimiHost();
  if (target === "zcode") {
    const result = diagnoseZcodeHost(scope, { projectRoot, harnessRepoPath });
    return { location: result.location, errors: result.errors, notes: [] };
  }
  if (target === "codex") {
    const result = diagnoseCodexHost(runBin("codex"), path.join(os.homedir(), ".agents", "plugins", "marketplace.json"));
    return { location: result.location, errors: [...localHarnessErrors(), ...result.errors], notes: result.notes };
  }
  if (target === "dsh") return diagnoseDshHost(runBin("dsh"));
  if (target === "omp" && scope === "project") {
    // omp has one user-wide plugin root (its link/listing ignore --scope), so a
    // project-scoped omp setup cannot exist: report that instead of reporting a
    // global listing as healthy.
    return {
      location: harnessRepoPath,
      errors: [
        "omp has no project-scoped plugin installation; run `npx @mstar-harness/cli doctor --target omp --scope global` instead",
      ],
      notes: [],
    };
  }
  let installed: Array<Record<string, unknown>> = [];
  let ompAvailable = true;
  try {
    installed = parseOmpPluginList(runBin("omp")(["plugin", "list", "--json"]));
  } catch {
    ompAvailable = false;
  }
  const result = diagnoseOmpHost({
    harnessRepoPath,
    scope,
    ompAvailable,
    installedPlugins: installed,
    localHarnessRepoErrors: localHarnessErrors(),
  });
  return { location: result.location, errors: result.errors, notes: [] };
}
function command<I>(id: string, definition: Omit<CommandDefinition<I, unknown>, "id" | "output">): CommandDefinition<I, unknown> {
  return { id, output: commandEnvelopeSchema, ...definition };
}

/**
 * Whether the start path is a different checkout of this repository.
 *
 * An unidentifiable start path (Git probe failed, so `startCheckout` is null)
 * counts as linked on purpose: the command then answers from the control root,
 * which is the only safe anchor. Loosening this predicate is the fail-open
 * regression the unit test beside it pins.
 */
export function linkedWorktreeOf(controlRoot: string | null, startCheckout: string | null): boolean {
  return controlRoot !== null && startCheckout !== controlRoot;
}

/** The shared control-root facts `path resolve` and `path check` answer from. */
type ControlFacts = {
  /** Harness dir probed from the start path (the local, worktree-local answer). */
  harnessDir: string | null;
  /** Git main worktree — the process root, `null` outside Git. */
  controlRoot: string | null;
  /** Harness dir of the control checkout, `null` when unreadable or absent. */
  controlHarnessDir: string | null;
  /** The start path belongs to a checkout other than the control root. */
  linkedWorktree: boolean;
  /** Envelope fields describing the control root. */
  control: Record<string, unknown>;
  /** A named cause when the control root cannot be read at all. */
  unavailable?: { code: "coordination.not-in-git" | "path.control-root-unreadable"; message: string };
};

/**
 * Resolve the control-root facts from `startDir`: the probed harness dir, the
 * Git main worktree, the control harness and whether `startDir` is a linked
 * checkout. A linked checkout whose main worktree is unreadable is data here,
 * not a failed lookup: the cause is returned so the caller refuses by name
 * instead of falling back to a local guess. Filesystem-availability errors
 * escape the same walk-up and must answer a named refusal too — but they are
 * not "not in git", so they carry their own code.
 */
function controlFacts(startDir: string): ControlFacts {
  const harnessDir = resolveHarnessDir(startDir, { localProbe: true });
  // The process root comes from Git only: the first `worktree list` record is
  // the main checkout, whatever the start path looks like.
  const controlRoot = readMainWorktree(startDir)?.root ?? null;
  let controlHarnessDir: string | null = null;
  let unavailable: ControlFacts["unavailable"];
  try {
    controlHarnessDir = resolveProcessHarnessDir(startDir);
  } catch (error) {
    const code = error instanceof CoordinationError ? error.code : (error as NodeJS.ErrnoException).code;
    if (code !== "coordination.not-in-git" && code !== "EACCES" && code !== "EPERM") throw error;
    unavailable = {
      code: code === "coordination.not-in-git" ? "coordination.not-in-git" : "path.control-root-unreadable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  // A plain subdirectory of the main checkout belongs to that worktree; a
  // nested `git worktree add` under it is a distinct checkout. Git's own
  // top-level for the start path decides this, not path prefixes.
  const linkedWorktree = linkedWorktreeOf(controlRoot, probeCheckoutRoot(startDir));
  return {
    harnessDir,
    controlRoot,
    controlHarnessDir,
    linkedWorktree,
    control: { controlRoot, controlHarnessDir, linkedWorktree, ...(unavailable === undefined ? {} : { controlUnavailable: unavailable.message }) },
    ...(unavailable === undefined ? {} : { unavailable }),
  };
}

/**
 * The harness that owns tracked results (`specs` / `knowledge` / `adr`) for a
 * checkout. Tracked results follow the branch the caller has checked out, so
 * this is the caller's own checkout — never the control harness, which owns
 * only gitignored process state. Mirrors the rule `path check` enforces.
 */
function trackedHarnessOf(checkoutRoot: string | null): string | null {
  if (checkoutRoot === null) return null;
  return resolveHarnessDir(checkoutRoot, { ignoreEnvOverride: true, localProbe: true }) ?? path.join(checkoutRoot, ".mstar");
}

/**
 * `path check` answer: no finding is the clean exit-0 envelope (warnings ride
 * along without failing it), every finding is one refusal carrying them all
 * (the operator sees every cause at once).
 */
function pathCheckEnvelope(
  command: string,
  data: Record<string, unknown>,
  findings: readonly PathOwnershipFinding[],
  warnings: readonly PathOwnershipWarning[],
): CommandEnvelope {
  const first = findings[0];
  if (first === undefined) return ok(command, { ...data, ok: true, findings: [], warnings });
  return refusalEnvelope({
    command,
    status: "refused",
    code: first.code,
    exitCode: 1,
    message: findings.map((finding) => finding.message).join("; "),
    details: { ...data, ok: false, findings, warnings },
    recovery: "Keep Git-ignored harness files in the control checkout and committable results in the checkout that carries your branch; if a result dir is ignored, write it under .agents/ or declare specs_dir / knowledge_dir / adr_dir in .mstarc. Run mstar path check.",
  });
}

export function getLocalCommandDefinitions(): readonly CommandDefinition[] {
  return [
    command("harness.scaffold", {
      cli: { path: ["harness", "scaffold"], aliases: [], arguments: [{ key: "path", required: false, variadic: false }], options: [] },
      input: z.object({ path: z.string().min(1).optional() }),
      effects: ["write"],
      description: "Create the harness directories and default project; then run mstar store init to activate execution authority.",
      async execute(input, context) {
        // A scaffold WRITES, so it may only land in a directory somebody named:
        // the explicit `path`, the declared workspace, or the pinned harness. On
        // a connection that declared no workspace the invocation directory is
        // the server's launch directory (the HOST's checkout), and the null-root
        // bootstrap exception does not make it a target.
        const unnamedRoot = launchDirectoryRefusal("harness.scaffold", context, {
          fields: [{ field: "path", subject: "the scaffold root", value: input.path }],
        });
        if (unnamedRoot !== undefined) return unnamedRoot;
        // An omitted path is the invocation workspace: a pinned server owns
        // that workspace, and the launch process cwd is not it. A pinned
        // server also names the exact harness dir, which the scaffold must
        // target verbatim: re-discovering it from the workspace would follow
        // MSTAR_HARNESS_DIR / .mstarc / the default `<workspace>/.mstar` and
        // scaffold a different root.
        const root = input.path === undefined ? context.cwd : resolveCliPath(input.path, context.cwd);
        const harnessPin = input.path === undefined ? context.harnessPin : undefined;
        const scaffoldOptions = harnessPin === undefined ? {} : { harnessDir: harnessPin };
        setArtifactStore(createFsStore(resolveScaffoldDirs(root, scaffoldOptions).harnessDir));
        const harnessDir = await scaffoldHarness(root, scaffoldOptions);
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
        // The project-scoped diagnosis reads the project around the invocation:
        // on a connection that declared no workspace that is the HOST's
        // checkout, so the report would describe a project the caller never
        // named. The GLOBAL scope needs no workspace (it reads the host
        // installation, which is this command's own subject), so only the
        // project half refuses. A declared workspace (`--workspace`, or a
        // pinned root's parent) anchors the resolution at `context.cwd`.
        const unnamedProject = input.scope === "project"
          ? launchDirectoryRefusal("doctor", context, { subject: "the project root this diagnosis reads" })
          : undefined;
        if (unnamedProject !== undefined) return unnamedProject;
        const projectRoot = projectRootAt(context.cwd);
        const result = await diagnose(input.target, input.scope, input.generation, projectRoot);
        // MCP configs are global by default; project-scoped OpenCode uses the
        // project's own opencode.json, while dsh composes rows in its profile.
        const projectOpencodeMcpPath = input.target === "opencode" && input.scope === "project"
          ? path.join(projectRoot, "opencode.json")
          : undefined;
        const resolvedGenerations = result.generations ?? [];
        // A dual-host config resolves to ["v1","v2"]; the V2 host in that set
        // still cannot read legacy flat MCP rows, so the V2 shape requirement
        // stays on whenever v2 is among the resolved generations.
        const resolvedGeneration = input.generation ?? (resolvedGenerations.length === 1 ? resolvedGenerations[0] : undefined);
        const v2AmongResolved = resolvedGenerations.includes("v2") || input.generation === "v2";
        const v1AmongResolved = resolvedGenerations.includes("v1") || input.generation === "v1";
        // Concrete, executable recovery commands for the OTHER scope's file.
        const otherScope = input.scope === "project" ? "global" : "project";
        const generationSuffix = input.generation ? ` --opencode-generation ${input.generation}` : "";
        const otherScopeDoctorCommand = `mstar doctor --target opencode --scope ${otherScope}${generationSuffix}`;
        const otherScopeInitCommand = `mstar init --target opencode --opencode-generation v2 --scope ${otherScope}`;
        const mcpHealth = input.target === "dsh"
          ? diagnoseMcpTarget("dsh", resolveDshProfileDir())
          : diagnoseMcpTarget(input.target, os.homedir(), undefined, {
            ...(projectOpencodeMcpPath === undefined ? {} : { configFilePath: projectOpencodeMcpPath }),
            ...(v2AmongResolved ? { requireNestedV2Shape: true } : {}),
            ...(v1AmongResolved ? { requireFlatV1Shape: true } : {}),
            otherScopeDoctorCommand,
            otherScopeInitCommand,
          });
        // The published V2 plugin runs in OpenCode's Node process and needs
        // node:sqlite (Node >= the floor this CLI declares) - INSTALL.md:70
        // promises doctor checks it. Probe the PATH node independently of the
        // doctor's own process runtime: that runtime is not the one a host
        // launch resolves. A layout that cannot resolve the floor says so
        // instead of passing silently.
        const pluginRuntimeErrors: string[] = [];
        const v2Floor = OPENCODE_V2_NODE_FLOOR;
        if (input.target === "opencode" && v2AmongResolved && v2Floor === null) {
          pluginRuntimeErrors.push(
            "OpenCode V2 plugin requires a Node with native node:sqlite, but this CLI resolves no declared floor " +
              "(its manifest declares no `engines.node`), so the PATH node was not checked. " +
              "Reinstall the CLI (`npm i -g @mstar-harness/cli`) so the manifest that declares the floor is reachable.",
          );
        } else if (input.target === "opencode" && v2AmongResolved && v2Floor !== null) {
          const nodeProbe = probePathNodeRuntime();
          if (nodeProbe.unverifiedCause !== null) {
            pluginRuntimeErrors.push(
              "OpenCode V2 plugin requires Node >=" + v2Floor + " on PATH (node:sqlite); " + nodeProbe.unverifiedCause + ".",
            );
          } else if (compareSemver(nodeProbe.version, v2Floor) < 0) {
            pluginRuntimeErrors.push(
              "OpenCode V2 plugin requires Node >=" + v2Floor + " (node:sqlite); the PATH node reports " + nodeProbe.version + ".",
            );
          }
        } else if (input.target === "opencode" && v2AmongResolved) {
          // The check cannot run without a declared floor; say so instead of
          // passing silently, and name the supported recovery.
          pluginRuntimeErrors.push(
            "OpenCode V2 plugin requires a Node with native node:sqlite, but this CLI resolves no declared floor " +
              "(its manifest declares no `engines.node`), so the PATH node was not checked. " +
              "Reinstall the CLI (`npm i -g @mstar-harness/cli`) so the manifest that declares the floor is reachable.",
          );
        }
        const errors = [...result.errors, ...mcpHealth.errors, ...pluginRuntimeErrors];
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
      async execute(input, context) {
        // An omitted root is the project around the invocation, which only
        // exists in a directory somebody named: on a connection that declared
        // no workspace it is the HOST's checkout, and validating the host's own
        // package as the caller's answer is a silent wrong answer.
        const unnamedRoot = launchDirectoryRefusal("plugin.validate", context, {
          fields: [{ field: "root", subject: "the plugin package", value: input.root }],
        });
        if (unnamedRoot !== undefined) return unnamedRoot;
        const root = pluginRoot(input.root, context.cwd);
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
      description: "Resolve harness, specs, knowledge, adr, workflow, project, and review directories from a start directory.",
      async execute(input, context) {
        // On a connection that declared no workspace the invocation directory is
        // the MCP server's LAUNCH directory (the host's checkout), which says
        // nothing about the caller's workspace: deriving harness/workflow/
        // project/review paths from it would answer about an unrelated project.
        // The start directory is then a required, absolute input.
        const unnamedStart = launchDirectoryRefusal("path.resolve", context, {
          fields: [{ field: "path", subject: "the start directory", value: input.path }],
        });
        if (unnamedStart !== undefined) return unnamedStart;
        const startDir = input.path === undefined ? context.cwd : resolveCliPath(input.path, context.cwd);
        // `controlRoot` is a HARNESS dir, not a workspace boundary; feeding it
        // as `workspaceRoot` makes the resolver refuse the very harness it
        // sits inside (the boundary contains the answer). Resolve from the
        // start directory alone, as the contract's canonical form does.
        const { harnessDir, controlRoot, controlHarnessDir, linkedWorktree, control, unavailable } = controlFacts(startDir);
        // A linked checkout whose main worktree cannot be read must not fall
        // back to local artifacts — misreporting the worktree's own directory
        // as the process root is the confusion this command exists to remove.
        if (unavailable !== undefined) {
          return refusalEnvelope({ command: "path.resolve", status: "refused", code: unavailable.code, exitCode: 1, message: `the checkout ${startDir} cannot read its control root`, details: {
            startDir, harnessDir: null, specsDir: null, workflowDir: null, projectDir: null, reviewDir: null, ...control, local: { harnessDir },
          } , recovery: "From the main worktree: run mstar status validate; or set MSTAR_HARNESS_DIR to the control harness root. Run mstar path resolve."});
        }
        if (linkedWorktree && controlRoot !== null) {
          // In a linked checkout the local probe is the worktree's own
          // directory (tracked plugin dirs, usually not a harness at all);
          // the process documents live at the control harness.
          if (controlHarnessDir === null) {
            return refusalEnvelope({ command: "path.resolve", status: "refused", code: "path.harness-not-found", exitCode: 1, message: `no control harness dir found for the linked checkout ${startDir} (control root ${controlRoot})`, details: {
              startDir, harnessDir: null, specsDir: null, workflowDir: null, projectDir: null, reviewDir: null, ...control, local: { harnessDir },
            } , recovery: "From the main worktree: run mstar harness scaffold; or set MSTAR_HARNESS_DIR to the control harness root. Run mstar path resolve."});
          }
          // Two owners: gitignored process state follows the control harness,
          // tracked results follow the checkout that carries the branch. The
          // `.mstarc` declaration is read from the main harness (single config
          // source) and applied to the caller checkout only where the path is
          // committable there — the rule `path check` enforces.
          const trackedBase = probeCheckoutRoot(startDir) ?? controlRoot;
          return ok("path.resolve", {
            startDir,
            // `harnessDir` stays the process root: a caller appending
            // `plans/` lands at the process documents. Tracked results are
            // answered explicitly below.
            harnessDir: controlHarnessDir,
            specsDir: resolveTrackedResultDir(trackedBase, controlHarnessDir, "specsDir"),
            knowledgeDir: resolveTrackedResultDir(trackedBase, controlHarnessDir, "knowledgeDir"),
            adrDir: resolveTrackedResultDir(trackedBase, controlHarnessDir, "adrDir"),
            workflowDir: resolveWorkflowDir(controlRoot),
            projectDir: resolveProjectDir(controlRoot),
            reviewDir: resolveReviewDir(controlRoot),
            ...control,
            local: {
              harnessDir,
              specsDir: harnessDir === null ? null : resolveSpecsDir(harnessDir, { create: false }),
              knowledgeDir: harnessDir === null ? null : resolveKnowledgeDir(harnessDir, { create: false }),
              adrDir: harnessDir === null ? null : resolveAdrDir(harnessDir, { create: false }),
              workflowDir: harnessDir === null ? null : resolveWorkflowDir(startDir),
              projectDir: harnessDir === null ? null : resolveProjectDir(startDir),
              reviewDir: harnessDir === null ? null : resolveReviewDir(startDir),
            },
          });
        }
        if (harnessDir === null) {
          return refusalEnvelope({ command: "path.resolve", status: "refused", code: "path.harness-not-found", exitCode: 1, message: `no harness dir found from ${startDir}${controlRoot === null ? "" : ` (control root ${controlRoot})`}`, details: {
            startDir, harnessDir: null, specsDir: null, workflowDir: null, projectDir: null, reviewDir: null, ...control,
          } , recovery: "Set the starting path to a directory inside an existing harness. Run mstar path resolve."});
        }
        return ok("path.resolve", {
          startDir,
          harnessDir,
          specsDir: resolveSpecsDir(harnessDir, { create: false }),
          knowledgeDir: resolveKnowledgeDir(harnessDir, { create: false }),
          adrDir: resolveAdrDir(harnessDir, { create: false }),
          workflowDir: resolveWorkflowDir(startDir),
          projectDir: resolveProjectDir(startDir),
          reviewDir: resolveReviewDir(startDir),
          ...control,
        });
      },
    }),
    command("path.check", {
      cli: { path: ["path", "check"], aliases: [], arguments: [{ key: "path", required: false, variadic: false }], options: [] },
      input: z.object({ path: z.string().min(1).optional() }),
      effects: ["read"],
      description: "Check harness file ownership from Git state: Git-ignored files must live in the control checkout, committable files in the caller's checkout; an ignored result dir is reported as a warning.",
      async execute(input, context) {
        // Same launch-directory rule as `path resolve`: an unnamed start path
        // would answer about the host's checkout instead of the caller's.
        const unnamedStart = launchDirectoryRefusal("path.check", context, {
          fields: [{ field: "path", subject: "the path to check", value: input.path }],
        });
        if (unnamedStart !== undefined) return unnamedStart;
        const startDir = input.path === undefined ? context.cwd : resolveCliPath(input.path, context.cwd);
        if (input.path !== undefined) {
          // The verdict comes from Git state; the resolved result dirs only
          // decide whether an ignored-but-legal path also earns the warning.
          // The anchor is the nearest existing directory — Git and the harness
          // probe both need a real path, and the target may not exist.
          const anchor = nearestExistingDir(startDir);
          const facts = controlFacts(anchor);
          const { controlRoot } = facts;
          const processHarness = facts.controlHarnessDir ?? facts.harnessDir;
          // The caller is the invoker, not the named target: a committable path
          // checked from a linked checkout that lives in the control checkout
          // belongs to the wrong checkout. Outside Git the target's own
          // checkout is the only identity available.
          const callerCheckoutRoot = probeCheckoutRoot(context.cwd) ?? probeCheckoutRoot(anchor);
          const trackedHarness = trackedHarnessOf(callerCheckoutRoot);
          const resultDirs =
            callerCheckoutRoot === null || processHarness === null
              ? []
              : [
                  resolveTrackedResultDir(callerCheckoutRoot, processHarness, "specsDir"),
                  resolveTrackedResultDir(callerCheckoutRoot, processHarness, "knowledgeDir"),
                  resolveTrackedResultDir(callerCheckoutRoot, processHarness, "adrDir"),
                ];
          const probe = probePathOwnership(
            { path: startDir, result: isResultPath(startDir, resultDirs), ...(input.path.endsWith("/") ? { kind: "directory" as const } : {}) },
            controlRoot,
            callerCheckoutRoot,
          );
          const warning = pathOwnershipWarning(probe);
          return pathCheckEnvelope(
            "path.check",
            { startDir, trackedHarness, controlRoot, callerCheckoutRoot, result: probe.result, ignored: probe.ignored, checkoutRoot: probe.checkoutRoot },
            probe.code === null ? [] : [probe],
            warning === null ? [] : [warning],
          );
        }
        const { harnessDir, controlRoot, controlHarnessDir, linkedWorktree, control, unavailable } = controlFacts(startDir);
        if (unavailable !== undefined) {
          return refusalEnvelope({ command: "path.check", status: "refused", code: unavailable.code, exitCode: 1, message: `the checkout ${startDir} cannot read its control root`, details: {
            startDir, ...control, checked: [],
          } , recovery: "From the main worktree: run mstar status validate; or set MSTAR_HARNESS_DIR to the control harness root. Run mstar path check."});
        }
        // The two domains have different owners. Ignored harness files live in
        // the control harness (unchanged by `path resolve`). Committable
        // results live in the CALLER's checkout: a linked worktree shares the
        // control harness for ignored state, but its results must be committed
        // from the branch it carries, so resolving them from the control
        // harness would check the wrong checkout and bless results the caller
        // never has.
        const processHarness = linkedWorktree && controlRoot !== null ? controlHarnessDir : harnessDir;
        if (processHarness === null) {
          return refusalEnvelope({ command: "path.check", status: "refused", code: "path.harness-not-found", exitCode: 1, message: `no harness dir found from ${startDir}${controlRoot === null ? "" : ` (control root ${controlRoot})`}`, details: {
            startDir, ...control, checked: [],
          } , recovery: "From the main worktree: run mstar harness scaffold; or set MSTAR_HARNESS_DIR to the control harness root. Run mstar path check."});
        }
        const callerCheckoutRoot = probeCheckoutRoot(startDir);
        // Without a probed harness the caller checkout still names a result
        // base; it is only a probe base — nothing is created there.
        const trackedHarness = trackedHarnessOf(callerCheckoutRoot);
        const specsDir = callerCheckoutRoot === null ? null : resolveTrackedResultDir(callerCheckoutRoot, processHarness, "specsDir");
        const knowledgeDir = callerCheckoutRoot === null ? null : resolveTrackedResultDir(callerCheckoutRoot, processHarness, "knowledgeDir");
        const adrDir = callerCheckoutRoot === null ? null : resolveTrackedResultDir(callerCheckoutRoot, processHarness, "adrDir");
        const targets: PathOwnershipTarget[] = [
          // The result marking only adds the ignored-result warning.
          ...[specsDir, knowledgeDir, adrDir].flatMap((dir) => (dir === null ? [] : [{ path: dir, result: true }])),
          { path: resolvePlanDir(processHarness) },
          // The per-plan join makes `dirname` the SDD base, declaration included.
          { path: path.dirname(resolveSddDir(processHarness, "path-check")) },
          { path: resolveIterationDir(processHarness) },
          { path: resolveWorkflowDir(processHarness, { harnessDir: processHarness }) },
          { path: resolveProjectDir(processHarness, { harnessDir: processHarness }) },
          { path: resolveReviewDir(processHarness, { harnessDir: processHarness }) },
        ].map((target) => ({ ...target, kind: "directory" as const }));
        // The execution store is a file at the harness root.
        targets.push({ path: path.join(processHarness, "store.db"), kind: "file" });
        const check = checkPathOwnership(targets, controlRoot, callerCheckoutRoot);
        return pathCheckEnvelope(
          "path.check",
          {
            startDir,
            controlRoot,
            callerCheckoutRoot,
            linkedWorktree,
            trackedHarness,
            processHarness,
            specsDir,
            knowledgeDir,
            adrDir,
            checked: targets,
          },
          check.findings,
          check.warnings,
        );
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
