#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { select } from "@inquirer/prompts";
import pc from "picocolors";
import { Command } from "commander";
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

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(pc.red(`Setup failed: ${(error as Error).message}`));
  process.exit(1);
});
