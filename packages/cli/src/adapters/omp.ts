import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runCliCommand } from "../exec";
import type { AgentAdapter, Scope } from "../types";
import { resolveProjectRoot } from "../utils";
import {
  REPO_URL,
  PLUGIN_NAME,
  HARNESS_REPO_PATH,
  ensureLocalHarnessRepo,
  appendGitignore,
  appendHarnessProjectGitignore,
  missingHarnessProcessGitignoreEntries,
  validateLocalHarnessRepo,
} from "./shared-install";

// The omp plugin tree is the built `packages/omp` package (repo-root
// `hooks/`/`tools/` moved into it 2026-09-03) — link/doctor target
// `<repo>/packages/omp`, whose package-root `plugin.json` + bundled
// `skills/`/`commands/`/`agents/`/`hooks/`/`tools/` mirrors are produced by
// `bun run --cwd packages/omp build`.
const OMP_PACKAGE_REL = path.join("packages", "omp");
const PACKAGE_NAMES = new Set(["morning-star", PLUGIN_NAME, "github:btspoony/mstar-harness", "@mstar-harness/omp"]);
const SKILL_SMOKE = ["mstar-host", "mstar-harness-core", "pm"];
const COMMAND_SMOKE = ["iteration-start", "iteration-drive", "iteration-loop", "codebase-audit"];

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

function listInstalledPlugins(): Array<Record<string, unknown>> {
  try {
    const raw = execFileSync("omp", ["plugin", "list", "--json"], {
      stdio: "pipe",
      encoding: "utf8",
    });
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
    if (parsed && typeof parsed === "object") {
      const record = parsed as {
        plugins?: unknown;
        npm?: unknown;
        marketplace?: unknown;
      };
      if (Array.isArray(record.plugins)) {
        return record.plugins as Array<Record<string, unknown>>;
      }
      // omp 17.x: { npm: [...], marketplace: [...] }
      const entries: Array<Record<string, unknown>> = [];
      for (const key of ["npm", "marketplace"] as const) {
        const group = record[key];
        if (Array.isArray(group)) {
          for (const item of group) {
            if (item && typeof item === "object") entries.push(item as Record<string, unknown>);
          }
        }
      }
      if (entries.length > 0) return entries;
    }
    return [];
  } catch {
    return [];
  }
}

function findInstalledPlugin(plugins: Array<Record<string, unknown>>) {
  return plugins.find((entry) => {
    const name = typeof entry.name === "string" ? entry.name : "";
    const pathValue = typeof entry.path === "string" ? entry.path : "";
    const manifest =
      entry.manifest && typeof entry.manifest === "object"
        ? (entry.manifest as Record<string, unknown>)
        : null;
    const manifestName = typeof manifest?.name === "string" ? manifest.name : "";
    if (PACKAGE_NAMES.has(name) || PACKAGE_NAMES.has(manifestName)) return true;
    if (name.includes("morning-star") || manifestName.includes("morning-star")) return true;
    if (pathValue.includes("mstar-harness") || pathValue.includes(`${path.sep}morning-star`)) return true;
    return false;
  });
}

function validatePluginTree(pluginRoot: string) {
  const errors: string[] = [];
  // The omp package ships a package-root `plugin.json` (Agent Plugins
  // format) — the repo-root `.omp-plugin/`/`.claude-plugin/` markers are not
  // part of the linked package tree.
  const markerPath = path.join(pluginRoot, "plugin.json");
  if (!fs.existsSync(markerPath)) {
    errors.push(`Missing omp plugin marker: ${markerPath}`);
  }
  for (const skill of SKILL_SMOKE) {
    const skillPath = path.join(pluginRoot, "skills", skill, "SKILL.md");
    if (!fs.existsSync(skillPath)) errors.push(`Missing skill: ${skillPath}`);
  }
  for (const command of COMMAND_SMOKE) {
    const commandPath = path.join(pluginRoot, "commands", `${command}.md`);
    if (!fs.existsSync(commandPath)) errors.push(`Missing command: ${commandPath}`);
  }
  const hostRef = path.join(pluginRoot, "skills", "mstar-host", "references", "omp.md");
  if (!fs.existsSync(hostRef)) errors.push(`Missing omp host reference: ${hostRef}`);
  return errors;
}

function runInit(scope: Scope, dryRun: boolean) {
  const notes = ensureLocalHarnessRepo(dryRun);
  const projectRoot = resolveProjectRoot();

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

  if (!ompAvailable()) {
    notes.push(
      "omp CLI not found on PATH. Install Oh My Pi (`omp`), then re-run init or manually: omp plugin install @mstar-harness/omp",
    );
  } else {
    const ompPackagePath = path.join(HARNESS_REPO_PATH, OMP_PACKAGE_REL);
    notes.push(
      `Linked omp plugin tree needs a local build first: bun install && bun run engine:build && bun run --cwd packages/omp build (the linked tree resolves the engine via the workspace member; dist + root mirrors are gitignored)`,
    );
    const linkArgs = ["plugin", "link", ompPackagePath];
    if (scope === "project") linkArgs.push("--scope", "project");
    if (dryRun) {
      notes.push(`Would run: omp ${linkArgs.join(" ")}`);
    } else {
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

  return {
    location: HARNESS_REPO_PATH,
    notes,
  };
}

function runDoctor(scope: Scope) {
  const errors: string[] = [];
  errors.push(...validateLocalHarnessRepo());
  errors.push(...validatePluginTree(path.join(HARNESS_REPO_PATH, OMP_PACKAGE_REL)));

  if (!ompAvailable()) {
    errors.push("omp CLI not found on PATH (required for omp target doctor checks).");
  } else {
    const plugins = listInstalledPlugins();
    const installed = findInstalledPlugin(plugins);
    if (!installed) {
      errors.push(
        `Morning Star plugin not found in \`omp plugin list\` (expected one of: ${[...PACKAGE_NAMES].join(", ")}). Run: mstar-harness init --target omp --scope ${scope}`,
      );
    } else if (installed.enabled === false) {
      errors.push(`Morning Star omp plugin is installed but disabled (${String(installed.name)}).`);
    }
  }

  if (scope === "project") {
    const projectRoot = resolveProjectRoot();
    const gitignorePath = path.join(projectRoot, ".gitignore");
    const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
    for (const entry of missingHarnessProcessGitignoreEntries(gitignore)) {
      errors.push(`Missing .gitignore entry: ${entry}`);
    }
  }

  return { location: HARNESS_REPO_PATH, errors };
}

export const ompAdapter: AgentAdapter = {
  target: "omp",
  mode: "install",
  runInstallInit: (scope, dryRun) => runInit(scope, dryRun),
  runInstallDoctor: (scope) => runDoctor(scope),
};
