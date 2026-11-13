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
import {
  chooseCliVersion,
  detectPublishedLatest,
  ensureGlobalCli,
  formatVersionSkewWarning,
  type EnsureGlobalCliResult,
} from "./global-cli";
import { SUPPORTED_TARGETS, type InitOptions } from "./types";
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
  // Presence is the option being supplied, not its truthiness: `--dev-models ""`
  // asked for an override and must not read as "no flag given".
  return options.pmModel !== undefined || options.strategicModels !== undefined || options.devModels !== undefined
    || options.qcModels !== undefined || options.otherModels !== undefined;
}

/** Model ids from one override flag; `undefined` means the flag was absent. */
function modelFlagValues(raw: string | undefined, csv: boolean): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!csv) return [raw.trim()].filter(Boolean);
  return parseCsv(raw) ?? [];
}

/** Advanced override only — never calls `opencode models` (avoids silent hangs). */
function resolveExplicitModelAssignments(options: InitOptions): Record<string, string> {
  // Each flag stands on its own: an absent group writes nothing, a present flag
  // that names no model is refused with the same sentence whatever its shape.
  const allow = (label: string, values: string[] | undefined, max: number) => {
    if (values === undefined) return [] as string[];
    if (values.length === 0) throw new Error(`${label}: the supplied value names no model.`);
    if (values.length > max) throw new Error(`${label}: pick at most ${max} model(s).`);
    return values;
  };
  return buildModelAssignments({
    pm: allow("pm-model", modelFlagValues(options.pmModel, false), 1),
    strategic: allow("strategic-models", modelFlagValues(options.strategicModels, true), 3),
    dev: allow("dev-models", modelFlagValues(options.devModels, true), 3),
    qc: allow("qc-models", modelFlagValues(options.qcModels, true), 3),
    others: allow("other-models", modelFlagValues(options.otherModels, true), 3),
  });
}

type AlignCliAndPluginInput = {
  packageVersion: string;
  dryRun: boolean;
  noGlobalCli: boolean;
  /** Only an adapter that installed a plugin can be at a version. */
  installedPluginVersion?: string;
  /** Already-probed published latest: an install-mode run probes it before it
   *  mutates the host and must not probe twice. Omitted here means "probe now". */
  latest?: string | null;
};

type AlignCliAndPluginResult = {
  latest: string | null;
  chosen: string;
  globalResult: EnsureGlobalCliResult;
  /** The shared refusal sentence, when the run left the two apart. */
  failure: { message: string } | null;
};

/**
 * The one version-alignment tail both init modes run: resolve the published
 * latest, install the matching global CLI, and name every way the plugin and
 * the CLI on PATH end apart. Each mode prints its own status lines and decides
 * when to throw; the refusal sentence has one owner here.
 */
function alignCliAndPlugin(input: AlignCliAndPluginInput): AlignCliAndPluginResult {
  const { packageVersion, installedPluginVersion } = input;
  // --no-global-cli is a no-network opt-out: the probe exists only to inform the
  // global install, so it is skipped with it.
  const latest = input.latest !== undefined
    ? input.latest
    : input.dryRun || input.noGlobalCli ? null : detectPublishedLatest();
  const chosen = chooseCliVersion(packageVersion, latest);
  const globalResult = ensureGlobalCli({
    version: packageVersion,
    latest,
    dryRun: input.dryRun,
    noGlobalCli: input.noGlobalCli,
  });
  // Skew is refused whether or not the global update succeeded: a linked
  // checkout can lag the version this run selected even when the CLI install
  // worked, and a checkout ahead of it is as far apart as one behind it.
  const pluginMismatched = installedPluginVersion !== undefined && installedPluginVersion !== chosen;
  // A failed update matters only when it was meant to move the CLI forward:
  // PATH then stays on the running version instead of the one this run promised.
  const globalFailed = globalResult.action === "failed" && chosen !== packageVersion;
  if (!pluginMismatched && !globalFailed) return { latest, chosen, globalResult, failure: null };
  // Each refusal states the cause that actually happened and the route that
  // repairs it; either can be sidestepped on the running version.
  const causes = [
    ...(pluginMismatched ? [`The host plugin is at ${installedPluginVersion}, while this run targets ${chosen}.`] : []),
    ...(globalFailed ? [`The global install of ${globalResult.spec} failed, so the CLI on PATH stays at ${packageVersion}.`] : []),
  ];
  const recoveries = [
    ...(pluginMismatched ? [`realign the plugin (\`git -C ~/.mstar/harness pull --ff-only\` then re-run init, or install the published plugin at ${chosen})`] : []),
    ...(globalFailed ? [`fix the global install (\`npm i -g @mstar-harness/cli@${chosen}\`)`] : []),
  ];
  return {
    latest,
    chosen,
    globalResult,
    failure: {
      message: `${causes.join(" ")}\n`
        + `Recovery: ${recoveries.join(", or ")}, or re-run with --no-global-cli to stay on the running version ${packageVersion}.`,
    },
  };
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
    const alignment = alignCliAndPlugin({
      packageVersion,
      dryRun: !!options.dryRun,
      noGlobalCli: !!options.noGlobalCli,
      latest,
      // Only an adapter that installs a plugin can be reported at a version, and
      // that version is the one it actually installed (a linked tree carries the
      // checkout's version, not the one this run chose); the others register a
      // marketplace or write config and leave the plugin install to the operator.
      // An adapter that could not establish the installed version says so: the
      // version this run *chose* is not evidence of what is on disk.
      ...(installResult.pluginVersion === undefined ? {} : { installedPluginVersion: installResult.pluginVersion }),
    });
    const skew = formatVersionSkewWarning(packageVersion, alignment.latest);
    if (skew !== null) console.log(skew);
    const globalResult = alignment.globalResult;
    const globalState = globalResult.action === "installed"
      ? `installed ${globalResult.spec}`
      : globalResult.action === "failed"
        ? `install FAILED for ${globalResult.spec} - the CLI on PATH was not updated`
        : globalResult.reason === "already-matching"
          ? "already matching"
          : globalResult.reason;
    console.log(
      adapter.installsPlugin === true
        ? `Plugin version: ${installResult.pluginVersion ?? "unconfirmed (the existing row was skipped and its manifest is unreadable)"}; global CLI: ${globalState}.`
        : `Global CLI: ${globalState}.`,
    );
    if (alignment.failure !== null) throw new Error(alignment.failure.message);
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
  // The config-only path mutates no host plugin, but a failed global update still
  // leaves the newer CLI un-installed: the shared tail reports it as a failure.
  const alignment = alignCliAndPlugin({
    packageVersion,
    dryRun: !!options.dryRun,
    noGlobalCli: !!options.noGlobalCli,
  });
  const skew = formatVersionSkewWarning(packageVersion, alignment.latest);
  if (skew !== null) console.log(skew);
  if (alignment.failure !== null) throw new Error(alignment.failure.message);
}

program.name("mstar-harness").description("Morning Star harness CLI for target-based agent bootstrap").version(packageVersion);
program.addHelpText(
  "after",
  "Skill: read mstar-use-cli before choosing or running a command.\nOne exact contract: mstar schema --command <id>.",
);
program
  .command("init")
  .description("Target-aware setup for agent bootstrap")
  .option("-y, --yes", "Accepted for compatibility; only suppresses the scope-default notice")
  .addOption(new Option("--target <target>", "Install target").choices([...SUPPORTED_TARGETS]).default("opencode"))
  .addOption(new Option("--scope <scope>", "Config scope (default: project, or the target's single supported scope)").choices(["global", "project"]))
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
