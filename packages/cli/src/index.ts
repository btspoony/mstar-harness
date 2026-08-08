#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { select } from "@inquirer/prompts";
import pc from "picocolors";
import { Command } from "commander";
import {
  archiveResiduals,
  assertDefaultBranchProtected,
  assertTriIdentity,
  evaluatePhaseGate,
  executionModeToN,
  isReadOnlyAssignmentRole,
  l1PreDispatchCheck,
  l2PreDispatchCheck,
  parseAssignmentBranchForms,
  parseAssignmentFields,
  parseBranchPolicyDirectOnBranch,
  pushCadenceProbe,
  resolveHarnessDir,
  resolveSpecsDir,
  reviewPackage,
  SddScriptError,
  sddWorkspace,
  taskBrief,
  validateAssignmentFields,
  validateStatus,
  type GateResult,
  type L1PreDispatchInput,
  type WorktreeTrack,
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
  .argument("[plan-id]", "Plan id whose SDD dir is resolved/created")
  .argument("[control-root]", "Control worktree root (default: MSTAR_CONTROL_ROOT or the cwd's git top-level)")
  .action((planId: string | undefined, controlRoot?: string) => {
    try {
      // Optional args + explicit count check: commander's own
      // missing-argument error exits 1, which would bypass the bash-parity
      // usage contract (exit 2) — validate in-handler instead (qc2 F-005).
      if (!planId) {
        throw new SddScriptError(
          "usage: sdd-workspace PLAN_ID [CONTROL_ROOT]\n" +
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
      // Optional args + explicit count check (bash-parity usage exit 2).
      if (!planFile || !taskNumber) {
        throw new SddScriptError("usage: task-brief PLAN_FILE TASK_NUMBER [OUTFILE]", 2);
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
      // Optional args + explicit count check (bash-parity usage exit 2).
      if (!base || !head) {
        throw new SddScriptError("usage: review-package BASE HEAD [OUTFILE]", 2);
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
      "plus the §3.1 entry and §3.5 exit checklists. Exit 1 when the gate verdict fails — during the Phase-3 window " +
      "(transition: phase-3-close) exit 1 is EXPECTED until the §3.4 close items (status: completed + end_date) are " +
      "written: the exit checklist gates Phase 4, not the Phase-3 entry (qc2 F-003)",
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
      const file = path.resolve(assignmentFile);
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
    throw new SddScriptError("usage: worktree check --l2 --tracks <json> — invalid JSON", 2);
  }
  if (!Array.isArray(parsed)) {
    throw new SddScriptError(
      "usage: worktree check --l2 --tracks <json> — expected a JSON array of {worktreePath, workingBranch}",
      2,
    );
  }
  const tracks: WorktreeTrack[] = [];
  for (const item of parsed) {
    const record = item as { worktreePath?: unknown; workingBranch?: unknown } | null;
    if (record === null || typeof record !== "object" || typeof record.worktreePath !== "string" || typeof record.workingBranch !== "string") {
      throw new SddScriptError(
        "usage: worktree check --l2 --tracks <json> — every track needs string worktreePath + workingBranch",
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
    "L1: verify the plan's execution_lease worktree vs control path (isolation, existence, branch alignment) from " +
      "status.json; --l2: verify parallel writable tracks (exit 1 on violations, 2 on usage)",
  )
  .argument("[plan-id]", "Plan id whose execution_lease drives the L1 input (alternative to --plan)")
  .option("--plan <plan-id>", "Plan id whose execution_lease drives the L1 input")
  .option("--status <path>", "status.json path override (default: {HARNESS_DIR}/status.json)")
  .option("--control <path>", "Control worktree path override (default: status.json metadata.control_worktree_path)")
  .option("--l2", "Run the L2 within-plan check (parallel writable tracks) instead of L1")
  .option(
    "--tracks <json>",
    'L2 tracks JSON: [{"worktreePath": "/abs/path", "workingBranch": "feature/x"}] (required with --l2)',
  )
  .action(
    (
      planId: string | undefined,
      options: { plan?: string; status?: string; control?: string; l2?: boolean; tracks?: string },
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
          throw new SddScriptError("usage: worktree check <plan-id> [--status <path>] [--control <path>] (or --plan <plan-id>)", 2);
        }
        const statusPath = options.status ? path.resolve(options.status) : resolveStatusFilePath();
        if (!fs.existsSync(statusPath)) {
          throw new Error(`status file not found: ${statusPath}`);
        }
        const doc = readJson(statusPath);
        const plans = Array.isArray(doc.plans) ? (doc.plans as Array<Record<string, unknown>>) : [];
        const matches = plans.filter((row) => row?.id === plan || row?.plan_id === plan);
        if (matches.length === 0) {
          console.error(pc.red(`${statusPath}: FAIL plan ${plan}`));
          console.error(`  - [high] worktree.l1.plan-not-found: no plan row with id/plan_id ${plan}`);
          process.exitCode = 1;
          return;
        }
        if (matches.length > 1) {
          console.error(pc.red(`${statusPath}: FAIL plan ${plan}`));
          console.error("  - [high] worktree.l1.ambiguous: multiple plan rows match (id and plan_id both present)");
          process.exitCode = 1;
          return;
        }
        const row = matches[0]!;
        const lease = (row.execution_lease ?? {}) as Record<string, unknown>;
        const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
        const input: L1PreDispatchInput = {
          controlWorktreePath: options.control ? path.resolve(options.control) : String(metadata.control_worktree_path ?? ""),
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

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(pc.red(`Setup failed: ${(error as Error).message}`));
  process.exitCode = 1;
});
