import { diagnoseOmpHost, findInstalledPlugin, ompEntryVersion, parseOmpPluginList } from "@mstar-harness/commands";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runCliCommand } from "../exec";
import type { AgentAdapter, Scope } from "../types";
import { readHarnessVersion, resolveProjectRoot } from "../utils";
import {
 REPO_URL,
 HARNESS_REPO_PATH,
 ensureLocalHarnessRepo,
 appendGitignore,
 appendHarnessProjectGitignore,
 missingHarnessProcessGitignoreEntries,
 validateLocalHarnessRepo,
} from "./shared-install";
import { ensureHostPresent } from "./host-presence";

// The omp plugin tree is the built `packages/omp` package (repo-root
// `hooks/`/`tools/` moved into it 2026-09-03) — link/doctor target
// `<repo>/packages/omp`, whose package-root `plugin.json` + bundled
// `skills/`/`commands/`/`agents/`/`hooks/`/`tools/` mirrors are produced by
// `bun run --cwd packages/omp build`.
const OMP_PACKAGE_REL = path.join("packages", "omp");
/** Plugin package name as omp's plugin manager knows it. */
const OMP_PLUGIN_NAME = "@mstar-harness/omp";

function ompAvailable() {
 try {
 execFileSync("omp", ["--version"], { stdio: "pipe", encoding: "utf8" });
 return true;
 } catch {
 return false;
 }
}

function runOmp(args: string[], dryRun: boolean): void {
  runCliCommand(["omp", ...args], { dryRun });
}

/**
 * The plugin root omp materializes installs in: its documented default under the
 * user home, or the relocated data root when `XDG_DATA_HOME` is set. A root omp
 * reports for its own entry is preferred at the call site; this is the fallback
 * for the case where omp lists nothing yet.
 */
function ompPluginsRoot(): string {
  const dataHome = process.env["XDG_DATA_HOME"];
  return dataHome !== undefined && dataHome !== ""
    ? path.join(dataHome, "omp", "plugins")
    : path.join(homedir(), ".omp", "plugins");
}

function declaredByPluginManager(root: string): boolean {
  const manifest = path.join(root, "package.json");
  if (!fs.existsSync(manifest)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
    };
    return OMP_PLUGIN_NAME in { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
  } catch {
    return false;
  }
}

/** A refusal that names the step, the observed cause, and a supported recovery. */
function ompRefusal(step: string, detail: string, recovery: string): Error {
  return new Error(`${step}: ${detail}\nRecovery: ${recovery}`);
}

/**
 * Where omp may keep this plugin: the user plugin root (its documented default)
 * plus a relocated data root, and — most authoritatively — the path omp's own
 * listing reports for the entry it has. Nothing here is deleted by hand: a
 * plugin-manager root owns its `node_modules`, so the entry is replaced only
 * through omp's uninstall verb, and a refusal names every supported route.
 * Exported for tests: the caller supplies the roots that keep the check off the
 * real home.
 */
export function clearOmpEntry(root: string, ompPackagePath: string, notes: string[]): void {
  const entry = path.join(root, "node_modules", OMP_PLUGIN_NAME);
  try {
    // lstat: a dangling symlink occupies the entry too, and `existsSync` would miss it.
    fs.lstatSync(entry);
  } catch {
    return;
  }
  try {
    runOmp(["plugin", "uninstall", OMP_PLUGIN_NAME], false);
    notes.push(`Replaced the existing ${OMP_PLUGIN_NAME} install in ${root} through omp.`);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const declared = declaredByPluginManager(root) ? "declared by the plugin-manager manifest" : "not declared by any manifest";
    throw ompRefusal(
      `An existing ${OMP_PLUGIN_NAME} entry occupies the plugin path (${declared}), and omp could not remove it`,
      `${entry}: ${message}`,
      `remove it through omp (\`omp plugin uninstall ${OMP_PLUGIN_NAME}\`), or install the published plugin, which replaces it through omp: ` +
        `\`omp plugin install ${OMP_PLUGIN_NAME}\`; for a manual link: \`omp plugin link ${ompPackagePath}\``,
    );
  }
}

/** An install omp does not list did not happen: assert what we asked for.
 *  Exported for tests: the fake `omp` on PATH is the seam. */
export function verifyOmpInstall(notes: string[], expectedVersion: string, linkedTree?: string): void {
  const entry = findInstalledPlugin(listInstalledPlugins());
  if (entry === undefined) {
    throw ompRefusal(
      "omp plugin list does not report the Morning Star plugin after installing it",
      "the plugin manager did not register the entry it was given",
      `inspect with \`omp plugin list\`, then install it yourself: \`omp plugin install ${OMP_PLUGIN_NAME}\``,
    );
  }
  if (linkedTree !== undefined) {
    if (typeof entry.path !== "string") {
      // The listing shape is omp's; without a path there is nothing to compare, so
      // the note says what could not be confirmed instead of claiming it was.
      notes.push(`omp reports ${OMP_PLUGIN_NAME}, but its listing carries no path to compare with ${linkedTree}.`);
      return;
    }
    let listed: string;
    let linked: string;
    try {
      listed = fs.realpathSync(entry.path);
      linked = fs.realpathSync(linkedTree);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw ompRefusal(
        "omp points at a path that cannot be resolved, so the link cannot be confirmed",
        `linked ${linkedTree}, omp lists ${entry.path}: ${message}`,
        `link it again: \`omp plugin link ${linkedTree}\`, then \`omp plugin list\``,
      );
    }
    if (listed !== linked) {
      throw ompRefusal(
        "omp plugin list points at a different tree than the one just linked",
        `linked ${linked}, omp lists ${listed}`,
        `link it again: \`omp plugin link ${linkedTree}\``,
      );
    }
    notes.push(`omp reports ${OMP_PLUGIN_NAME} linked from ${linkedTree}.`);
    return;
  }
  const installed = ompEntryVersion(entry);
  if (installed !== null && installed !== expectedVersion) {
    throw ompRefusal(
      "omp reports a different plugin version than the one installed",
      `expected ${expectedVersion}, omp lists ${installed}`,
      `install the expected version yourself: \`omp plugin install ${OMP_PLUGIN_NAME}@${expectedVersion}\``,
    );
  }
  notes.push(
    installed === null
      ? `omp reports ${OMP_PLUGIN_NAME} (its listing carries no version).`
      : `omp reports ${OMP_PLUGIN_NAME} at ${installed}.`,
  );
}

/**
 * Bound for the `omp plugin list --json` probe (ms). Mirrors the codex
 * adapter's local-probe ceiling (10s): the doctor's centralized version
 * alignment check runs BEFORE the omp adapter's own checks, so a stalled omp
 * binary must surface as a caught throw (→ empty listing → standard
 * not-installed note) instead of blocking doctor indefinitely.
 */
export const OMP_LIST_TIMEOUT_MS = 10_000;


/** Exported for `../plugin-version-alignment`: the doctor alignment note
 * reads the installed plugin version from the same listing the doctor's
 * installed-state check uses (single JSON surface, no duplicate parsing).
 * `timeoutMs` bounds the subprocess (default `OMP_LIST_TIMEOUT_MS`) — a
 * timeout throw lands in the same catch as any other probe failure and
 * degrades to an empty listing (never blocks doctor). The stdlib option name
 * is `timeout` (ms): `exec.ts` maps its own `timeoutMs` spelling onto it, and
 * raw `execFileSync` silently ignores an unknown `timeoutMs` key. */
export function listInstalledPlugins(timeoutMs: number = OMP_LIST_TIMEOUT_MS): Array<Record<string, unknown>> {
 try {
 const raw = execFileSync("omp", ["plugin", "list", "--json"], {
 stdio: "pipe",
 encoding: "utf8",
 timeout: timeoutMs,
 });
 return parseOmpPluginList(raw);
 } catch {
 return [];
 }
}



async function runInit(scope: Scope, dryRun: boolean) {
 const notes: string[] = [];
 const projectRoot = resolveProjectRoot();
 if (!dryRun) await ensureHostPresent("omp");
 notes.push(...ensureLocalHarnessRepo(dryRun));

 // Keep the shared checkout current so new host markers (`.omp-plugin/`) exist before link/doctor.
 if (fs.existsSync(path.join(HARNESS_REPO_PATH, ".git"))) {
 if (dryRun) {
 notes.push(`Would update local harness repo: git -C ${HARNESS_REPO_PATH} pull --ff-only`);
 } else {
 try {
 execFileSync("git", ["-C", HARNESS_REPO_PATH, "pull", "--ff-only"], {
 stdio: "pipe",
 encoding: "utf8",
 });
 notes.push(`Updated local harness repo at ${HARNESS_REPO_PATH}`);
 } catch (error) {
 const message = error instanceof Error ? error.message : String(error);
 notes.push(`Warning: could not ff-only pull ${HARNESS_REPO_PATH} (${message})`);
 }
 }
 }

 if (dryRun) {
 const ompPackagePath = path.join(HARNESS_REPO_PATH, OMP_PACKAGE_REL);
 const linkArgs = ["plugin", "link", ompPackagePath];
 if (scope === "project") linkArgs.push("--scope", "project");
 notes.push(
 "omp CLI presence is unchecked under --dry-run (would-run preview); install Oh My Pi (`omp`) before executing init.",
 `Would run: omp ${linkArgs.join(" ")}`,
 );
 } else {
 const ompPackagePath = path.join(HARNESS_REPO_PATH, OMP_PACKAGE_REL);
 const expectedVersion = readHarnessVersion();
 const installSpec = `${OMP_PLUGIN_NAME}@${expectedVersion}`;
 // `omp plugin install` accepts `--scope` only for marketplace specs: it warns
 // and ignores it otherwise, so the note states where the install actually lands.
 const installPublished = (): void => {
   try {
     runOmp(["plugin", "install", installSpec], dryRun);
     notes.push(`Installed ${installSpec} via omp plugin install (omp owns where it lands).`);
   } catch (error) {
     const message = error instanceof Error ? error.message : String(error);
     throw ompRefusal(
       `omp plugin install ${installSpec} failed`,
       message,
       `run \`omp plugin install ${installSpec}\` yourself and read its output`,
     );
   }
 };
 // The linked tree's plugin.json/skills/hooks/tools mirrors are gitignored
 // build outputs — without a build the link succeeds with an empty plugin
 // and doctor then fails on the same tree. Build before linking; fall back
 // to the npm install when the build is impossible (e.g. no bun on PATH).
 if (!fs.existsSync(path.join(ompPackagePath, "plugin.json"))) {
 try {
 runCliCommand(["bun", "install"], { cwd: HARNESS_REPO_PATH, dryRun });
 runCliCommand(["bun", "run", "engine:build"], { cwd: HARNESS_REPO_PATH, dryRun });
 runCliCommand(["bun", "run", "omp:build"], { cwd: HARNESS_REPO_PATH, dryRun });
 notes.push("Built the omp package (engine dist + discovery mirrors) before linking.");
 } catch (buildError) {
 const buildMessage = buildError instanceof Error ? buildError.message : String(buildError);
          notes.push(
            `Warning: could not build packages/omp (${buildMessage}); installing the published plugin instead.`,
          );
          installPublished();
          verifyOmpInstall(notes, expectedVersion);
          notes.push(...postInstallNotes(scope, dryRun, projectRoot));
          return { location: HARNESS_REPO_PATH, notes };
 }
 }
 notes.push(
 `Linked omp plugin tree resolved via the workspace engine member; dist + root mirrors are gitignored build outputs (rebuilt automatically above when absent)`,
 );
 clearOmpEntry(ompPluginsRoot(), ompPackagePath, notes);
 const linkArgs = ["plugin", "link", ompPackagePath];
 if (scope === "project") linkArgs.push("--scope", "project");
 try {
 runOmp(linkArgs, dryRun);
 notes.push(
 `Linked local harness omp package into omp plugins (${scope}): omp plugin link ${ompPackagePath}${scope === "project" ? " --scope project" : ""}`,
 );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw ompRefusal(
          `omp plugin link ${ompPackagePath} failed`,
          message,
          `replace the existing entry through omp (\`omp plugin uninstall ${OMP_PLUGIN_NAME}\`), or install the published plugin instead: \`omp plugin install ${installSpec}\``,
        );
      }
      verifyOmpInstall(notes, expectedVersion, ompPackagePath);
    }

 if (scope === "project") {
 notes.push(...appendHarnessProjectGitignore(projectRoot, dryRun));
 notes.push(
 ...appendGitignore(
 projectRoot,
 [".omp/plugins/", ".omp/plugin-overrides.json", ".omp/plugins/installed_plugins.json"],
 dryRun,
 ),
 );
 }

 notes.push("Verify with: omp plugin list");
 notes.push("Enter PM with /skill:pm ; commands: /iteration-start /iteration-drive /iteration-loop /codebase-audit");
 notes.push(`Host adapter: mstar-host \u2192 references/omp.md (skill://mstar-host/references/omp.md)`);
 notes.push(`Alternate install without CLI link: omp plugin install @mstar-harness/omp`);

 return { location: HARNESS_REPO_PATH, notes };
}

/**
 * Shared tail notes for the runInit install-fallback path (npm install taken
 * instead of the link) — mirrors the post-link section of `runInit` so both
 * exits produce the same guidance set.
 */
function postInstallNotes(scope: Scope, dryRun: boolean, projectRoot: string): string[] {
 const notes: string[] = [];
 if (scope === "project") {
 notes.push(...appendHarnessProjectGitignore(projectRoot, dryRun));
 notes.push(
 ...appendGitignore(
 projectRoot,
 [".omp/plugins/", ".omp/plugin-overrides.json", ".omp/plugins/installed_plugins.json"],
 dryRun,
 ),
 );
 }
 notes.push("Verify with: omp plugin list");
 notes.push("Enter PM with /skill:pm ; commands: /iteration-start /iteration-drive /iteration-loop /codebase-audit");
 notes.push(`Host adapter: mstar-host \u2192 references/omp.md (skill://mstar-host/references/omp.md)`);
 notes.push(`Alternate install without CLI link: omp plugin install @mstar-harness/omp`);
 return notes;
}

function runDoctor(scope: Scope) {
 const projectRoot = scope === "project" ? resolveProjectRoot() : undefined;
 const gitignorePath = projectRoot ? path.join(projectRoot, ".gitignore") : undefined;
 const gitignore = gitignorePath && fs.existsSync(gitignorePath)
 ? fs.readFileSync(gitignorePath, "utf8")
 : "";
 const ompIsAvailable = ompAvailable();

 return diagnoseOmpHost({
 harnessRepoPath: HARNESS_REPO_PATH,
 scope,
 ompAvailable: ompIsAvailable,
 installedPlugins: ompIsAvailable ? listInstalledPlugins() : [],
 localHarnessRepoErrors: validateLocalHarnessRepo(),
 missingGitignoreEntries: projectRoot
 ? missingHarnessProcessGitignoreEntries(gitignore)
 : [],
 });
}

export const ompAdapter: AgentAdapter = {
 target: "omp",
 mode: "install",
 runInstallInit: (scope, dryRun) => runInit(scope, dryRun),
 runInstallDoctor: (scope) => runDoctor(scope),
};
