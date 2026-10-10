import { diagnoseOmpHost, parseOmpPluginList } from "@mstar-harness/commands";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runCliCommand } from "../exec";
import type { AgentAdapter, Scope } from "../types";
import { resolveProjectRoot } from "../utils";
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
          `Warning: could not build packages/omp (${buildMessage}). Falling back to: omp plugin install @mstar-harness/omp`,
        );
        const installArgs = ["plugin", "install", "@mstar-harness/omp"];
        if (scope === "project") installArgs.push("--scope", "project");
        try {
          runOmp(installArgs, dryRun);
          notes.push(`Installed @mstar-harness/omp via omp plugin install (${scope}).`);
        } catch (installError) {
          notes.push(`omp plugin install also failed: ${installError instanceof Error ? installError.message : String(installError)}`);
        }
        notes.push(...postInstallNotes(scope, dryRun, projectRoot));
        return { location: HARNESS_REPO_PATH, notes };
      }
    }
    notes.push(
      `Linked omp plugin tree resolved via the workspace engine member; dist + root mirrors are gitignored build outputs (rebuilt automatically above when absent)`,
    );
    const linkArgs = ["plugin", "link", ompPackagePath];
    if (scope === "project") linkArgs.push("--scope", "project");
    try {
      runOmp(linkArgs, dryRun);
      notes.push(
        `Linked local harness omp package into omp plugins (${scope}): omp plugin link ${ompPackagePath}${scope === "project" ? " --scope project" : ""}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`omp plugin link failed (${message}). Falling back guidance: omp plugin install @mstar-harness/omp`);
      try {
        const installArgs = ["plugin", "install", "@mstar-harness/omp"];
        if (scope === "project") installArgs.push("--scope", "project");
        runOmp(installArgs, dryRun);
        notes.push(`Installed @mstar-harness/omp via omp plugin install (${scope}).`);
      } catch (installError) {
        const installMessage = installError instanceof Error ? installError.message : String(installError);
        notes.push(`omp plugin install also failed: ${installMessage}`);
      }
    }
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
