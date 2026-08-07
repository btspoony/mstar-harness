#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { select } from "@inquirer/prompts";
import pc from "picocolors";
import { Command } from "commander";
import {
  archiveResiduals,
  evaluatePhaseGate,
  pushCadenceProbe,
  resolveHarnessDir,
  resolveSpecsDir,
  reviewPackage,
  SddScriptError,
  sddWorkspace,
  taskBrief,
  validateStatus,
  type GateResult,
} from "@mstar-harness/engine";
import { parseCompassFrontmatter } from "./compass";
import { verifyPlanExecutionLease } from "./lease-verify";
import { validateAgentPlugin } from "./agent-plugins";
import { buildModelAssignments } from "./assignment";
import { getAdapter } from "./adapters";
import type { DoctorOptions, InitOptions, PluginValidateOptions, Target } from "./types";
import { SUPPORTED_TARGETS } from "./types";
import { parseCsv, readJson, writeJson, readHarnessVersion, resolveProjectRoot } from "./utils";

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
    const installResult = adapter.runInstallInit?.(scope, !!options.dryRun);
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
  .option("--pm-model <model>", "Optional: model for project-manager (advanced override)")
  .option("--strategic-models <a,b,c>", "Optional: models for architect/product-manager/prompt-engineer")
  .option("--dev-models <a,b,c>", "Optional: models for fullstack-dev/fullstack-dev-2/frontend-dev")
  .option("--qc-models <a,b,c>", "Optional: models for qc trio")
  .option("--other-models <a,b,c>", "Optional: models for remaining roles")
  .action(async (options: InitOptions) => {
    await runInit(options);
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
  .description("Resolve {HARNESS_DIR} + {SPECS_DIR} from a start dir (exit 1 when no harness dir resolves)")
  .argument("[path]", "Start dir to resolve from (default: cwd)")
  .option("--json", "Machine-readable JSON output (ok, harnessDir, specsDir, guidance on failure)")
  .action((pathArg: string | undefined, options: { json?: boolean }) => {
    const startDir = pathArg ? path.resolve(pathArg) : process.cwd();
    const harnessDir = resolveHarnessDir(startDir);
    if (!harnessDir) {
      // plan-conventions § {HARNESS_DIR} 解析顺序: no .mstar/ → .agents/ →
      // .plans/|plans/ anywhere up the tree — harness not enabled from here.
      const guidance =
        "no harness dir found (probed .mstar/, .agents/, .plans/, plans/ walking up from " +
        `${startDir}) — run \`mstar init\` to bootstrap, or pass a start dir inside a harness-enabled project`;
      if (options.json) {
        console.log(JSON.stringify({ ok: false, startDir, harnessDir: null, specsDir: null, guidance }));
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
    if (options.json) {
      console.log(JSON.stringify({ ok: true, startDir, harnessDir, specsDir }));
    } else {
      console.log(pc.green(`harness dir: ${harnessDir}`));
      console.log(pc.green(`specs dir:   ${specsDir}`));
    }
  });

const statusCommand = program
  .command("status")
  .description("status.json schema + residual lifecycle checks (engine-backed)");

/** Resolve the status.json path: explicit arg wins, else the resolved {HARNESS_DIR}. */
function resolveStatusFilePath(pathArg?: string): string {
  if (pathArg) return path.resolve(pathArg);
  const harnessDir = resolveHarnessDir();
  if (!harnessDir) {
    throw new Error(`harness dir not found from ${process.cwd()} — pass a status.json path or set MSTAR_HARNESS_DIR`);
  }
  return path.join(harnessDir, "status.json");
}

statusCommand
  .command("validate")
  .description("Validate status.json (schema, severity enum, root-only residual_findings)")
  .argument("[path]", "status.json path (default: {HARNESS_DIR}/status.json)")
  .action((pathArg?: string) => {
    let statusPath: string;
    try {
      statusPath = resolveStatusFilePath(pathArg);
      if (!fs.existsSync(statusPath)) {
        throw new Error(`status file not found: ${statusPath}`);
      }
      const gate = validateStatus(statusPath);
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
  .command("archive-residuals")
  .description("Archive a plan's open residuals to archived/residuals/<plan-id>.json")
  .argument("<plan-id>", "Plan id whose open residuals are archived")
  .option("--harness <path>", "Harness dir override (default: resolved {HARNESS_DIR})")
  .action(async (planId: string, options: { harness?: string }) => {
    try {
      const harnessDir = options.harness ?? resolveHarnessDir();
      if (!harnessDir) {
        throw new Error(`harness dir not found from ${process.cwd()} — pass --harness or set MSTAR_HARNESS_DIR`);
      }
      const result = await archiveResiduals(planId, harnessDir);
      if (result.archived === 0) {
        console.log(pc.yellow(`No open residuals for plan ${planId}`));
      } else {
        console.log(pc.green(`Archived ${result.archived} residual(s) for ${planId} -> ${result.archivePath}`));
      }
    } catch (error) {
      console.error(pc.red(`archive-residuals failed: ${(error as Error).message}`));
      process.exitCode = 1;
    }
  });

const leaseCommand = program
  .command("lease")
  .description("execution_lease checks (engine-backed) — integration_merge_lease validation stays import-only via @mstar-harness/engine until a dedicated subcommand exists");

/** Resolve the harness dir for lease commands: --harness wins, else {HARNESS_DIR} resolution. */
function resolveLeaseHarnessDir(harnessArg?: string): string {
  if (harnessArg) return path.resolve(harnessArg);
  const harnessDir = resolveHarnessDir();
  if (!harnessDir) {
    throw new Error(`harness dir not found from ${process.cwd()} — pass --harness or set MSTAR_HARNESS_DIR`);
  }
  return harnessDir;
}

leaseCommand
  .command("verify")
  .description("Verify a plan's execution_lease (missing/invalid/non-SSOT location → exit 1 with violations)")
  .argument("<plan-id>", "Plan id whose execution_lease is verified")
  .option("--harness <path>", "Harness dir override (default: resolved {HARNESS_DIR})")
  .action((planId: string, options: { harness?: string }) => {
    try {
      const harnessDir = resolveLeaseHarnessDir(options.harness);
      const statusPath = path.join(harnessDir, "status.json");
      if (!fs.existsSync(statusPath)) {
        throw new Error(`status file not found: ${statusPath}`);
      }
      const doc = readJson(statusPath);
      const plans = Array.isArray(doc.plans) ? (doc.plans as Array<Record<string, unknown>>) : [];
      const matches = plans.filter((row) => row?.id === planId || row?.plan_id === planId);
      if (matches.length === 0) {
        console.error(pc.red(`${statusPath}: FAIL plan ${planId}`));
        console.error(`  - [high] lease.verify.plan-not-found: no plan row with id/plan_id ${planId}`);
        process.exitCode = 1;
        return;
      }
      if (matches.length > 1) {
        console.error(pc.red(`${statusPath}: FAIL plan ${planId}`));
        console.error("  - [high] lease.verify.ambiguous: multiple plan rows match (id and plan_id both present)");
        process.exitCode = 1;
        return;
      }
      // SSOT-location rules live in lease-verify.ts (pure, tested): row-level
      // plans[].execution_lease is SSOT; metadata-only / dual-write are
      // violations, never equivalent to SSOT success.
      const result = verifyPlanExecutionLease(matches[0], planId);
      if (result.ok) {
        const holder = String((result.lease as Record<string, unknown>).holder ?? "");
        console.log(pc.green(`${statusPath}: OK plan ${planId} — execution_lease valid (holder ${holder})`));
        return;
      }
      const count = result.violations.length;
      console.error(pc.red(`${statusPath}: FAIL plan ${planId} (${count} violation${count === 1 ? "" : "s"})`));
      for (const violation of result.violations) {
        console.error(`  - [${violation.severity}] ${violation.code}: ${violation.message}`);
        if (violation.fix) console.error(`    fix: ${violation.fix}`);
      }
      process.exitCode = 1;
    } catch (error) {
      console.error(pc.red(`lease verify failed: ${(error as Error).message}`));
      process.exitCode = 1;
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
  .description("SDD workspace / task-brief / review-package helpers (engine-backed, bash parity)");

sddCommand
  .command("workspace")
  .description("Resolve and ensure {SDD_DIR} for a plan (exit 1 on resolution failures, 2 on usage errors)")
  .argument("<plan-id>", "Plan id whose SDD dir is resolved/created")
  .argument("[control-root]", "Control worktree root (default: MSTAR_CONTROL_ROOT or the cwd's git top-level)")
  .action((planId: string, controlRoot?: string) => {
    try {
      const sddDir = sddWorkspace(planId, controlRoot ? { controlRoot } : {});
      console.log(pc.green(`sdd dir: ${sddDir}`));
    } catch (error) {
      failScript(error, "sdd workspace");
    }
  });

sddCommand
  .command("task-brief")
  .description("Extract the `## Task N` section of a plan into a brief file (exit 3 when task N is missing)")
  .argument("<plan-file>", "Plan markdown file")
  .argument("<task-number>", "Task number whose brief is extracted")
  .argument("[outfile]", "Output file (default: {SDD_DIR}/task-N-brief.md)")
  .action((planFile: string, taskNumber: string, outfile?: string) => {
    try {
      const out = taskBrief(planFile, Number(taskNumber), outfile);
      console.log(pc.green(`task ${taskNumber} brief: ${out}`));
    } catch (error) {
      failScript(error, "sdd task-brief");
    }
  });

sddCommand
  .command("review-package")
  .description("Write commits + stat + diff -U10 for BASE..HEAD into a review file (exit 2 on bad refs)")
  .argument("<base>", "Base ref (commit SHA)")
  .argument("<head>", "Head ref (commit SHA)")
  .argument("[outfile]", "Output file (default: {SDD_DIR}/review-<short-base>..<short-head>.diff)")
  .action((base: string, head: string, outfile?: string) => {
    try {
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
      "plus the §3.1 entry and §3.5 exit checklists (exit 1 when the gate verdict fails)",
  )
  .requiredOption("--status <path>", "status.json path")
  .requiredOption("--compass <path>", "delivery-compass.md path")
  .option("--branch <branch>", "Current branch probe (exit §3.5 item 5)")
  .option("--integration <branch>", "Spec integration branch probe (exit §3.5 item 5)")
  .option("--target <branch>", "PR base branch probe (exit §3.5 item 6)")
  .action((options: { status: string; compass: string; branch?: string; integration?: string; target?: string }) => {
    try {
      const statusPath = path.resolve(options.status);
      const compassPath = path.resolve(options.compass);
      if (!fs.existsSync(statusPath)) throw new Error(`status file not found: ${statusPath}`);
      if (!fs.existsSync(compassPath)) throw new Error(`compass file not found: ${compassPath}`);
      const result = evaluatePhaseGate(readJson(statusPath), parseCompassFrontmatter(compassPath), {
        currentBranch: options.branch,
        specIntegrationBranch: options.integration,
        prBaseBranch: options.target,
      });
      console.log(`transition: ${result.transition}`);
      printChecklist("entry (close §3.1)", result.entry);
      printChecklist("exit (close §3.5)", result.exit);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      console.error(pc.red(`iteration gate failed: ${(error as Error).message}`));
      process.exitCode = 1;
    }
  });

iterationCommand
  .command("push-cadence")
  .description("§5.1a push-cadence probe: never push while CI or an AI review wave is running (exit 1 when blocked)")
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

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(pc.red(`Setup failed: ${(error as Error).message}`));
  process.exitCode = 1;
});
