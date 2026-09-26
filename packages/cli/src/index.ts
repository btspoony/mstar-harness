#!/usr/bin/env bun
import { select } from "@inquirer/prompts";
import { getCommandDefinitions } from "@mstar-harness/commands";
import { resolveProcessHarnessDir } from "@mstar-harness/engine";
import { Command, CommanderError } from "commander";
import pc from "picocolors";
import { getAdapter } from "./adapters";
import { buildModelAssignments } from "./assignment";
import { mapParserError, registerCliCommands } from "./command-adapter";
import { ensureGlobalCli } from "./global-cli";
import type { InitOptions, Target } from "./types";
import { SUPPORTED_TARGETS } from "./types";
import { parseCsv, readHarnessVersion, readJson, writeJson } from "./utils";

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
  return Boolean(options.pmModel || options.strategicModels || options.devModels || options.qcModels || options.otherModels);
}

/** Advanced override only — never calls `opencode models` (avoids silent hangs). */
function resolveExplicitModelAssignments(options: InitOptions) {
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
  if (!options.scope && !options.yes) console.log(pc.dim("Scope not provided; defaulting to project."));
  if (adapter.mode === "install") {
    logStep("Step 2/2 - Run target install flow");
    const installResult = adapter.runInstallInit?.(scope, !!options.dryRun, { noFallbacks: options.noFallbacks });
    if (!installResult) throw new Error(`Adapter ${target} does not implement install init flow.`);
    console.log(pc.green(`Status: ${options.dryRun ? "ready (dry-run)" : "configured"} (${scope})`));
    console.log(`Target: ${target}`);
    console.log(`Install location: ${installResult.location}`);
    for (const note of installResult.notes) console.log(`  - ${note}`);
    ensureGlobalCli({ version: packageVersion, dryRun: !!options.dryRun, noGlobalCli: !!options.noGlobalCli });
    return;
  }
  const useExplicitModels = hasExplicitModelFlags(options);
  const assignments = useExplicitModels ? resolveExplicitModelAssignments(options) : {};
  logStep(useExplicitModels
    ? "Step 3/4 - Apply explicit role model overrides from CLI flags"
    : "Step 3/4 - Fast setup (schema + plugin; OpenCode default models)");
  logStep("Step 4/4 - Update config");
  const configPath = adapter.resolveConfigPath?.(scope, options.output);
  if (!configPath) throw new Error(`Adapter ${target} does not implement config path resolution.`);
  const updated = adapter.mutateConfigForInit?.(readJson(configPath), assignments);
  if (!updated) throw new Error(`Adapter ${target} does not implement init mutation.`);
  const checkErrors = adapter.validateConfig?.(updated) || [];
  if (checkErrors.length) throw new Error(`Configuration verification failed:\n- ${checkErrors.join("\n- ")}`);
  if (!options.dryRun) {
    writeJson(configPath, updated);
    const persistedErrors = adapter.validateConfig?.(readJson(configPath)) || [];
    if (persistedErrors.length) throw new Error(`Post-write verification failed:\n- ${persistedErrors.join("\n- ")}`);
  }
  console.log(pc.green(`Status: ${options.dryRun ? "ready (dry-run)" : "configured"} (${scope})`));
  console.log(`Target: ${target}`);
  console.log(`Config file: ${configPath}`);
  if (adapter.printPostSetupSummary) adapter.printPostSetupSummary(updated);
  for (const [roleId, modelId] of Object.entries(assignments)) console.log(`  - ${roleId}: ${modelId}`);
  ensureGlobalCli({ version: packageVersion, dryRun: !!options.dryRun, noGlobalCli: !!options.noGlobalCli });
}

program.name("mstar-harness").description("Morning Star harness CLI for target-based agent bootstrap").version(packageVersion);
program
  .command("init")
  .description("Interactive/non-interactive setup for target agent bootstrap")
  .option("-y, --yes", "Non-interactive mode")
  .option("--target <target>", "Install target", "opencode")
  .option("--scope <scope>", "Config scope: global|project (default: project)")
  .option("--output <path>", "Config file path override, relative to project root")
  .option("--dry-run", "Preview result without writing config")
  .option("--no-fallbacks", "Skip installing the dsh-llm-fallbacks plugin (dsh target only)")
  .option("--no-global-cli", "Skip installing the matching-version @mstar-harness/cli globally after init")
  .option("--pm-model <model>", "Optional: model for project-manager (advanced override)")
  .option("--strategic-models <a,b,c>", "Optional: models for architect/product-manager/prompt-engineer")
  .option("--dev-models <a,b,c>", "Optional: models for fullstack-dev/fullstack-dev-2/frontend-dev")
  .option("--qc-models <a,b,c>", "Optional: models for qc trio")
  .option("--other-models <a,b,c>", "Optional: models for remaining roles")
  .action(async (options: InitOptions & { fallbacks?: boolean; globalCli?: boolean }) => {
    await runInit({ ...options, noFallbacks: options.fallbacks === false, noGlobalCli: options.globalCli === false });
  });

registerCliCommands(program, getCommandDefinitions(), {
  cwd: process.cwd(),
  controlRoot: resolveProcessHarnessDir(process.cwd()),
  versions: { engine: packageVersion, cli: packageVersion, plugin: null, host: null, platform: `${process.platform}/${process.arch}` },
  signal: new AbortController().signal,
  effects: {
    async readInput() { return ""; },
    async spawn() { throw new Error("process effect is supplied per invocation"); },
    async startDashboard() { throw new Error("service effect is supplied per invocation"); },
    async openBrowser() { throw new Error("browser effect is supplied per invocation"); },
  },
});

program.parseAsync(process.argv).catch((error: unknown) => {
  const usage = mapParserError(error, process.argv);
  if (usage !== null) {
    console.log(JSON.stringify(usage));
    process.exitCode = usage.exitCode;
    return;
  }
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
    return;
  }
  console.error(pc.red(`Setup failed: ${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
});
