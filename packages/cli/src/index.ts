#!/usr/bin/env node
import fs from "node:fs";
import cliManifest from "../package.json" with { type: "json" };
import engineManifest from "../../engine/package.json" with { type: "json" };
import { getCommandDefinitions } from "@mstar-harness/commands";
import { resolveProcessHarnessDir } from "@mstar-harness/engine";
import { Command, CommanderError, Option } from "commander";
import path from "node:path";
import pc from "picocolors";
import { getAdapter } from "./adapters";
import { buildModelAssignments } from "./assignment";
import { mapParserError, registerCliCommands } from "./command-adapter";
import { compareSemver } from "@mstar-harness/commands";
import { chooseCliVersion, detectPublishedLatest, ensureGlobalCli, formatVersionSkewWarning } from "./global-cli";
import type { InitOptions } from "./types";
import { parseCsv, readHarnessVersion, readJson, writeJson } from "./utils";
import { registerMcpCommand } from "./mcp/command";

const packageVersion = readHarnessVersion();
const reportSurfaceVersions = {
  engine: engineManifest.version,
  cli: cliManifest.version,
  plugin: null,
  host: null,
  platform: `${process.platform}/${process.arch}`,
};
const program = new Command();

function logStep(message: string) {
  console.log(pc.cyan(message));
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
  const target = options.target || "opencode";
  const adapter = getAdapter(target);
  const scope = options.scope ?? adapter.defaultScope ?? "project";
  if (!options.scope && adapter.defaultScope !== undefined && adapter.defaultScope !== "project") {
    console.log(pc.dim(`This target installs host-wide; using --scope ${adapter.defaultScope}.`));
  } else if (!options.scope && !options.yes) {
    console.log(pc.dim("Scope not provided; defaulting to project."));
  }
  if (adapter.mode === "install") {
    logStep("Step 2/2 - Run target install flow");
    // Resolve the version decision BEFORE mutating the host: the plugin the host
    // installs and the global CLI must end on the same version, and the operator
    // must see the pairing this run leaves behind.
    // --no-global-cli is a no-network opt-out: the probe exists only to inform
    // the global install, so it is skipped with it.
    const latest = options.dryRun || options.noGlobalCli ? null : detectPublishedLatest();
    const chosenCli = chooseCliVersion(packageVersion, latest);
    const installResult = await adapter.runInstallInit?.(scope, !!options.dryRun, {
      noFallbacks: options.noFallbacks,
      pluginVersion: chosenCli,
    });
    if (!installResult) throw new Error(`Adapter ${target} does not implement install init flow.`);
    console.log(pc.green(`Status: ${options.dryRun ? "ready (dry-run)" : "configured"} (${scope})`));
    console.log(`Target: ${target}`);
    console.log(`Install location: ${installResult.location}`);
    for (const note of installResult.notes) console.log(`  - ${note}`);
    const skew = formatVersionSkewWarning(packageVersion, latest);
    if (skew !== null) console.log(skew);
    const globalResult = ensureGlobalCli({
      version: packageVersion,
      latest,
      dryRun: !!options.dryRun,
      noGlobalCli: !!options.noGlobalCli,
    });
    const globalState = globalResult.action === "installed"
      ? `installed ${globalResult.spec}`
      : globalResult.action === "failed"
        ? `install FAILED for ${globalResult.spec} - the CLI on PATH was not updated`
        : globalResult.reason === "already-matching"
          ? "already matching"
          : globalResult.reason;
    // Only an adapter that installs a plugin can be reported at a version, and
    // that version is the one it actually installed (a linked tree carries the
    // checkout's version, not the one this run chose); the others register a
    // marketplace or write config and leave the plugin install to the operator.
    // An adapter that could not establish the installed version says so: the
    // version this run *chose* is not evidence of what is on disk.
    const installedPluginVersion = installResult.pluginVersion;
    console.log(
      adapter.installsPlugin === true
        ? `Plugin version: ${installedPluginVersion ?? "unconfirmed (the existing row was skipped and its manifest is unreadable)"}; global CLI: ${globalState}.`
        : `Global CLI: ${globalState}.`,
    );
    // Skew is refused whether or not the global update succeeded: a linked
    // checkout can lag the version this run selected even when the CLI install
    // worked, and the two must not be left apart.
    // Any verified difference is skew: a checkout ahead of the selected CLI is as
    // far apart as one behind it, so neither is reported as success.
    const pluginMismatched = installedPluginVersion !== undefined && installedPluginVersion !== chosenCli;
    // A failed update matters when it was meant to move the CLI forward: PATH
    // then stays on the running version instead of the one this run promised.
    // No plugin version enters this: an adapter that installs no plugin and
    // ignores initFlags never reports one, and that is no reason to report a
    // failed update as configured.
    const globalFailed = globalResult.action === "failed" && chosenCli !== packageVersion;
    if (pluginMismatched || globalFailed) {
      throw new Error(
        `The host plugin is at ${installedPluginVersion ?? "an unconfirmed version"}, while this run targets ${chosenCli}` +
          `${globalResult.action === "failed" ? ` and the global CLI could not be updated (${globalResult.spec}), so the CLI on PATH stays at ${packageVersion}` : ""}.\n` +
          `Recovery: realign the plugin (\`git -C ~/.mstar/harness pull --ff-only\` then re-run init, or install the published plugin at ${chosenCli}), ` +
          `or re-run with --no-global-cli to stay on the running version ${packageVersion}.`,
      );
    }
    console.log(`Next: npx @mstar-harness/cli doctor --target ${target}${scope === "project" ? "" : " --scope global"}`);
    return;
  }
  const useExplicitModels = hasExplicitModelFlags(options);
  const assignments = useExplicitModels ? resolveExplicitModelAssignments(options) : {};
  logStep(useExplicitModels
    ? "Step 3/4 - Apply explicit role model overrides from CLI flags"
    : "Step 3/4 - Fast setup (schema + plugin; OpenCode default models)");
  logStep("Step 4/4 - Update config");
  const generationOpts = { generation: options.opencodeGeneration, dryRun: !!options.dryRun };
  const configPath = adapter.resolveConfigPath?.(scope, options.output);
  if (!configPath) throw new Error(`Adapter ${target} does not implement config path resolution.`);
  try {
    const stat = fs.lstatSync(configPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Refusing to replace non-regular config path ${configPath}. Point the installer at a regular path or resolve the link intentionally.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const updated = await adapter.mutateConfigForInit?.(readJson(configPath), assignments, generationOpts);
  if (!updated) throw new Error(`Adapter ${target} does not implement init mutation.`);
  const checkErrors = adapter.validateConfig?.(updated, generationOpts) || [];
  if (checkErrors.length) throw new Error(`Configuration verification failed:\n- ${checkErrors.join("\n- ")}`);
  if (!options.dryRun) {
    writeJson(configPath, updated);
    const persistedErrors = adapter.validateConfig?.(readJson(configPath), generationOpts) || [];
    if (persistedErrors.length) throw new Error(`Post-write verification failed:\n- ${persistedErrors.join("\n- ")}`);
  }
  console.log(pc.green(`Status: ${options.dryRun ? "ready (dry-run)" : "configured"} (${scope})`));
  console.log(`Target: ${target}`);
  console.log(`Config file: ${configPath}`);
  if (adapter.printPostSetupSummary) adapter.printPostSetupSummary(updated);
  for (const [roleId, modelId] of Object.entries(assignments)) console.log(`  - ${roleId}: ${modelId}`);
  const latest = options.dryRun || options.noGlobalCli ? null : detectPublishedLatest();
  const skew = formatVersionSkewWarning(packageVersion, latest);
  if (skew !== null) console.log(skew);
  const globalResult = ensureGlobalCli({
    version: packageVersion,
    latest,
    dryRun: !!options.dryRun,
    noGlobalCli: !!options.noGlobalCli,
  });
  // The config-only path mutates no host plugin, but a failed global update still
  // leaves the newer CLI un-installed: report it as a failure, not as configured.
  const chosenCli = chooseCliVersion(packageVersion, latest);
  if (globalResult.action === "failed" && chosenCli !== packageVersion) {
    throw new Error(
      `The published CLI ${chosenCli} could not be installed globally (${globalResult.spec}); the CLI on PATH stays at ${packageVersion}.\n` +
        `Recovery: fix the global install (\`npm i -g @mstar-harness/cli@${chosenCli}\`), or re-run with --no-global-cli to stay on the running version ${packageVersion}.`,
    );
  }
}

program.name("mstar-harness").description("Morning Star harness CLI for target-based agent bootstrap").version(packageVersion);
program
  .command("init")
  .description("Interactive/non-interactive setup for target agent bootstrap")
  .option("-y, --yes", "Non-interactive mode")
  .option("--target <target>", "Install target", "opencode")
  .option("--scope <scope>", "Config scope: global|project (default: project, or the target's single supported scope)")
  .option("--output <path>", "Config file path override, relative to project root")
  .option("--dry-run", "Preview result without writing config")
  .option("--no-fallbacks", "Skip installing the dsh-llm-fallbacks plugin (dsh target only)")
  .option("--no-global-cli", "Skip installing the matching-version @mstar-harness/cli globally after init")
  .addOption(
    new Option(
      "--opencode-generation <generation>",
      "OpenCode config generation: v1|v2 (default: probe the installed opencode version on real installs; config markers under --dry-run)",
    ).choices(["v1", "v2"]),
  )
  .option("--pm-model <model>", "Optional: model for project-manager (advanced override)")
  .option("--strategic-models <a,b,c>", "Optional: models for architect/product-manager/prompt-engineer")
  .option("--dev-models <a,b,c>", "Optional: models for fullstack-dev/fullstack-dev-2/frontend-dev")
  .option("--qc-models <a,b,c>", "Optional: models for qc trio")
  .option("--other-models <a,b,c>", "Optional: models for remaining roles")
  .action(async (options: InitOptions & { fallbacks?: boolean; globalCli?: boolean }) => {
    await runInit({ ...options, noFallbacks: options.fallbacks === false, noGlobalCli: options.globalCli === false });
  });

// Relative path arguments of the dev commands resolve against the project
// root (audit-002 F-S2), which a caller may pin with MSTAR_CLI_PROJECT_ROOT;
// otherwise the invocation directory stays the base.
const invocationCwd = process.env.MSTAR_CLI_PROJECT_ROOT === undefined || process.env.MSTAR_CLI_PROJECT_ROOT === ""
  ? process.cwd()
  : path.resolve(process.env.MSTAR_CLI_PROJECT_ROOT);

registerCliCommands(program, getCommandDefinitions(), {
  cwd: invocationCwd,
  controlRoot: resolveProcessHarnessDir(invocationCwd),
  versions: reportSurfaceVersions,
  signal: new AbortController().signal,
  effects: {
    async readInput() { return ""; },
    async spawn() { throw new Error("process effect is supplied per invocation"); },
    async startDashboard() { throw new Error("service effect is supplied per invocation"); },
    async openBrowser() { throw new Error("browser effect is supplied per invocation"); },
  },
});
registerMcpCommand(program);

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
