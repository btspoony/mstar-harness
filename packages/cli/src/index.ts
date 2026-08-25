#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { select } from "@inquirer/prompts";
import pc from "picocolors";
import { Command } from "commander";
import {
  assertDefaultBranchProtected,
  assertIndexRows,
  assertLightDarkParity,
  assertQcAlignment,
  assertSddTddTriple,
  assertTriIdentity,
  AUDIT_CATEGORIES,
  AUDIT_EFFORTS,
  AUDIT_PRIORITIES,
  AUDIT_RISKS,
  completenessLevel,
  detectHarnessKind,
  detectHost,
  emitGitignoreSnippet,
  evaluatePhaseGate,
  executionModeToN,
  findEphemeralCitations,
  findSimplifyMarkers,
  findTemporaryMarkers,
  findingsCleanupGate,
  isReadOnlyAssignmentRole,
  l1PreDispatchCheck,
  l2PreDispatchCheck,
  lintFiveQuestion,
  lintFrontmatter,
  lintLoadOrder,
  lintStrategySections,
  parseAssignmentBranchForms,
  parseAssignmentFields,
  parseBranchPolicyDirectOnBranch,
  parseCompassFrontmatter,
  planQualityBar,
  PROJECT_REGISTER_FILE,
  promoteAuditPlans,
  pushCadenceProbe,
  resolveHarnessDir,
  resolveProjectDir,
  resolveSkillRoot,
  resolveSpecsDir,
  resolveWorkflowDir,
  reviewPackage,
  scaffoldAuditPlan,
  scaffoldHarness,
  scopeGuard,
  SddScriptError,
  sddWorkspace,
  stripFrontmatter,
  taskBrief,
  techDebtRollup,
  validateAssignmentFields,
  validateDesignTokenFrontmatter,
  validateIntegrationMergeLease,
  validateRoleMapping,
  validateSchemaYaml,
  validateStatus,
  validateWorkflowSnapshot,
  WORKFLOW_SNAPSHOT_FILE,
  _DEFAULT_PROJECT,
  type AuditCategory,
  type AuditEffort,
  type AuditFinding,
  type AuditPriority,
  type AuditRisk,
  type FiveQuestionMode,
  type GateResult,
  type HostId,
  type L1PreDispatchInput,
  type ProjectRegisterDoc,
  type QcAlignmentAssignment,
  type ToolSignal,
  type ValidationResult,
  type WorktreeTrack,
} from "@mstar-harness/engine";
import { verifyPlanExecutionLease } from "./lease-verify";
import { runMigrateCommand, type MigrateCliOptions } from "./commands/migrate";
import { validateAgentPlugin } from "./agent-plugins";
import { buildModelAssignments } from "./assignment";
import { getAdapter } from "./adapters";
import type { DoctorOptions, InitOptions, PluginValidateOptions, Target } from "./types";
import { SUPPORTED_TARGETS } from "./types";
import { parseCsv, readJson, writeJson, readHarnessVersion, resolveCliPath, resolveProjectRoot } from "./utils";

const packageVersion = readHarnessVersion();

const program = new Command();

function logStep(message: string) {
  console.log(pc.cyan(message));
}

async function pickTargetInteractive() {
  return select<Target>({
    message: "Select install target",
    choices: SUPPORTED_TARGETS.map((target) => ({ name: target, value: target })),
  });
}

function hasExplicitModelFlags(options: InitOptions): boolean {
  return Boolean(
    options.pmModel ||
      options.strategicModels ||
      options.devModels ||
      options.qcModels ||
      options.otherModels,
  );
}

/** Advanced override only — never calls `opencode models` (avoids silent hangs). */
function resolveExplicitModelAssignments(options: InitOptions) {
  // Trust caller-supplied ids; do not discover/validate against a live model list.
  const allow = (label: string, values: string[] | undefined, max: number, required: boolean) => {
    if (!values?.length) {
      if (required) throw new Error(`${label} is required when any --*-model flag is set.`);
      return [] as string[];
    }
    if (values.length > max) throw new Error(`${label}: pick at most ${max} model(s).`);
    return values;
  };

  return buildModelAssignments({
    pm: allow("pm-model", options.pmModel ? [options.pmModel] : undefined, 1, true),
    strategic: allow("strategic-models", parseCsv(options.strategicModels), 3, true),
    dev: allow("dev-models", parseCsv(options.devModels), 3, true),
    qc: allow("qc-models", parseCsv(options.qcModels), 3, true),
    others: allow("other-models", parseCsv(options.otherModels), 3, true),
  });
}

async function runInit(options: InitOptions) {
  const target = options.target || (options.yes ? "opencode" : await pickTargetInteractive());
  const scope = options.scope || "project";
  const adapter = getAdapter(target);

  if (!options.scope && !options.yes) {
    console.log(pc.dim("Scope not provided; defaulting to project."));
  }

  if (adapter.mode === "install") {
    logStep("Step 2/2 - Run target install flow");
    const installResult = adapter.runInstallInit?.(scope, !!options.dryRun, { noFallbacks: options.noFallbacks });
    if (!installResult) {
      throw new Error(`Adapter ${target} does not implement install init flow.`);
    }
    console.log(pc.green(`Status: ${options.dryRun ? "ready (dry-run)" : "configured"} (${scope})`));
    console.log(`Target: ${target}`);
    console.log(`Install location: ${installResult.location}`);
    for (const note of installResult.notes) {
      console.log(`  - ${note}`);
    }
    return;
  }

  // OpenCode (and any future config-mode targets): default = schema + plugin only.
  // Skip interactive model picking and `opencode models` discovery (can hang with no output).
  const useExplicitModels = hasExplicitModelFlags(options);
  const assignments = useExplicitModels ? resolveExplicitModelAssignments(options) : {};

  if (useExplicitModels) {
    logStep("Step 3/4 - Apply explicit role model overrides from CLI flags");
  } else {
    logStep("Step 3/4 - Fast setup (schema + plugin; OpenCode default models)");
  }

  logStep("Step 4/4 - Update config");
  const configPath = adapter.resolveConfigPath?.(scope, options.output);
  if (!configPath) throw new Error(`Adapter ${target} does not implement config path resolution.`);
  const current = readJson(configPath);
  const updated = adapter.mutateConfigForInit?.(current, assignments);
  if (!updated) throw new Error(`Adapter ${target} does not implement init mutation.`);

  const checkErrors = adapter.validateConfig?.(updated) || [];
  if (checkErrors.length) {
    throw new Error(`Configuration verification failed:\n- ${checkErrors.join("\n- ")}`);
  }

  if (!options.dryRun) {
    writeJson(configPath, updated);
    const persistedErrors = adapter.validateConfig?.(readJson(configPath)) || [];
    if (persistedErrors.length) {
      throw new Error(`Post-write verification failed:\n- ${persistedErrors.join("\n- ")}`);
    }
  }

  console.log(pc.green(`Status: ${options.dryRun ? "ready (dry-run)" : "configured"} (${scope})`));
  console.log(`Target: ${target}`);
  console.log(`Config file: ${configPath}`);
  if (adapter.printPostSetupSummary) adapter.printPostSetupSummary(updated);
  if (Object.keys(assignments).length) {
    console.log("Assigned roles:");
    for (const [roleId, modelId] of Object.entries(assignments)) {
      console.log(`  - ${roleId}: ${modelId}`);
    }
  }
}

function runDoctor(options: DoctorOptions) {
  const target = options.target || "opencode";
  const adapter = getAdapter(target);
  const scope = options.scope || "project";
  console.log(`Target: ${target}`);

  if (adapter.mode === "install") {
    const result = adapter.runInstallDoctor?.(scope);
    if (!result) {
      throw new Error(`Adapter ${target} does not implement install doctor flow.`);
    }
    console.log(`Install location: ${result.location}`);
    // Capability word lines (install-mode doctor notes, e.g. dsh
    // uninstalled/disabled/mounted) print on every run, healthy included —
    // a `mounted` state must not be implied only by exit code 0 (AC-2).
    for (const note of result.notes ?? []) {
      console.log(`  - ${note}`);
    }
    if (!result.errors.length) {
      console.log(pc.green("Doctor result: healthy"));
      return;
    }
    console.log(pc.red(`Doctor result: ${result.errors.length} issue(s)`));
    for (const issue of result.errors) console.log(`  - ${issue}`);
    process.exitCode = 1;
    return;
  }

  const configPath = adapter.resolveConfigPath?.(scope, options.output);
  if (!configPath) {
    throw new Error(`Adapter ${target} does not implement config doctor flow.`);
  }
  const config = readJson(configPath);
  const errors = adapter.validateConfig?.(config) || [];
  console.log(`Config file: ${configPath}`);
  if (!errors.length) {
    const warnings = adapter.getDoctorWarnings?.(config) || [];
    if (warnings.length) {
      console.log(pc.yellow(`Doctor: ${warnings.length} recommendation(s) (still healthy):`));
      for (const line of warnings) console.log(`  - ${line}`);
    }
    console.log(pc.green("Doctor result: healthy"));
    return;
  }
  console.log(pc.red(`Doctor result: ${errors.length} issue(s)`));
  for (const issue of errors) console.log(`  - ${issue}`);
  process.exitCode = 1;
}

/**
 * Resolve the plugin root for `plugin validate`: explicit `--root` wins;
 * otherwise start from `resolveProjectRoot()` and walk up to the nearest
 * ancestor containing `plugin.json` (bun run --cwd rewrites PWD, so the
 * project root is not always the resolved cwd).
 */
function resolvePluginRoot(options: PluginValidateOptions): string {
  if (options.root) return path.resolve(options.root);
  let candidate = resolveProjectRoot();
  while (!fs.existsSync(path.join(candidate, "plugin.json"))) {
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return candidate;
}

function runPluginValidate(options: PluginValidateOptions) {
  const root = resolvePluginRoot(options);
  const result = validateAgentPlugin(root);
  for (const warning of result.warnings) {
    console.warn(pc.yellow(warning));
  }
  if (result.ok) {
    console.log(pc.green(`OK ${root}: Agent Plugins v1.0.0 conformant`));
    return;
  }
  for (const error of result.errors) {
    console.error(pc.red(error));
  }
  process.exitCode = 1;
}
/** Minimal `.mstar/AGENTS.md` harness-layer rules template (tracked result). */
const HARNESS_AGENTS_TEMPLATE = `# AGENTS.md \u2014 .mstar/ (harness layer)

- Path symbols: {HARNESS_DIR} = .mstar/; {PLAN_DIR} = plans/; {SDD_DIR} = sdd/<plan-id>/;
  {ITERATION_DIR} = iterations/; {KNOWLEDGE_DIR} = knowledge/; {SPECS_DIR} = specs/;
  {WORKFLOW_DIR} = workflows/; {PROJECT_DIR} = projects/ (SSOT: skills/mstar-conventions).
- Process vs results: process artifacts (plans/, iterations/, sdd/, status.json, workflows/,
  projects/) stay local and gitignored; results (this file, knowledge/, specs/) are tracked
  and shared across clones.
- Done: only @project-manager or @qa-engineer may set Done; implementers set InReview.
`;

/**
 * Run `mstar harness scaffold [path]`: one-shot harness bootstrap — engine
 * `scaffoldHarness` (dirs + v2 status.json + projects/_default/ under the
 * resolved harness/project dirs; `.mstarc` `harness_dir` / `project_dir`
 * honored), the canonical `.gitignore` snippet appended when absent (only
 * for the default `.mstar/` layout — custom harness layouts manage their
 * own ignore rules), and a minimal {HARNESS_DIR}/AGENTS.md harness-layer
 * rules template when absent. Prints the resolved harness/project dirs plus
 * a created/skipped summary. Idempotent: re-running on an initialized tree
 * is a no-op except creating missing pieces. Ordering is normalized as the
 * final step of the gitignore routine: a misplaced `.mstar/**` (after
 * `!.mstar/…` re-includes, which gitignore's last-match-wins would shadow)
 * is relocated before the first re-include — whether the fence was complete
 * or just appended.
 */
function runScaffold(pathArg: string | undefined) {
  const root = pathArg ? path.resolve(pathArg) : process.cwd();
  const harnessDir = scaffoldHarness(root);
  const projectDir = resolveProjectDir(root, { harnessDir });
  const created: string[] = [];
  const skipped: string[] = [];

  // Canonical .gitignore snippet (plan-conventions § Git 跟踪策略): the
  // snippet literals are `.mstar/**`-based, so the append only makes sense
  // for the default `.mstar/` layout. Custom harness layouts (`.mstarc`
  // harness_dir, legacy `.agents/`) manage their own ignore rules and are
  // skipped with an explicit note.
  const harnessKind = detectHarnessKind(harnessDir);
  if (harnessKind === "mstar") {
    const gitignorePath = path.join(root, ".gitignore");
    const snippet = emitGitignoreSnippet("mstar");
    const current = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
    const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
    const snippetLines = snippet.split("\n").map((line) => line.trim());
    const fenceEntries = snippetLines.filter(
      (line) => line.startsWith(".mstar/") || line.startsWith("!.mstar/") || line.startsWith(".mstarc"),
    );
    const commentLines = snippetLines.filter((line) => line.startsWith("#"));
    const missing = fenceEntries.filter((entry) => !lines.has(entry));
    if (missing.length > 0) {
      const missingComments = commentLines.filter((line) => !lines.has(line));
      const broadRule = ".mstar/**";
      const currentLines = current.split(/\r?\n/);
      const firstNegation = currentLines.findIndex((line) => line.trim().startsWith("!.mstar/"));
      if (!lines.has(broadRule) && firstNegation !== -1) {
        // gitignore = last matching pattern wins: appending `.mstar/**`
        // after existing `!.mstar/…` re-includes would shadow them. Splice
        // the canonical block start (comments + broad rule + missing
        // re-includes) BEFORE the first negation so the re-includes stay
        // effective. `.mstarc` is a plain ignore (no negations) — appended
        // at the end when missing.
        const blockStart = [...missingComments, broadRule, ...missing.filter((entry) => entry.startsWith("!.mstar/"))];
        currentLines.splice(firstNegation, 0, ...blockStart);
        let next = currentLines.join("\n");
        if (missing.includes(".mstarc")) next = `${next}${next.endsWith("\n") ? "" : "\n"}.mstarc\n`;
        fs.writeFileSync(gitignorePath, next, "utf8");
      } else {
        // Broad rule present (append missing entries after it) or no
        // negations to shadow (append the whole block) — both safe.
        const prefix = current && !current.endsWith("\n") ? "\n" : "";
        fs.appendFileSync(gitignorePath, `${prefix}${[...missingComments, ...missing].join("\n")}\n`, "utf8");
      }
      created.push(".gitignore (canonical harness snippet)");
    }

    // Unconditional final normalization — gitignore is last-match-wins, so a
    // misplaced `.mstar/**` (appearing after one or more `!.mstar/…`
    // re-includes, whether pre-existing or just appended) would shadow them.
    // Keep exactly ONE broad rule (the earliest occurrence), drop any
    // trailing duplicates, and relocate the kept rule to sit immediately
    // before the first re-include; every other line stays byte-for-byte.
    // Runs after EVERY branch above.
    const finalLines = fs.readFileSync(gitignorePath, "utf8").split(/\r?\n/);
    const broadIndexes = finalLines
      .map((line, index) => (line.trim() === ".mstar/**" ? index : -1))
      .filter((index) => index !== -1);
    const firstNegationIndex = finalLines.findIndex((line) => line.trim().startsWith("!.mstar/"));
    let normalized = false;
    if (broadIndexes.length > 0) {
      // Drop every duplicate `.mstar/**` after the earliest occurrence.
      for (let i = broadIndexes.length - 1; i > 0; i--) {
        finalLines.splice(broadIndexes[i], 1);
        normalized = true;
      }
      const keptIndex = finalLines.findIndex((line) => line.trim() === ".mstar/**");
      if (firstNegationIndex !== -1 && keptIndex !== firstNegationIndex - 1) {
        const [broadLine] = finalLines.splice(keptIndex, 1);
        const negationNow = finalLines.findIndex((line) => line.trim().startsWith("!.mstar/"));
        finalLines.splice(negationNow, 0, broadLine);
        normalized = true;
      }
    }
    if (normalized) {
      fs.writeFileSync(gitignorePath, finalLines.join("\n"), "utf8");
      created.push(".gitignore (canonical harness snippet reordered)");
    } else if (missing.length === 0) {
      skipped.push(".gitignore (canonical harness snippet already present)");
    }
  } else {
    skipped.push(".gitignore (canonical harness snippet) — custom harness layout manages its own ignore rules");
  }

  // Minimal {HARNESS_DIR}/AGENTS.md harness-layer rules (tracked result).
  const agentsPath = path.join(harnessDir, "AGENTS.md");
  const agentsLabel = `${path.basename(harnessDir)}/AGENTS.md`;
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, HARNESS_AGENTS_TEMPLATE, "utf8");
    created.push(agentsLabel);
  } else {
    skipped.push(`${agentsLabel} (already present)`);
  }

  // Headline is created-count-aware: "initialized" only when something was
  // created; a no-op re-run on an already-initialized tree says "ensured".
  const headline =
    created.length > 0
      ? `scaffold: harness initialized at ${harnessDir}`
      : `scaffold: harness ensured at ${harnessDir}`;
  console.log(pc.green(headline));
  console.log(`  harness dir: ${harnessDir}`);
  console.log(`  project dir: ${projectDir}`);
  for (const item of created) console.log(`  created: ${item}`);
  for (const item of skipped) console.log(`  skipped: ${item}`);
}

program
  .name("mstar-harness")
  .description("Morning Star harness CLI for target-based agent bootstrap")
  .version(packageVersion);

program
  .command("init")
  .description("Interactive/non-interactive setup for target agent bootstrap")
  .option("-y, --yes", "Non-interactive mode")
  .option("--target <target>", "Install target", "opencode")
  .option("--scope <scope>", "Config scope: global|project (default: project)")
  .option("--output <path>", "Config file path override, relative to project root")
  .option("--dry-run", "Preview result without writing config")
  .option("--no-fallbacks", "Skip installing the dsh-llm-fallbacks plugin (dsh target only)")
  .option("--pm-model <model>", "Optional: model for project-manager (advanced override)")
  .option("--strategic-models <a,b,c>", "Optional: models for architect/product-manager/prompt-engineer")
  .option("--dev-models <a,b,c>", "Optional: models for fullstack-dev/fullstack-dev-2/frontend-dev")
  .option("--qc-models <a,b,c>", "Optional: models for qc trio")
  .option("--other-models <a,b,c>", "Optional: models for remaining roles")
  .action(async (options: InitOptions & { fallbacks?: boolean }) => {
    // commander's negation `--no-fallbacks` parses as `fallbacks: false`
    // (default true); map to the canonical `noFallbacks` name at the boundary.
    await runInit({ ...options, noFallbacks: options.fallbacks === false });
  });

const harnessCommand = program
  .command("harness")
  .description("harness bootstrap / dir-resolution helpers (engine-backed)");

harnessCommand
  .command("scaffold")
  .description(
    "One-shot harness bootstrap: create the harness dir (default .mstar/, honoring .mstarc harness_dir/project_dir) " +
      "with dirs + v2 status.json + projects/_default/, append the canonical .gitignore snippet when absent " +
      "(skipped for non-.mstar layouts), and write a minimal {HARNESS_DIR}/AGENTS.md when absent",
  )
  .argument("[path]", "Root to scaffold (default: cwd)")
  .action((pathArg?: string) => {
    runScaffold(pathArg);
  });

program
  .command("doctor")
  .description("Validate Morning Star setup for a target agent config")
  .option("--target <target>", "Target agent for doctor checks", "opencode")
  .option("--scope <scope>", "Config scope: global|project", "project")
  .option("--output <path>", "Config file path override, relative to project root")
  .action((options: DoctorOptions) => {
    runDoctor(options);
  });

const pluginCommand = program
  .command("plugin")
  .description("Agent Plugins v1.0.0 portable package commands");

pluginCommand
  .command("validate")
  .description("Validate a plugin package against Agent Plugins v1.0.0")
  .option("--root <path>", "Plugin root directory to validate (default: project root)")
  .action((options: PluginValidateOptions) => {
    runPluginValidate(options);
  });

const pathCommand = program
  .command("path")
  .description("harness/specs dir resolution checks (engine-backed)");

pathCommand
  .command("resolve")
  .description(
    "Resolve {HARNESS_DIR} + {SPECS_DIR} + {WORKFLOW_DIR} + {PROJECT_DIR} from a start dir (exit 1 when no harness dir resolves)",
  )
  .argument("[path]", "Start dir to resolve from (default: cwd)")
  .option("--json", "Machine-readable JSON output (ok, harnessDir, specsDir, workflowDir, projectDir, guidance on failure)")
  .action((pathArg: string | undefined, options: { json?: boolean }) => {
    const startDir = pathArg ? path.resolve(pathArg) : process.cwd();
    const harnessDir = resolveHarnessDir(startDir);
    if (!harnessDir) {
      // plan-conventions § {HARNESS_DIR} 解析顺序: no .mstar/ → .agents/ →
      // .plans/|plans/ anywhere up the tree — harness not enabled from here.
      const guidance =
        "no harness dir found \u2014 the bounded probe (.mstar/, .agents/, .plans/, plans/) walked up from " +
        `${startDir} only within the workspace root (git top-level of the start dir; non-git start probes only itself) \u2014 run \`mstar harness scaffold\` to bootstrap, or pass a start dir inside a harness-enabled project`;
      if (options.json) {
        console.log(JSON.stringify({ ok: false, startDir, harnessDir: null, specsDir: null, workflowDir: null, projectDir: null, guidance }));
      } else {
        console.error(pc.red(`path resolve: no harness dir from ${startDir}`));
        console.error(`  guidance: ${guidance}`);
      }
      process.exitCode = 1;
      return;
    }
    // Read-only resolution: never create {HARNESS_DIR}/specs/ as a side
    // effect (engine resolveSpecsDir opts.create defaults to true).
    const specsDir = resolveSpecsDir(harnessDir, { create: false });
    const workflowDir = resolveWorkflowDir(startDir);
    const projectDir = resolveProjectDir(startDir);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, startDir, harnessDir, specsDir, workflowDir, projectDir }));
    } else {
      console.log(pc.green(`harness dir: ${harnessDir}`));
      console.log(pc.green(`specs dir:   ${specsDir}`));
      console.log(pc.green(`workflow dir: ${workflowDir}`));
      console.log(pc.green(`project dir:  ${projectDir}`));
    }
  });

const statusCommand = program
  .command("status")
  .description("v2 status.json root / workflow snapshot / project-register checks (engine-backed)");

/** Resolve the status.json path: explicit arg wins, else the resolved {HARNESS_DIR}. */
function resolveStatusFilePath(pathArg?: string): string {
  if (pathArg) return path.resolve(pathArg);
  const harnessDir = resolveHarnessDir();
  if (!harnessDir) {
    throw new Error(`harness dir not found from ${process.cwd()} \u2014 pass a status.json path or set MSTAR_HARNESS_DIR`);
  }
  return path.join(harnessDir, "status.json");
}

statusCommand
  .command("validate")
  .description(
    "Validate a v2 status.json root or workflow snapshot (root: version 2 + updated_at + active workflows[] with per-entry snapshot invariants; snapshot: schema_version 1 + plan rows + lease shapes; v1 input fails closed with the mstar migrate hint)",
  )
  .argument("[path]", "status.json or workflows/<id>/snapshot.json path (default: {HARNESS_DIR}/status.json)")
  .action((pathArg?: string) => {
    let statusPath: string;
    try {
      statusPath = resolveStatusFilePath(pathArg);
      if (!fs.existsSync(statusPath)) {
        throw new Error(`status file not found: ${statusPath}`);
      }
      const gate =
        path.basename(statusPath) === WORKFLOW_SNAPSHOT_FILE
          ? validateWorkflowSnapshot(readJson(statusPath))
          : validateStatus(statusPath);
      if (gate.ok) {
        console.log(pc.green(`${statusPath}: OK`));
        return;
      }
      const count = gate.violations.length;
      console.error(pc.red(`${statusPath}: FAIL (${count} violation${count === 1 ? "" : "s"})`));
      for (const violation of gate.violations) {
        console.error(`  - [${violation.severity}] ${violation.code}: ${violation.message}`);
        if (violation.fix) console.error(`    fix: ${violation.fix}`);
      }
      process.exitCode = 1;
    } catch (error) {
      console.error(pc.red(`status validate failed: ${(error as Error).message}`));
      process.exitCode = 1;
    }
  });

statusCommand
  .command("tech-debt")
  .description(
    "Print the residual tech-debt rollup aggregated over every {PROJECT_DIR}/<id>/residuals.json register " +
      "(total_open / by_severity / by_target / by_plan; the project register is the source of truth \u2014 " +
      "no stored-summary drift check, informational exit 0)",
  )
  .argument("[path]", "Project dir (default: resolved {PROJECT_DIR})")
  .action((pathArg?: string) => {
    try {
      const projectDir = pathArg ? path.resolve(pathArg) : resolveProjectDir();
      if (!fs.existsSync(projectDir)) {
        throw new Error(`project dir not found: ${projectDir}`);
      }
      const rollup = techDebtRollup(projectDir);
      console.log(`status tech-debt: ${projectDir}`);
      console.log(`total_open: ${rollup.computed.total_open}`);
      console.log(`by_severity: ${JSON.stringify(rollup.computed.by_severity)}`);
      console.log(`by_target: ${JSON.stringify(rollup.computed.by_target)}`);
      console.log(`by_plan: ${JSON.stringify(rollup.computed.by_plan)}`);
      console.log(pc.green("project register is the source of truth \u2014 no stored summary to drift (informational)"));
    } catch (error) {
      console.error(pc.red(`status tech-debt failed: ${(error as Error).message}`));
      process.exitCode = 1;
    }
  });

statusCommand
  .command("findings-cleanup")
  .description(
    "Enforce a plan's findings-cleanup mode on its project-register residuals (projects/<id>/residuals.json " +
      "entries keyed by plan id \u2014 the snapshot plan linkage; zero-residual via Assignment, else allow-residual; exit 1 on violations)",
  )
  .argument("<plan-id>", "Plan id whose register entries are checked against the cleanup mode")
  .option("--harness <path>", "Harness dir override (default: resolved {HARNESS_DIR})")
  .option("--project <id>", "Project id whose register is read (default: _default)")
  .option("--mode <mode>", "Cleanup mode override: zero-residual | allow-residual (default: allow-residual)")
  .action((planId: string, options: { harness?: string; project?: string; mode?: string }) => {
    try {
      const projectDir = resolveProjectDir(process.cwd(), options.harness ? { harnessDir: options.harness } : {});
      const registerPath = path.join(projectDir, options.project ?? _DEFAULT_PROJECT, PROJECT_REGISTER_FILE);
      if (!fs.existsSync(registerPath)) {
        throw new Error(`project register not found: ${registerPath}`);
      }
      const mode =
        options.mode === "zero-residual" || options.mode === "allow-residual" ? options.mode : undefined;
      if (options.mode !== undefined && mode === undefined) {
        throw new Error(`invalid --mode ${options.mode} (zero-residual | allow-residual)`);
      }
      const register = readJson(registerPath) as ProjectRegisterDoc;
      const gate = findingsCleanupGate(register, planId, mode ? { mode } : undefined);
      if (gate.ok) {
        console.log(pc.green(`findings-cleanup ${planId}: OK`));
        return;
      }
      printChecklist(`findings-cleanup ${planId}`, gate);
      process.exitCode = 1;
    } catch (error) {
      console.error(pc.red(`status findings-cleanup failed: ${(error as Error).message}`));
      process.exitCode = 1;
    }
  });

statusCommand
  .command("archive-residuals")
  .description(
    "Removed in v3 \u2014 residual close is a project-register state change; this command exits 1 and names the replacement",
  )
  .action(() => {
    console.error(
      pc.red(
        "status archive-residuals: removed in v3 \u2014 residuals live in project registers; close entries in " +
          "projects/<id>/residuals.json (set lifecycle to resolved/waived/superseded with closure fields) instead",
      ),
    );
    process.exitCode = 1;
  });

const migrateCommand = program
  .command("migrate")
  .description(
    "Migrate a v1 {HARNESS_DIR} status.json tree to v2 (engine-backed; exit 0 ok/idempotent no-op, 1 plan-invalid, 2 apply-failure)",
  )
  .option("--dry-run", "Print the migration step plan (source \u2192 destination) + planned-document validation warnings without writing anything")
  .option("--path <root>", "Harness root to migrate (default: resolved {HARNESS_DIR}, else cwd)")
  .option("--json", "Machine-readable JSON output")
  .action(async (options: MigrateCliOptions) => {
    await runMigrateCommand(options);
  });

const leaseCommand = program
  .command("lease")
  .description("execution_lease / integration_merge_lease checks (engine-backed)");

/** Resolve the harness dir for lease commands: --harness wins, else {HARNESS_DIR} resolution. */
function resolveLeaseHarnessDir(harnessArg?: string): string {
  if (harnessArg) return path.resolve(harnessArg);
  const harnessDir = resolveHarnessDir();
  if (!harnessDir) {
    throw new Error(`harness dir not found from ${process.cwd()} \u2014 pass --harness or set MSTAR_HARNESS_DIR`);
  }
  return harnessDir;
}

/**
 * Resolve `{WORKFLOW_DIR}/<id>/snapshot.json` for the v2 `--workflow <id>`
 * inputs (lease verify / verify-integration / iteration gate / worktree
 * check). The id is a single path component — reject separators and `..`
 * so a hostile id cannot escape the workflows dir. The workflow dir comes
 * from the engine resolver (Phase-5 F1): a `.mstarc` `[config]
 * workflow_dir` declaration wins, else `{HARNESS_DIR}/workflows` — so a
 * custom layout is READ at the same location it is written.
 */
function resolveSnapshotPath(workflowId: string, harnessArg?: string): string {
  if (workflowId === "" || workflowId === "." || workflowId === ".." || workflowId.includes("/") || workflowId.includes("\\")) {
    throw new Error(`invalid workflow id ${JSON.stringify(workflowId)}`);
  }
  const harnessDir = resolveLeaseHarnessDir(harnessArg);
  const workflowDir = resolveWorkflowDir(harnessDir, { harnessDir });
  return path.join(workflowDir, workflowId, WORKFLOW_SNAPSHOT_FILE);
}

/** The sole plan row of a workflow snapshot, or null when ambiguous/absent. */
function solePlanRow(
  plans: Array<Record<string, unknown>>,
  label: string,
): { row: Record<string, unknown> } | { error: Error } {
  if (plans.length === 0) {
    return { error: new Error(`${label}: workflow snapshot has no plan rows \u2014 pass --plan <plan-id>`) };
  }
  if (plans.length > 1) {
    return { error: new Error(`${label}: workflow snapshot has ${plans.length} plan rows \u2014 pass --plan <plan-id> to pick one`) };
  }
  return { row: plans[0]! };
}

/**
 * Run the engine execution-lease gate on one snapshot plan row and print the
 * verdict (SSOT rules live in lease-verify.ts / the engine — row-level
 * `plans[].execution_lease` is the only location in v3; metadata-only and
 * dual-write were deleted with the v1 read path).
 */
function verifyLeaseRow(row: Record<string, unknown>, planId: string, snapshotPath: string): void {
  const result = verifyPlanExecutionLease(row, planId);
  if (result.ok) {
    const holder = String((result.lease as Record<string, unknown>).holder ?? "");
    console.log(pc.green(`${snapshotPath}: OK plan ${planId} \u2014 execution_lease valid (holder ${holder})`));
    return;
  }
  const count = result.violations.length;
  console.error(pc.red(`${snapshotPath}: FAIL plan ${planId} (${count} violation${count === 1 ? "" : "s"})`));
  for (const violation of result.violations) {
    console.error(`  - [${violation.severity}] ${violation.code}: ${violation.message}`);
    if (violation.fix) console.error(`    fix: ${violation.fix}`);
  }
  process.exitCode = 1;
}

leaseCommand
  .command("verify")
  .description("Verify a plan's execution_lease on the workflow snapshot's plan row (missing/invalid \u2192 exit 1 with violations)")
  .option("--workflow <id>", "Workflow id whose snapshot plan row is verified")
  .option("--plan <plan-id>", "Plan id whose execution_lease is verified (default: the snapshot's sole plan row)")
  .option("--harness <path>", "Harness dir override (default: resolved {HARNESS_DIR})")
  .action((options: { workflow?: string; plan?: string; harness?: string }) => {
    try {
      if (!options.workflow) {
        throw new SddScriptError("usage: lease verify --workflow <id> [--plan <plan-id>] [--harness <path>]", 2);
      }
      const snapshotPath = resolveSnapshotPath(options.workflow, options.harness);
      if (!fs.existsSync(snapshotPath)) {
        throw new Error(`workflow snapshot not found: ${snapshotPath}`);
      }
      const doc = readJson(snapshotPath);
      const plans = Array.isArray(doc.plans) ? (doc.plans as Array<Record<string, unknown>>) : [];
      const planId = options.plan;
      if (planId === undefined) {
        const sole = solePlanRow(plans, `lease verify ${options.workflow}`);
        if ("error" in sole) throw sole.error;
        const row = sole.row;
        verifyLeaseRow(row, String(row.plan_id ?? row.id ?? ""), snapshotPath);
        return;
      }
      const matches = plans.filter((row) => row?.id === planId || row?.plan_id === planId);
      if (matches.length === 0) {
        console.error(pc.red(`${snapshotPath}: FAIL plan ${planId}`));
        console.error(`  - [high] lease.verify.plan-not-found: no plan row with id/plan_id ${planId}`);
        process.exitCode = 1;
        return;
      }
      if (matches.length > 1) {
        console.error(pc.red(`${snapshotPath}: FAIL plan ${planId}`));
        console.error("  - [high] lease.verify.ambiguous: multiple plan rows match (id and plan_id both present)");
        process.exitCode = 1;
        return;
      }
      verifyLeaseRow(matches[0]!, planId, snapshotPath);
    } catch (error) {
      failScript(error, "lease verify");
    }
  });

leaseCommand
  .command("verify-integration")
  .description(
    "Verify the workflow snapshot's top-level integration_merge_lease when present (absent/unclaimed \u2192 OK; invalid lease \u2192 exit 1)",
  )
  .option("--workflow <id>", "Workflow id whose snapshot top-level lease is verified")
  .option("--harness <path>", "Harness dir override (default: resolved {HARNESS_DIR})")
  .action((options: { workflow?: string; harness?: string }) => {
    try {
      if (!options.workflow) {
        throw new SddScriptError("usage: lease verify-integration --workflow <id> [--harness <path>]", 2);
      }
      const snapshotPath = resolveSnapshotPath(options.workflow, options.harness);
      if (!fs.existsSync(snapshotPath)) {
        throw new Error(`workflow snapshot not found: ${snapshotPath}`);
      }
      const doc = readJson(snapshotPath);
      const lease = doc.integration_merge_lease;
      if (lease === undefined) {
        console.log(pc.green(`${snapshotPath}: OK \u2014 no integration_merge_lease (unclaimed)`));
        return;
      }
      const gate = validateIntegrationMergeLease(lease);
      if (gate.ok) {
        console.log(pc.green(`${snapshotPath}: OK \u2014 integration_merge_lease valid (holder ${String((lease as Record<string, unknown>).holder ?? "")})`));
        return;
      }
      printChecklist("lease verify-integration", gate);
      process.exitCode = 1;
    } catch (error) {
      failScript(error, "lease verify-integration");
    }
  });

/**
 * Map engine `SddScriptError` exit codes (bash-parity: 1 = resolution/
 * workspace failure, 2 = usage/bad-ref, 3 = task N missing) onto the
 * process; anything else fails gracefully with exit 1 (slice-1
 * convention: `process.exitCode`, no throw through commander).
 */
function failScript(error: unknown, context: string): void {
  if (error instanceof SddScriptError) {
    console.error(pc.red(`${context} failed: ${error.message}`));
    process.exitCode = error.exitCode;
    return;
  }
  console.error(pc.red(`${context} failed: ${(error as Error).message}`));
  process.exitCode = 1;
}

const sddCommand = program
  .command("sdd")
  .description("SDD workspace / task-brief / review-package helpers (engine-backed)");

sddCommand
  .command("workspace")
  .description("Resolve and ensure {SDD_DIR} for a plan (exit 1 on resolution failures, 2 on usage errors)")
  .argument("[plan-id]", "Plan id whose SDD dir is resolved/created")
  .argument("[control-root]", "Control worktree root (default: MSTAR_CONTROL_ROOT or the cwd's git top-level)")
  .action((planId: string | undefined, controlRoot?: string) => {
    try {
      // Optional args + explicit count check: commander's own
      // missing-argument error exits 1, which would bypass the usage
      // contract (exit 2) — validate in-handler instead (qc2 F-005).
      if (!planId) {
        throw new SddScriptError(
          "usage: mstar sdd workspace PLAN_ID [CONTROL_ROOT]\n" +
            "  Set MSTAR_CONTROL_ROOT=<control_worktree_path> when running from a feature worktree.",
          2,
        );
      }
      const sddDir = sddWorkspace(planId, controlRoot ? { controlRoot } : {});
      console.log(pc.green(`sdd dir: ${sddDir}`));
    } catch (error) {
      failScript(error, "sdd workspace");
    }
  });

sddCommand
  .command("task-brief")
  .description("Extract the `## Task N` section of a plan into a brief file (exit 3 when task N is missing)")
  .argument("[plan-file]", "Plan markdown file")
  .argument("[task-number]", "Task number whose brief is extracted")
  .argument("[outfile]", "Output file (default: {SDD_DIR}/task-N-brief.md)")
  .action((planFile: string | undefined, taskNumber: string | undefined, outfile?: string) => {
    try {
      // Optional args + explicit count check (usage exit 2).
      if (!planFile || !taskNumber) {
        throw new SddScriptError("usage: mstar sdd task-brief PLAN_FILE TASK_NUMBER [OUTFILE]", 2);
      }
      const out = taskBrief(planFile, Number(taskNumber), outfile);
      console.log(pc.green(`task ${taskNumber} brief: ${out}`));
    } catch (error) {
      failScript(error, "sdd task-brief");
    }
  });

sddCommand
  .command("review-package")
  .description("Write commits + stat + diff -U10 for BASE..HEAD into a review file (exit 2 on bad refs)")
  .argument("[base]", "Base ref (commit SHA)")
  .argument("[head]", "Head ref (commit SHA)")
  .argument("[outfile]", "Output file (default: {SDD_DIR}/review-<short-base>..<short-head>.diff)")
  .action((base: string | undefined, head: string | undefined, outfile?: string) => {
    try {
      // Optional args + explicit count check (usage exit 2).
      if (!base || !head) {
        throw new SddScriptError("usage: mstar sdd review-package BASE HEAD [OUTFILE]", 2);
      }
      const out = reviewPackage(base, head, outfile);
      console.log(pc.green(`review package: ${out}`));
    } catch (error) {
      failScript(error, "sdd review-package");
    }
  });

const iterationCommand = program
  .command("iteration")
  .description("iteration phase-gate + push-cadence checks (engine-backed)");

/** Print one §3.1 entry / §3.5 exit checklist gate (OK or FAIL + violations). */
function printChecklist(label: string, gate: GateResult): void {
  if (gate.ok) {
    console.log(pc.green(`${label}: OK`));
    return;
  }
  const count = gate.violations.length;
  console.error(pc.red(`${label}: FAIL (${count} violation${count === 1 ? "" : "s"})`));
  for (const violation of gate.violations) {
    console.error(`  - [${violation.severity}] ${violation.code}: ${violation.message}`);
    if (violation.fix) console.error(`    fix: ${violation.fix}`);
  }
}

iterationCommand
  .command("gate")
  .description(
    "Evaluate the phase-transition gate: prints the transition (phase-2-execute / phase-3-close / phase-4-pr-delivery) " +
      "plus the \u00a73.1 entry and \u00a73.5 exit checklists. Exit 1 when the gate verdict fails \u2014 during the Phase-3 window " +
      "(transition: phase-3-close) exit 1 is EXPECTED until the \u00a73.4 close items (status: completed + end_date) are " +
      "written: the exit checklist gates Phase 4, not the Phase-3 entry (qc2 F-003)",
  )
  .requiredOption("--workflow <id>", "Workflow id whose snapshot is evaluated")
  .requiredOption("--compass <path>", "delivery-compass.md path")
  .option("--harness <path>", "Harness dir override (default: resolved {HARNESS_DIR})")
  .option("--branch <branch>", "Current branch probe (exit \u00a73.5 item 5)")
  .option("--integration <branch>", "Spec integration branch probe (exit \u00a73.5 item 5)")
  .option("--target <branch>", "PR base branch probe (exit \u00a73.5 item 6)")
  .action(
    (options: { workflow: string; compass: string; harness?: string; branch?: string; integration?: string; target?: string }) => {
    try {
      const snapshotPath = resolveSnapshotPath(options.workflow, options.harness);
      const compassPath = path.resolve(options.compass);
      if (!fs.existsSync(snapshotPath)) throw new Error(`workflow snapshot not found: ${snapshotPath}`);
      if (!fs.existsSync(compassPath)) throw new Error(`compass file not found: ${compassPath}`);
      const result = evaluatePhaseGate(readJson(snapshotPath), parseCompassFrontmatter(compassPath), {
        currentBranch: options.branch,
        specIntegrationBranch: options.integration,
        prBaseBranch: options.target,
      });
      console.log(`transition: ${result.transition}`);
      printChecklist("entry (close \u00a73.1)", result.entry);
      printChecklist("exit (close \u00a73.5)", result.exit);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      console.error(pc.red(`iteration gate failed: ${(error as Error).message}`));
      process.exitCode = 1;
    }
  });

iterationCommand
  .command("push-cadence")
  .description("\u00a75.1a push-cadence probe: never push while CI or an AI review wave is running (exit 1 when blocked)")
  .option("--ci-running", "CI checks are still queued/in_progress on the current head")
  .option("--review-wave", "An AI/bot review wave is still running on the current head")
  .action((options: { ciRunning?: boolean; reviewWave?: boolean }) => {
    const result = pushCadenceProbe(Boolean(options.ciRunning), Boolean(options.reviewWave));
    if (result.ok) {
      console.log(pc.green("push allowed: CI idle, no AI review wave"));
      return;
    }
    const count = result.violations.length;
    console.error(pc.red(`push blocked (${count} violation${count === 1 ? "" : "s"})`));
    for (const violation of result.violations) {
      console.error(`  - [${violation.severity}] ${violation.code}: ${violation.message}`);
      if (violation.fix) console.error(`    fix: ${violation.fix}`);
    }
    process.exitCode = 1;
  });

const dispatchCommand = program
  .command("dispatch")
  .description("Assignment field + default-branch gate checks (engine-backed)");

dispatchCommand
  .command("validate")
  .description(
    "Validate an Assignment markdown file: required header fields + exactly-one branch form, " +
      "then the default-protected-branch gate (exit 1 on violations, 2 on usage)",
  )
  .argument("[assignment-file]", "Assignment markdown file")
  .option(
    "--branch <branch>",
    "Gate branch context (default: derived from the Assignment's own branch forms, then $MSTAR_WORKING_BRANCH)",
  )
  .action((assignmentFile: string | undefined, options: { branch?: string }) => {
    try {
      // Optional arg + explicit count check (bash-parity usage exit 2, slice-2
      // convention: commander's own missing-argument error would exit 1).
      if (!assignmentFile) {
        throw new SddScriptError("usage: dispatch validate <assignment-file> [--branch <branch>]", 2);
      }
      const file = resolveCliPath(assignmentFile);
      if (!fs.existsSync(file)) {
        throw new Error(`assignment file not found: ${file}`);
      }
      const text = fs.readFileSync(file, "utf8");

      // Read-only orientation roles (scout/explore, engine SSOT) skip the
      // branch-form gate AND the default-branch gate — no writable work on a
      // branch (qc3 F-1 / qc2 S-5): `mstar dispatch validate` on a scout
      // Assignment without a Working branch exits 0.
      const readOnly = isReadOnlyAssignmentRole(parseAssignmentFields(text).executeAs ?? "");
      const violations = [...validateAssignmentFields(text, { writable: readOnly ? false : undefined }).violations];

      if (!readOnly) {
        // Default-branch gate: the checked branch is derived FROM THE
        // ASSIGNMENT — create-form → the created branch, existing form → the
        // branch, `Branch policy` → the exception branch — so the documented
        // preflight invocation (`dispatch validate <assignment-file>`, no
        // --branch) actually gates (qc2 W-1). `--branch` / $MSTAR_WORKING_BRANCH
        // are context fallbacks for assignments without a branch form (qc3
        // F-2: "create feature/x from main" checks feature/x, not main). A
        // well-formed `Branch policy: direct on <branch> — <reason>` exception
        // is honored only when its branch is the one being checked.
        const forms = parseAssignmentBranchForms(text);
        const branch =
          forms.createForm?.name ?? forms.workingBranch ?? forms.directOn?.branch ?? options.branch ?? process.env.MSTAR_WORKING_BRANCH;
        if (branch !== undefined && branch.trim() !== "") {
          const directOnException = parseBranchPolicyDirectOnBranch(text) === branch.trim();
          violations.push(...assertDefaultBranchProtected(branch, { directOnException }).violations);
        }
      }
      printChecklist("dispatch validate", { ok: violations.length === 0, violations });
      if (violations.length > 0) process.exitCode = 1;
    } catch (error) {
      failScript(error, "dispatch validate");
    }
  });

const worktreeCommand = program
  .command("worktree")
  .description("L1/L2 pre-dispatch worktree checks (engine-backed)");

/** Parse the `--tracks` JSON arg into L2 track records (arg-shape errors → usage exit 2). */
function parseTracksArg(tracksJson: string): WorktreeTrack[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(tracksJson);
  } catch {
    throw new SddScriptError("usage: worktree check --l2 --tracks <json> \u2014 invalid JSON", 2);
  }
  if (!Array.isArray(parsed)) {
    throw new SddScriptError(
      "usage: worktree check --l2 --tracks <json> \u2014 expected a JSON array of {worktreePath, workingBranch}",
      2,
    );
  }
  const tracks: WorktreeTrack[] = [];
  for (const item of parsed) {
    const record = item as { worktreePath?: unknown; workingBranch?: unknown } | null;
    if (record === null || typeof record !== "object" || typeof record.worktreePath !== "string" || typeof record.workingBranch !== "string") {
      throw new SddScriptError(
        "usage: worktree check --l2 --tracks <json> \u2014 every track needs string worktreePath + workingBranch",
        2,
      );
    }
    tracks.push({ worktreePath: record.worktreePath, workingBranch: record.workingBranch });
  }
  return tracks;
}

worktreeCommand
  .command("check")
  .description(
    "L1: verify the plan's execution_lease worktree vs control path (isolation, existence, branch alignment) from the " +
      "workflow snapshot rows + snapshot control_worktree_path; --l2: verify parallel writable tracks (exit 1 on violations, 2 on usage)",
  )
  .argument("[plan-id]", "Plan id whose execution_lease drives the L1 input (alternative to --plan)")
  .option("--workflow <id>", "Workflow id whose snapshot supplies the L1 plan rows + control_worktree_path")
  .option("--plan <plan-id>", "Plan id whose execution_lease drives the L1 input")
  .option("--harness <path>", "Harness dir override (default: resolved {HARNESS_DIR})")
  .option("--control <path>", "Control worktree path override (default: snapshot control_worktree_path)")
  .option("--l2", "Run the L2 within-plan check (parallel writable tracks) instead of L1")
  .option(
    "--tracks <json>",
    'L2 tracks JSON: [{"worktreePath": "/abs/path", "workingBranch": "feature/x"}] (required with --l2)',
  )
  .action(
    (
      planId: string | undefined,
      options: { workflow?: string; plan?: string; harness?: string; control?: string; l2?: boolean; tracks?: string },
    ) => {
      try {
        if (options.l2) {
          if (!options.tracks) {
            throw new SddScriptError("usage: worktree check --l2 --tracks <json>", 2);
          }
          const gate = l2PreDispatchCheck({ tracks: parseTracksArg(options.tracks) });
          printChecklist("worktree L2 check", gate);
          if (!gate.ok) process.exitCode = 1;
          return;
        }
        // plan-id positional or --plan (option wins when both are given).
        const plan = options.plan ?? planId;
        if (!plan) {
          throw new SddScriptError(
            "usage: worktree check <plan-id> --workflow <id> [--harness <path>] [--control <path>] (or --plan <plan-id>)",
            2,
          );
        }
        if (!options.workflow) {
          throw new SddScriptError("usage: worktree check <plan-id> --workflow <id> [--harness <path>] [--control <path>] (or --plan <plan-id>)", 2);
        }
        const snapshotPath = resolveSnapshotPath(options.workflow, options.harness);
        if (!fs.existsSync(snapshotPath)) {
          throw new Error(`workflow snapshot not found: ${snapshotPath}`);
        }
        const doc = readJson(snapshotPath);
        const plans = Array.isArray(doc.plans) ? (doc.plans as Array<Record<string, unknown>>) : [];
        const matches = plans.filter((row) => row?.id === plan || row?.plan_id === plan);
        if (matches.length === 0) {
          console.error(pc.red(`${snapshotPath}: FAIL plan ${plan}`));
          console.error(`  - [high] worktree.l1.plan-not-found: no plan row with id/plan_id ${plan}`);
          process.exitCode = 1;
          return;
        }
        if (matches.length > 1) {
          console.error(pc.red(`${snapshotPath}: FAIL plan ${plan}`));
          console.error("  - [high] worktree.l1.ambiguous: multiple plan rows match (id and plan_id both present)");
          process.exitCode = 1;
          return;
        }
        const row = matches[0]!;
        const lease = (row.execution_lease ?? {}) as Record<string, unknown>;
        const input: L1PreDispatchInput = {
          controlWorktreePath: options.control ? path.resolve(options.control) : String(doc.control_worktree_path ?? ""),
          leaseWorktreePath: String(lease.worktree_path ?? ""),
          leaseWorkingBranch: String(lease.working_branch ?? ""),
          planId: plan,
        };
        const gate = l1PreDispatchCheck(input);
        printChecklist("worktree L1 check", gate);
        if (!gate.ok) process.exitCode = 1;
      } catch (error) {
        failScript(error, "worktree check");
      }
    },
  );

/** Parse one Assignment header field (`**Label**: value` or `Label: value`, list bullets tolerated). */
function parseAssignmentHeaderField(assignmentText: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boldRe = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?\\*\\*\\s*${escaped}\\s*\\*\\*\\s*:\\s*(.*)$`);
  const plainRe = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${escaped}\\s*:\\s*(.*)$`);
  for (const line of assignmentText.split(/\r?\n/)) {
    const match = line.match(boldRe) ?? line.match(plainRe);
    if (match) return match[1]!.trim();
  }
  return "";
}

/** QC/QA alignment fields asserted byte-identical across QC tri + QA Assignments (engine contract). */
const QC_ALIGNMENT_FIELDS: ReadonlyArray<{ key: keyof QcAlignmentAssignment; label: string }> = [
  { key: "planId", label: "plan_id" },
  { key: "reviewRange", label: "Review range" },
  { key: "diffBasis", label: "Diff basis" },
];

worktreeCommand
  .command("qc-alignment")
  .description(
    "Assert the QC/QA alignment fields (plan_id / Review range / Diff basis) are byte-identical across the given " +
      "Assignment files (separate or combined `Review range / Diff basis` labels; exit 1 on mismatch or missing field, 2 on usage)",
  )
  .argument("[assignment-files...]", "QC tri + QA Assignment markdown files (at least one required)")
  .action((files: string[]) => {
    try {
      if (files.length === 0) {
        throw new SddScriptError("usage: worktree qc-alignment <assignment-file>...", 2);
      }
      const assignments: QcAlignmentAssignment[] = [];
      for (const fileArg of files) {
        const file = path.resolve(fileArg);
        if (!fs.existsSync(file)) {
          throw new Error(`assignment file not found: ${file}`);
        }
        const text = fs.readFileSync(file, "utf8");
        // The canonical PM label combines both range fields in one value
        // (`**Review range / Diff basis**: ...`); a separate `Review range` /
        // `Diff basis` label wins over the combined value for its own field.
        const combinedRange = parseAssignmentHeaderField(text, "Review range / Diff basis");
        const planId = parseAssignmentHeaderField(text, "plan_id");
        const reviewRange = parseAssignmentHeaderField(text, "Review range") || combinedRange;
        const diffBasis = parseAssignmentHeaderField(text, "Diff basis") || combinedRange;
        const values = { planId, reviewRange, diffBasis };
        const missing = QC_ALIGNMENT_FIELDS.filter((field) => values[field.key] === "");
        if (missing.length > 0) {
          console.error(pc.red(`worktree qc-alignment: FAIL ${file}`));
          for (const field of missing) {
            console.error(`  - [high] qc.alignment.field.missing: missing "${field.label}" header field`);
          }
          process.exitCode = 1;
          return;
        }
        assignments.push({ planId, reviewRange, diffBasis });
      }
      const gate = assertQcAlignment(assignments);
      if (gate.ok) {
        console.log(
          pc.green(
            `worktree qc-alignment: OK (${assignments.length} assignment${assignments.length === 1 ? "" : "s"}, ` +
              `${QC_ALIGNMENT_FIELDS.length} fields byte-identical)`,
          ),
        );
        return;
      }
      printChecklist("worktree qc-alignment", gate);
      process.exitCode = 1;
    } catch (error) {
      failScript(error, "worktree qc-alignment");
    }
  });

const reviewCommand = program
  .command("review")
  .description("QC seat-mapping checks (engine-backed)");

/** Parse the Assignment's `Execution mode` header field (bold or plain form). */
function parseAssignmentExecutionMode(assignmentText: string): string {
  for (const line of assignmentText.split(/\r?\n/)) {
    const match =
      line.match(/^\*\*\s*Execution mode\s*\*\*\s*:\s*(.*)$/) ?? line.match(/^Execution mode\s*:\s*(.*)$/);
    if (match) return match[1]!.trim();
  }
  return "";
}

reviewCommand
  .command("seats")
  .description(
    "Map an Assignment's execution mode to its QC seat count N; with --reviewers, verify tri identity on sdd " +
      "(exit 1 on violations, 2 on usage)",
  )
  .argument("[assignment-file]", "Assignment markdown file")
  .option("--mode <mode>", "Execution mode override (sdd | inline | targeted; default: the Assignment's Execution mode field)")
  .option("--reviewers <list>", "Comma-separated reviewer roles (targeted seats; tri-identity checked when mode is sdd)")
  .action((assignmentFile: string | undefined, options: { mode?: string; reviewers?: string }) => {
    try {
      // Optional arg + explicit count check (bash-parity usage exit 2).
      if (!assignmentFile) {
        throw new SddScriptError("usage: review seats <assignment-file> [--mode sdd|inline|targeted] [--reviewers <role1,role2,...>]", 2);
      }
      const file = path.resolve(assignmentFile);
      if (!fs.existsSync(file)) {
        throw new Error(`assignment file not found: ${file}`);
      }
      const text = fs.readFileSync(file, "utf8");
      const mode = options.mode ?? parseAssignmentExecutionMode(text);
      const reviewers = (options.reviewers ?? "")
        .split(",")
        .map((role) => role.trim())
        .filter((role) => role !== "");
      const result = executionModeToN(mode, { seats: reviewers });
      if (!result.ok) {
        printChecklist("review seats", result);
        process.exitCode = 1;
        return;
      }
      // Tri identity on sdd only when an initial-wave reviewer list is given
      // (dispatch-gates § QC tri-review: exactly qc-specialist/-2/-3).
      const normalizedMode = mode.trim().toLowerCase().split(/\s+/)[0] ?? "";
      if (normalizedMode === "sdd" && reviewers.length > 0) {
        const tri = assertTriIdentity(reviewers);
        if (!tri.ok) {
          printChecklist("review seats (tri identity)", tri);
          process.exitCode = 1;
          return;
        }
      }
      console.log(pc.green(`seats: ${result.n}`));
    } catch (error) {
      failScript(error, "review seats");
    }
  });

// ---------------------------------------------------------------------------
// Slice 4: lint / design-md / audit / compound / host / skill (engine-backed
// thin wrappers — business logic lives in @mstar-harness/engine)
// ---------------------------------------------------------------------------

/** Content types `mstar lint` knows, mapped 1:1 to engine lint.* checks. */
type LintTargetType = "plan" | "skill" | "strategy" | "report" | "code";

/** Build a static string-keyed membership lookup from an enum array. */
function lookupTable(values: readonly string[]): Record<string, true> {
  const table: Record<string, true> = {};
  for (const value of values) table[value] = true;
  return table;
}

/** Directories skipped during `mstar lint <dir>` walks (build/vendor trees). */
const LINT_SKIP_DIRS: Record<string, true> = {
  node_modules: true,
  ".git": true,
  dist: true,
  coverage: true,
  ".turbo": true,
};

/** Code-file extensions linted for `simplify:` / `temporary` markers. */
const LINT_CODE_EXTENSIONS: Record<string, true> = {
  ".ts": true, ".tsx": true, ".mts": true, ".cts": true,
  ".js": true, ".jsx": true, ".mjs": true, ".cjs": true,
  ".py": true, ".go": true, ".rs": true, ".sh": true, ".bash": true, ".zsh": true,
  ".rb": true, ".java": true, ".kt": true, ".swift": true,
};

/**
 * Classify a lint target by content type (basename first, then plan-location
 * heuristics, then code extensions). Unclassifiable files (DESIGN.md, task
 * briefs, prose docs, ...) return `null` — `mstar lint` skips them in dir
 * walks and rejects them as usage errors when named explicitly.
 */
function lintTargetType(filePath: string): LintTargetType | null {
  const base = path.basename(filePath);
  if (base === "STRATEGY.md") return "strategy";
  if (base === "SKILL.md") return "skill";
  if (/^task-\d+-report\.md$/i.test(base)) return "report";
  const dir = path.dirname(filePath);
  if (dir.includes(`${path.sep}plans${path.sep}`) || dir.endsWith(`${path.sep}plans`)) return "plan";
  if (/^\d{8}-[a-z0-9.-]+\.md$/i.test(base)) return "plan";
  if (LINT_CODE_EXTENSIONS[path.extname(base).toLowerCase()] === true) return "code";
  return null;
}

/** Recursively collect lintable files under a directory (skip build trees). */
function collectLintTargets(dir: string): string[] {
  const targets: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (LINT_SKIP_DIRS[entry.name] !== true) walk(path.join(current, entry.name));
      } else if (entry.isFile() && lintTargetType(path.join(current, entry.name)) !== null) {
        targets.push(path.join(current, entry.name));
      }
    }
  };
  walk(dir);
  return targets;
}

/** Run the content-type engine checks for one lint target. Markers are
 * advisory info (stdout); violations gate the exit code (stderr). */
function lintOneFile(filePath: string): { violations: ValidationResult[]; markers: string[] } {
  const abs = path.resolve(filePath);
  const text = fs.readFileSync(abs, "utf8");
  const violations: ValidationResult[] = [];
  const markers: string[] = [];
  switch (lintTargetType(abs)) {
    case "plan":
      violations.push(...planQualityBar(text).violations);
      break;
    case "skill":
      violations.push(...lintFrontmatter(text).violations);
      break;
    case "strategy":
      violations.push(...lintStrategySections(text).violations);
      break;
    case "report":
      violations.push(...assertSddTddTriple(text).violations);
      break;
    case "code": {
      for (const marker of findSimplifyMarkers(text)) {
        markers.push(`simplify marker @${marker.line}: ${marker.text}`);
      }
      const temporary = findTemporaryMarkers(text);
      for (const marker of temporary.markers) {
        const removal = marker.removalPath === null ? "no removal path" : `removal: ${marker.removalPath}`;
        markers.push(`temporary marker @${marker.line}: ${marker.text} (${removal})`);
      }
      violations.push(...temporary.violations);
      break;
    }
    default:
      throw new SddScriptError(
        `usage: lint <target> \u2014 unsupported file type "${path.basename(abs)}" (lintable: plan files, SKILL.md, STRATEGY.md, task-N-report.md, code files)`,
        2,
      );
  }
  return { violations, markers };
}

const lintCommand = program
  .command("lint")
  .description(
    "lint harness artifacts by content type (engine-backed): plan files \u2192 quality bar, SKILL.md \u2192 frontmatter, " +
      "STRATEGY.md \u2192 required sections, task-N-report.md \u2192 SDD TDD triple, code files \u2192 simplify:/temporary markers",
  );

lintCommand
  .description("Lint <target> (file or dir) \u2014 exit 1 on violations, 2 on usage")
  .argument("[target]", "File or directory to lint")
  .action((target?: string) => {
    try {
      if (!target) throw new SddScriptError("usage: lint <target> (file or dir)", 2);
      const abs = resolveCliPath(target);
      if (!fs.existsSync(abs)) throw new Error(`lint target not found: ${abs}`);
      const targets = fs.statSync(abs).isDirectory() ? collectLintTargets(abs) : [abs];
      if (targets.length === 0) {
        console.log(pc.yellow(`lint: no lintable files under ${target}`));
        return;
      }
      let violations = 0;
      for (const file of targets) {
        const label = `lint ${file}`;
        let result: { violations: ValidationResult[]; markers: string[] };
        try {
          result = lintOneFile(file);
        } catch (error) {
          if (error instanceof SddScriptError) throw error;
          console.error(pc.red(`${label}: ERROR \u2014 ${(error as Error).message}`));
          violations++;
          continue;
        }
        for (const marker of result.markers) console.log(`  ${pc.cyan(marker)}`);
        if (result.violations.length === 0) {
          console.log(pc.green(`${label}: OK`));
          continue;
        }
        violations += result.violations.length;
        const count = result.violations.length;
        console.error(pc.red(`${label}: FAIL (${count} violation${count === 1 ? "" : "s"})`));
        for (const violation of result.violations) {
          console.error(`  - [${violation.severity}] ${violation.code}: ${violation.message}`);
          if (violation.fix) console.error(`    fix: ${violation.fix}`);
        }
      }
      if (violations > 0) process.exitCode = 1;
    } catch (error) {
      failScript(error, "lint");
    }
  });

const designMdCommand = program
  .command("design-md")
  .description("DESIGN.md token frontmatter / light-dark parity / completeness checks (engine-backed)");

designMdCommand
  .command("validate")
  .description(
    "Validate DESIGN.md in <dir>: token frontmatter, light/dark parity when DESIGN.dark.md exists, " +
      "and the completeness level (exit 1 on violations, 2 on usage)",
  )
  .argument("[dir]", "Directory containing DESIGN.md")
  .action((dir?: string) => {
    try {
      if (!dir) throw new SddScriptError("usage: design-md validate <dir>", 2);
      const abs = resolveCliPath(dir);
      const lightPath = path.join(abs, "DESIGN.md");
      if (!fs.existsSync(lightPath)) throw new Error(`design file not found: ${lightPath}`);
      const light = fs.readFileSync(lightPath, "utf8");
      const violations: ValidationResult[] = [];
      const tokens = validateDesignTokenFrontmatter(light);
      printChecklist("design-md validate (tokens)", tokens);
      violations.push(...tokens.violations);
      const darkPath = path.join(abs, "DESIGN.dark.md");
      if (fs.existsSync(darkPath)) {
        const parity = assertLightDarkParity(light, fs.readFileSync(darkPath, "utf8"));
        printChecklist("design-md validate (light/dark parity)", parity);
        violations.push(...parity.violations);
      }
      const level = completenessLevel(light);
      console.log(`design-md completeness level: ${level.level}`);
      if (level.missing.length > 0) console.log(`  missing for next level: ${level.missing.join(", ")}`);
      if (level.bodyUnverified) {
        console.log(pc.yellow("  note: body-only checklist items not verified \u2014 Production caps at Standard"));
      }
      if (violations.length > 0) process.exitCode = 1;
    } catch (error) {
      failScript(error, "design-md validate");
    }
  });

/**
 * Parse the `audit scaffold` findings file. Two accepted shapes:
 * - a bare JSON array of finding objects (legacy), or
 * - an object `{ findings: [...], needsVerification?: [...], hardeningChecked?: [...] }`
 *   carrying the security-disposition entries documented by
 *   `mstar-audit/references/security-review.md` alongside the findings.
 *
 * `dependsOn` is validated against the Status-block contract and normalized:
 * `"none"` / `plans/NNN-*.md` pass through, a bare plan number (`002`) from
 * the scaffolded numbering scheme is rendered as `plans/002-*.md`, anything
 * else is a usage error — so every scaffolded plan round-trips through
 * `validateAuditStatusBlocks` (qc2 F-001 / qc3 F-002).
 */
type AuditScaffoldInput = {
  findings: AuditFinding[];
  needsVerification?: { lead: string; how: string; evidence?: string }[];
  hardeningChecked?: { kind: "Hardening" | "Checked and clean"; text: string }[];
};

const AUDIT_HARDENING_KINDS = ["Hardening", "Checked and clean"] as const;

function parseAuditScaffoldInput(text: string): AuditScaffoldInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SddScriptError("usage: audit scaffold \u2014 findings file is not valid JSON", 2);
  }
  let root: unknown[];
  let needsVerificationRaw: unknown;
  let hardeningCheckedRaw: unknown;
  if (Array.isArray(parsed)) {
    root = parsed;
  } else if (typeof parsed === "object" && parsed !== null) {
    const doc = parsed as Record<string, unknown>;
    if (!Array.isArray(doc.findings)) {
      throw new SddScriptError("usage: audit scaffold \u2014 findings file must be a JSON array or an object with a findings array", 2);
    }
    root = doc.findings;
    needsVerificationRaw = doc.needsVerification;
    hardeningCheckedRaw = doc.hardeningChecked;
  } else {
    throw new SddScriptError("usage: audit scaffold \u2014 findings file must be a JSON array or an object with a findings array", 2);
  }

  const findings = root.map((raw, index): AuditFinding => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new SddScriptError(`usage: audit scaffold \u2014 findings[${index}] is not an object`, 2);
    }
    const finding = raw as Record<string, unknown>;
    const title = typeof finding.title === "string" ? finding.title.trim() : "";
    const impact = typeof finding.description === "string" ? finding.description.trim() : "";
    const priority = typeof finding.priority === "string" ? finding.priority : "";
    const effort = typeof finding.effort === "string" ? finding.effort : "";
    const risk = typeof finding.risk === "string" ? finding.risk : "";
    const category = typeof finding.category === "string" ? finding.category : "";
    if (title === "" || impact === "") {
      throw new SddScriptError(`usage: audit scaffold \u2014 findings[${index}] needs non-empty title and description`, 2);
    }
    if (AUDIT_PRIORITY_LOOKUP[priority] !== true) {
      throw new SddScriptError(`usage: audit scaffold \u2014 findings[${index}].priority must be one of ${AUDIT_PRIORITIES.join("|")}`, 2);
    }
    if (AUDIT_EFFORT_LOOKUP[effort] !== true) {
      throw new SddScriptError(`usage: audit scaffold \u2014 findings[${index}].effort must be one of ${AUDIT_EFFORTS.join("|")}`, 2);
    }
    if (AUDIT_RISK_LOOKUP[risk] !== true) {
      throw new SddScriptError(`usage: audit scaffold \u2014 findings[${index}].risk must be one of ${AUDIT_RISKS.join("|")}`, 2);
    }
    if (AUDIT_CATEGORY_LOOKUP[category] !== true) {
      throw new SddScriptError(`usage: audit scaffold \u2014 findings[${index}].category must be one of ${AUDIT_CATEGORIES.join("|")}`, 2);
    }
    const rawDependsOn = typeof finding.dependsOn === "string" && finding.dependsOn.trim() !== "" ? finding.dependsOn.trim() : undefined;
    if (rawDependsOn !== undefined && !/^(?:none|plans\/\d{3}-[\w.*-]+\.md|\d{3})$/i.test(rawDependsOn)) {
      throw new SddScriptError(
        `usage: audit scaffold \u2014 findings[${index}].dependsOn must be "none", "plans/NNN-*.md", or a plan number NNN`,
        2,
      );
    }
    const dependsOn =
      rawDependsOn === undefined ? undefined : /^\d{3}$/.test(rawDependsOn) ? `plans/${rawDependsOn}-*.md` : rawDependsOn;
    // Enum memberships were validated above — cast the narrowed unions.
    return {
      title,
      category: category as AuditCategory,
      impact,
      effort: effort as AuditEffort,
      risk: risk as AuditRisk,
      confidence: "MED",
      evidence: [],
      priority: priority as AuditPriority,
      dependsOn,
    };
  });

  return { findings, needsVerification: parseNeedsVerification(needsVerificationRaw), hardeningChecked: parseHardeningChecked(hardeningCheckedRaw) };
}

function parseNeedsVerification(raw: unknown): AuditScaffoldInput["needsVerification"] {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new SddScriptError("usage: audit scaffold \u2014 needsVerification must be an array of {lead, how, evidence?}", 2);
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new SddScriptError(`usage: audit scaffold \u2014 needsVerification[${index}] is not an object`, 2);
    }
    const e = entry as Record<string, unknown>;
    const lead = typeof e.lead === "string" ? e.lead.trim() : "";
    const how = typeof e.how === "string" ? e.how.trim() : "";
    if (lead === "" || how === "") {
      throw new SddScriptError(`usage: audit scaffold \u2014 needsVerification[${index}] needs non-empty lead and how`, 2);
    }
    const evidence = typeof e.evidence === "string" && e.evidence.trim() !== "" ? e.evidence.trim() : undefined;
    return { lead, how, evidence };
  });
}

function parseHardeningChecked(raw: unknown): AuditScaffoldInput["hardeningChecked"] {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new SddScriptError("usage: audit scaffold \u2014 hardeningChecked must be an array of {kind, text}", 2);
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new SddScriptError(`usage: audit scaffold \u2014 hardeningChecked[${index}] is not an object`, 2);
    }
    const e = entry as Record<string, unknown>;
    const kind = typeof e.kind === "string" ? e.kind : "";
    const text = typeof e.text === "string" ? e.text.trim() : "";
    if (!AUDIT_HARDENING_KINDS.includes(kind as (typeof AUDIT_HARDENING_KINDS)[number])) {
      throw new SddScriptError(`usage: audit scaffold \u2014 hardeningChecked[${index}].kind must be one of ${AUDIT_HARDENING_KINDS.join("|")}`, 2);
    }
    if (text === "") {
      throw new SddScriptError(`usage: audit scaffold \u2014 hardeningChecked[${index}] needs non-empty text`, 2);
    }
    return { kind: kind as (typeof AUDIT_HARDENING_KINDS)[number], text };
  });
}

const auditCommand = program
  .command("audit")
  .description("audit plan scaffold (engine-backed)");

/**
 * Resolve the short repo SHA for the scaffolded `Planned at` field:
 * `--sha` override wins; otherwise `git rev-parse --short HEAD` from the
 * current working directory; `unknown` only when the cwd is not inside a
 * git repo (the documented validator fallback — qc2 F-001 / qc3 F-002).
 */
function resolveAuditShortSha(cwd: string, override?: string): string {
  if (override !== undefined && override !== "") return override;
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return "unknown";
  }
}

auditCommand
  .command("scaffold")
  .description(
    "Scaffold an audit-<date>/ plan directory (numbered plan files + README index) from a JSON findings file " +
      "(exit 2 on usage)",
  )
  .argument("[findings-file]", "JSON file: array of {title, priority, effort, risk, category, dependsOn?, description}, or object {findings: [...], needsVerification?: [{lead, how, evidence?}], hardeningChecked?: [{kind, text}]}")
  .option("--dir <out-dir>", "Output directory (default: ./audit-<date> from --date or today)")
  .option("--sha <commit>", "Short commit SHA for the Planned-at field (default: git rev-parse --short HEAD)")
  .option("--date <YYYY-MM-DD>", "Audit date (default: today)")
  .option("--repo <name>", "Repository name for the README title (default: repo)")
  .action((findingsFile: string | undefined, options: { dir?: string; sha?: string; date?: string; repo?: string }) => {
    try {
      if (!findingsFile) throw new SddScriptError("usage: audit scaffold <findings-file> [--dir <out-dir>]", 2);
      const abs = resolveCliPath(findingsFile);
      if (!fs.existsSync(abs)) throw new Error(`findings file not found: ${abs}`);
      if (options.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
        throw new SddScriptError("usage: audit scaffold \u2014 --date must be YYYY-MM-DD", 2);
      }
      if (options.sha !== undefined && !/^[0-9a-f]{7,40}$/.test(options.sha)) {
        throw new SddScriptError("usage: audit scaffold \u2014 --sha must be a 7-40 char hex commit SHA", 2);
      }
      const date = options.date ?? new Date().toISOString().slice(0, 10);
      const outDir = options.dir !== undefined ? resolveCliPath(options.dir) : resolveCliPath(`audit-${date}`);
      const input = parseAuditScaffoldInput(fs.readFileSync(abs, "utf8"));
      const sha = resolveAuditShortSha(process.cwd(), options.sha);
      const result = scaffoldAuditPlan(outDir, input.findings, {
        date,
        repoName: options.repo,
        repoShortSha: sha,
        needsVerification: input.needsVerification,
        hardeningChecked: input.hardeningChecked,
      });
      const count = result.files.length;
      console.log(pc.green(`audit scaffold: OK \u2014 ${count} plan file${count === 1 ? "" : "s"} in ${result.outDir}`));
      for (const file of result.files) console.log(`  created: ${file}`);
    } catch (error) {
      failScript(error, "audit scaffold");
    }
  });

auditCommand
  .command("promote")
  .description(
    "Promote selected audit plans into the v2 workflow lifecycle: write the workflow snapshot " +
      "(type plan, Todo rows) then register the workflow in {HARNESS_DIR}/status.json " +
      "(exit 2 on usage, 1 when the harness dir cannot be resolved)",
  )
  .argument("[audit-dir]", "audit-<date>/ directory under {PLAN_DIR}")
  .option("--plans <ids>", "Comma-separated selected plan ids (README Plan column `001`, stem, or basename)")
  .option("--workflow <id>", "Workflow id (default: audit-<date> basename)")
  .option("--harness <dir>", "Harness dir containing status.json (default: resolveHarnessDir() / MSTAR_HARNESS_DIR)")
  .action(async (auditDir: string | undefined, options: { plans?: string; workflow?: string; harness?: string }) => {
    try {
      // Optional flag + explicit check (same as `lease verify-integration`):
      // commander's own missing-requiredOption error exits 1, which would
      // bypass the usage contract (exit 2) — validate in-handler instead.
      if (!auditDir) {
        throw new SddScriptError("usage: audit promote <audit-dir> --plans <ids> [--workflow <id>] [--harness <dir>]", 2);
      }
      const selected = parseCsv(options.plans);
      if (!selected || selected.length === 0) {
        throw new SddScriptError("usage: audit promote <audit-dir> --plans <ids> [--workflow <id>] [--harness <dir>]", 2);
      }
      const outDir = resolveCliPath(auditDir);
      if (!fs.existsSync(outDir)) {
        throw new Error(`audit dir not found: ${outDir}`);
      }
      const harnessDir = resolveLeaseHarnessDir(options.harness);
      const result = await promoteAuditPlans(outDir, selected, {
        harnessDir,
        ...(options.workflow !== undefined ? { workflowId: options.workflow } : {}),
      });
      console.log(pc.green(`audit promote: OK \u2014 workflow ${result.workflowId} registered`));
      console.log(`  snapshot: ${result.snapshotPath}`);
    } catch (error) {
      failScript(error, "audit promote");
    }
  });

const compoundCommand = program
  .command("compound")
  .description("knowledge-doc schema / index / scope checks (engine-backed)");

compoundCommand
  .command("validate")
  .description(
    "Validate a knowledge doc frontmatter (schema.yaml contract); with --knowledge-dir, also assert the " +
      "knowledge README index rows and guard the doc inside the knowledge scope (exit 1 on violations, 2 on usage)",
  )
  .argument("[doc-path]", "Knowledge doc (markdown with YAML frontmatter)")
  .option("--knowledge-dir <dir>", "Knowledge directory (enables index-row asserts + scope guard)")
  .action((docPath: string | undefined, options: { knowledgeDir?: string }) => {
    try {
      if (!docPath) throw new SddScriptError("usage: compound validate <doc-path> [--knowledge-dir <dir>]", 2);
      const abs = resolveCliPath(docPath);
      if (!fs.existsSync(abs)) throw new Error(`knowledge doc not found: ${abs}`);
      const text = fs.readFileSync(abs, "utf8");
      const violations: ValidationResult[] = [];
      const schema = validateSchemaYaml(text);
      printChecklist("compound validate (schema)", schema);
      violations.push(...schema.violations);
      if (options.knowledgeDir !== undefined) {
        const knowledgeDir = resolveCliPath(options.knowledgeDir);
        const index = assertIndexRows(knowledgeDir);
        printChecklist("compound validate (index rows)", index);
        violations.push(...index.violations);
        const scope = scopeGuard(abs, [knowledgeDir]);
        printChecklist("compound validate (scope guard)", scope);
        violations.push(...scope.violations);
      }
      if (violations.length > 0) process.exitCode = 1;
    } catch (error) {
      failScript(error, "compound validate");
    }
  });

/** Audit enum membership lookups (engine enum arrays — no drift). */
const AUDIT_PRIORITY_LOOKUP = lookupTable(AUDIT_PRIORITIES);
const AUDIT_EFFORT_LOOKUP = lookupTable(AUDIT_EFFORTS);
const AUDIT_RISK_LOOKUP = lookupTable(AUDIT_RISKS);
const AUDIT_CATEGORY_LOOKUP = lookupTable(AUDIT_CATEGORIES);

/** Valid `host detect --signals` tokens (mstar-host detection table, ported
 * verbatim to the engine's ToolSignal enum). */
const HOST_SIGNALS: readonly ToolSignal[] = [
  "subagent_type",
  "question",
  "task_subagent",
  "task_agent_batch",
  "ask",
  "hub",
  "Agent",
  "AgentSwarm",
  "AskUserQuestion",
  "EnterPlanMode",
  "TodoWrite",
  "plan_slash",
  "goal",
  "functions.*",
  "tool_search",
];

/** Membership lookup for the signal list above. */
const HOST_SIGNAL_LOOKUP = lookupTable(HOST_SIGNALS);

/** Valid `host skill-root --host` ids (engine HostId union — no drift). */
const HOST_IDS: readonly HostId[] = ["opencode", "omp", "pi", "dsh", "cursor", "codex", "kimi", "zcode"];

/** Membership lookup for the host ids above. */
const HOST_ID_LOOKUP = lookupTable(HOST_IDS);

const hostCommand = program
  .command("host")
  .description("host detection from session tool shapes (engine-backed)");

hostCommand
  .command("detect")
  .description(
    "Detect the active host from --signals (comma-separated tool-shape tokens): prints the host id or " +
      "'ambiguous' (exit 2 on usage)",
  )
  .option("--signals <list>", "Comma-separated tool-shape signals (e.g. question,ask,hub)")
  .action((options: { signals?: string }) => {
    try {
      if (!options.signals) throw new SddScriptError("usage: host detect --signals <comma-list>", 2);
      const signals = options.signals
        .split(",")
        .map((signal) => signal.trim())
        .filter((signal) => signal !== "");
      if (signals.length === 0) throw new SddScriptError("usage: host detect --signals <comma-list>", 2);
      for (const signal of signals) {
        if (HOST_SIGNAL_LOOKUP[signal] !== true) {
          throw new SddScriptError(`usage: host detect \u2014 unknown signal "${signal}" (valid: ${HOST_SIGNALS.join(", ")})`, 2);
        }
      }
      const result = detectHost(signals as ToolSignal[]);
      if (result === "ambiguous") {
        console.log(pc.yellow("host: ambiguous \u2014 apply the mstar-host detection table and prompt judgment"));
      } else {
        console.log(pc.green(`host: ${result}`));
      }
    } catch (error) {
      failScript(error, "host detect");
    }
  });

hostCommand
  .command("skill-root")
  .description(
    "Resolve the loaded skill root for a host (mstar-host \u00a7 Resolve loaded skill root): prints the canonical " +
      "skill-root string for --host / --skill (exit 1 on missing required options, 2 on usage errors)",
  )
  .requiredOption("--host <id>", "Host id (opencode | omp | pi | dsh | cursor | codex | kimi | zcode)")
  .requiredOption("--skill <name>", "Skill name to resolve")
  .option("--rel <path>", "Optional skill-relative path suffix")
  .action((options: { host: string; skill: string; rel?: string }) => {
    try {
      if (HOST_ID_LOOKUP[options.host] !== true) {
        throw new SddScriptError(`usage: host skill-root \u2014 unknown host "${options.host}" (valid: ${HOST_IDS.join(", ")})`, 2);
      }
      if (options.skill.trim() === "") {
        throw new SddScriptError("usage: host skill-root \u2014 --skill must be a non-empty skill name", 2);
      }
      const root = resolveSkillRoot(options.host as HostId, { skill: options.skill, rel: options.rel });
      if (options.host === "pi") {
        console.log(pc.yellow(root));
      } else {
        console.log(pc.green(root));
      }
    } catch (error) {
      failScript(error, "host skill-root");
    }
  });

const skillCommand = program
  .command("skill")
  .description("skill-authoring lints (engine-backed)");

skillCommand
  .command("lint")
  .description(
    "Lint <skill-dir>/SKILL.md: frontmatter contract (name lowercase-hyphen, description trigger contract) " +
      "+ the five-question body + ephemeral-citation scan (task-<digits>-* artifacts and .mstar/sdd/\u2026 deeplinks \u2014 " +
      "exit 1 on violations, 2 on usage)",
  )
  .argument("[skill-dir]", "Skill directory containing SKILL.md")
  .action((skillDir?: string) => {
    try {
      if (!skillDir) throw new SddScriptError("usage: skill lint <skill-dir>", 2);
      const skillFile = path.join(resolveCliPath(skillDir), "SKILL.md");
      if (!fs.existsSync(skillFile)) throw new Error(`SKILL.md not found: ${skillFile}`);
      const text = fs.readFileSync(skillFile, "utf8");
      const violations: ValidationResult[] = [];
      const frontmatter = lintFrontmatter(text);
      printChecklist("skill lint (frontmatter)", frontmatter);
      violations.push(...frontmatter.violations);
      // Five-question mode selection: runtime for shipped `mstar-*` topic
      // skills (locked alias table), authoring / strict for
      // `mstar-skill-authoring` (the standard's own definition) and for
      // non-`mstar-*` skills. `mstar-harness-core` is exempt by design
      // (hub headings) — print an explicit exempt row; frontmatter and
      // ephemeral-citation checks still run.
      const skillBase = path.basename(path.dirname(skillFile));
      const isCore = skillBase === "mstar-harness-core";
      const fiveQuestionMode: FiveQuestionMode =
        skillBase.startsWith("mstar-") && !isCore && skillBase !== "mstar-skill-authoring" ? "runtime" : "authoring";
      if (isCore) {
        console.log(pc.yellow("skill lint (five questions): EXEMPT \u2014 mstar-harness-core is exempt by design (hub headings)"));
      } else {
        const fiveQuestion = lintFiveQuestion(stripFrontmatter(text), fiveQuestionMode);
        printChecklist("skill lint (five questions)", fiveQuestion);
        violations.push(...fiveQuestion.violations);
      }
      // findEphemeralCitations is a discovery finder (array, no GateResult);
      // wrap into a GateResult like the other skill lint checklists — empty
      // array passes, each citation is one violation (codes
      // skill.ephemeral.<kind>, knowledge conventions §3).
      const ephemeral = findEphemeralCitations(text);
      const ephemeralGate: GateResult = {
        ok: ephemeral.length === 0,
        violations: ephemeral.map((citation) => ({
          ok: false,
          severity: "medium",
          code: `skill.ephemeral.${citation.kind}`,
          message: `ephemeral ${citation.kind} citation at line ${citation.line}: "${citation.match}" \u2014 task artifacts and SDD deeplinks survive nothing; durable skill text cites in-repo artifacts only (knowledge conventions/skill-content-porting-discipline.md \u00a73)`,
          fix: `rewrite "${citation.match}" as a placeholder form (e.g. task-N-report, <plan-id>, {SDD_DIR}/task-N-report.md) or cite a stable in-repo artifact instead`,
        })),
      };
      printChecklist("skill lint (ephemeral citations)", ephemeralGate);
      violations.push(...ephemeralGate.violations);
      if (violations.length > 0) process.exitCode = 1;
    } catch (error) {
      failScript(error, "skill lint");
    }
  });

const rolesCommand = program
  .command("roles")
  .description("mstar-roles mapping / load-order checks (engine-backed)");

rolesCommand
  .command("validate")
  .description(
    "Validate the mstar-roles skill-dir state: role mapping / parameter tables against the on-disk " +
      "references layout plus load-order declarations across sibling mstar-* skills " +
      "(exit 1 on violations)",
  )
  .option(
    "--roles-dir <dir>",
    "mstar-roles skill directory (default: skills/mstar-roles, resolved against the project root)",
  )
  .option("--skills-dir <dir>", "Skills root scanned for sibling mstar-* skills (default: parent of the roles dir)")
  .action((options: { rolesDir?: string; skillsDir?: string }) => {
    try {
      const rolesDir = resolveCliPath(options.rolesDir ?? "skills/mstar-roles");
      const skillsRoot = options.skillsDir ? resolveCliPath(options.skillsDir) : path.dirname(rolesDir);
      // Thin mirror of the dsh seam validateRolesState (packages/dsh/src/gates/seams.ts):
      // validateRoleMapping(rolesDir) + lintLoadOrder over sibling mstar-* SKILL.md
      // texts; unreadable siblings are skipped best-effort so a bad read can never
      // take the gate down.
      const violations: ValidationResult[] = [];
      const mapping = validateRoleMapping(rolesDir);
      printChecklist("roles validate (mapping)", mapping);
      violations.push(...mapping.violations);
      const skillTexts: Record<string, string> = {};
      for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("mstar-")) continue;
        const skillFile = path.join(skillsRoot, entry.name, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        try {
          skillTexts[entry.name] = fs.readFileSync(skillFile, "utf8");
        } catch {
          // skip unreadable sibling — the mapping checks still stand
        }
      }
      const loadOrder = lintLoadOrder(skillTexts);
      printChecklist("roles validate (load order)", loadOrder);
      violations.push(...loadOrder.violations);
      const total = violations.length;
      // Two distinct counts for the same corpus: siblings scanned (all
      // readable mstar-* dirs, incl. mstar-harness-core) vs skills actually
      // load-order-linted (core is exempt inside the engine) — keep the
      // labels distinct so 18-vs-17 is not misread as a discrepancy.
      const siblingCount = Object.keys(skillTexts).length;
      const loadOrderChecked = Object.keys(skillTexts).filter((name) => name !== "mstar-harness-core").length;
      const coreExempt = loadOrderChecked !== siblingCount;
      console.log(
        `roles validate: ${total === 0 ? "OK" : "FAIL"} (${total} violation${total === 1 ? "" : "s"}, ` +
          `${siblingCount} sibling skill${siblingCount === 1 ? "" : "s"} scanned; ` +
          `load-order over ${loadOrderChecked}${coreExempt ? ", core exempt" : ""})`,
      );
      if (total > 0) process.exitCode = 1;
    } catch (error) {
      failScript(error, "roles validate");
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(pc.red(`Setup failed: ${(error as Error).message}`));
  process.exitCode = 1;
});
