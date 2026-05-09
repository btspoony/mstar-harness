#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkbox, select } from "@inquirer/prompts";
import pc from "picocolors";
import { Command } from "commander";
import { buildModelAssignments, requireValidatedSelection } from "./assignment";
import { getAdapter } from "./adapters";
import type { DoctorOptions, InitOptions, ModelSelections, Scope, Target } from "./types";
import { SUPPORTED_TARGETS } from "./types";
import { parseCsv, readJson, writeJson } from "./utils";

const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
const packageVersion = (() => {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string };
    return parsed.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

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

async function pickModelsInteractive(params: {
  title: string;
  hint: string;
  models: string[];
  maxCount: number;
  single?: boolean;
}) {
  const choices = params.models.map((model) => ({ name: model, value: model }));
  if (params.single) {
    const picked = await select<string>({ message: `${params.title} (${params.hint})`, choices });
    return [picked];
  }
  return checkbox<string>({
    message: `${params.title} (${params.hint})`,
    choices,
    validate: (picked) => {
      if (picked.length < 1) return "Pick at least one model.";
      if (picked.length > params.maxCount) return `Pick at most ${params.maxCount} models.`;
      return true;
    },
  });
}

async function resolveSelections(options: InitOptions, models: string[]) {
  if (options.yes) {
    return {
      pm: requireValidatedSelection("pm-model", options.pmModel ? [options.pmModel] : undefined, models, 1, true),
      strategic: requireValidatedSelection("strategic-models", parseCsv(options.strategicModels), models, 3),
      dev: requireValidatedSelection("dev-models", parseCsv(options.devModels), models, 3),
      qc: requireValidatedSelection("qc-models", parseCsv(options.qcModels), models, 3),
      others: requireValidatedSelection("other-models", parseCsv(options.otherModels), models, 3),
    } satisfies ModelSelections;
  }

  logStep("Step 4/7 - Configure models by role group");
  return {
    pm: await pickModelsInteractive({
      title: "1) project-manager",
      hint: "orchestrator role, prefer strong agentic model",
      models,
      maxCount: 1,
      single: true,
    }),
    strategic: await pickModelsInteractive({
      title: "2) architect / product-manager / prompt-engineer",
      hint: "decision-heavy roles, prefer high intelligence",
      models,
      maxCount: 3,
    }),
    dev: await pickModelsInteractive({
      title: "3) fullstack-dev / fullstack-dev-2 / frontend-dev",
      hint: "prefer coding-focused models",
      models,
      maxCount: 3,
    }),
    qc: await pickModelsInteractive({
      title: "4) qc-specialist / qc-specialist-2 / qc-specialist-3",
      hint: "prefer three distinct models",
      models,
      maxCount: 3,
    }),
    others: await pickModelsInteractive({
      title: "5) other roles",
      hint: "up to 3 models, random assignment",
      models,
      maxCount: 3,
    }),
  } satisfies ModelSelections;
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

  logStep(`Step 3/7 - Fetch available models from ${adapter.target}`);
  const models = adapter.getAvailableModels?.();
  if (!models) throw new Error(`Adapter ${target} does not implement model discovery.`);
  const selections = await resolveSelections(options, models);

  logStep("Step 5/7 - Build role model assignments");
  const assignments = buildModelAssignments(selections);

  logStep("Step 6/7 - Update config");
  const configPath = adapter.resolveConfigPath?.(scope, options.output);
  if (!configPath) throw new Error(`Adapter ${target} does not implement config path resolution.`);
  const current = readJson(configPath);
  const updated = adapter.mutateConfigForInit?.(current, assignments);
  if (!updated) throw new Error(`Adapter ${target} does not implement init mutation.`);

  logStep("Step 7/7 - Self-check");
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
  console.log("Assigned roles:");
  for (const [roleId, modelId] of Object.entries(assignments)) {
    console.log(`  - ${roleId}: ${modelId}`);
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
  .option("--pm-model <model>", "Model for project-manager")
  .option("--strategic-models <a,b,c>", "Models for architect/product-manager/prompt-engineer")
  .option("--dev-models <a,b,c>", "Models for fullstack-dev/fullstack-dev-2/frontend-dev")
  .option("--qc-models <a,b,c>", "Models for qc trio")
  .option("--other-models <a,b,c>", "Models for random assignment to remaining roles")
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

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(pc.red(`Setup failed: ${(error as Error).message}`));
  process.exit(1);
});
