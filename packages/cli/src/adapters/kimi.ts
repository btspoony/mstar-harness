import fs from "node:fs";
import path from "node:path";
import type { AgentAdapter, Scope } from "../types";
import { resolveProjectRoot } from "../utils";
import {
  HARNESS_REPO_PATH,
  PLUGIN_NAME,
  ensureLocalHarnessRepo,
  ensureSymlink,
  validateLocalHarnessRepo,
  validateSymlink,
  appendGitignore,
  appendHarnessProjectGitignore,
  SDD_SCRATCH_GITIGNORE,
} from "./shared-install";

const KIMI_PLUGIN_MARKER = "kimi.plugin.json";
const KIMI_ITERATION_SKILL_NAMES = [
  "iteration-start",
  "iteration-drive",
  "iteration-loop",
] as const;

const GLOBAL_ITERATION_SKILLS_WARNING =
  "Kimi iteration commands (iteration-start / iteration-drive / iteration-loop) are installed as project-local skills under .agents/skills/ only. Global install skips them to avoid polluting other code agents. Re-run with --scope project to enable.";

function iterationCommandSourcePath(skillName: string) {
  return path.join(HARNESS_REPO_PATH, "commands", `${skillName}.md`);
}

function projectIterationSkillLinkPath(skillName: string) {
  return path.join(resolveProjectRoot(), ".agents", "skills", skillName, "SKILL.md");
}

function iterationSkillGitignoreEntry(skillName: string) {
  return `.agents/skills/${skillName}`;
}

function validateKimiPluginManifest() {
  const errors: string[] = [];
  const manifestPath = path.join(HARNESS_REPO_PATH, KIMI_PLUGIN_MARKER);
  if (!fs.existsSync(manifestPath)) {
    errors.push(`Missing Kimi plugin manifest: ${manifestPath}`);
    return errors;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    if (raw.name !== PLUGIN_NAME) {
      errors.push(`kimi.plugin.json name must be ${PLUGIN_NAME}.`);
    }
    if (typeof raw.skills !== "string" || !raw.skills.startsWith("./")) {
      errors.push("kimi.plugin.json skills must be a ./ path.");
    }
    if (typeof raw.commands !== "string" && !Array.isArray(raw.commands)) {
      errors.push("kimi.plugin.json commands must be a ./ path or array of paths.");
    }
    const sessionStart = raw.sessionStart;
    if (
      !sessionStart ||
      typeof sessionStart !== "object" ||
      Array.isArray(sessionStart) ||
      (sessionStart as { skill?: unknown }).skill !== "mstar-harness-core"
    ) {
      errors.push('kimi.plugin.json sessionStart.skill must be "mstar-harness-core".');
    }
    const skillsDir = path.join(HARNESS_REPO_PATH, "skills");
    const commandsDir = path.join(HARNESS_REPO_PATH, "commands");
    if (!fs.existsSync(skillsDir)) errors.push(`Missing skills directory: ${skillsDir}`);
    if (!fs.existsSync(commandsDir)) errors.push(`Missing commands directory: ${commandsDir}`);
  } catch (error) {
    errors.push(`Invalid kimi.plugin.json: ${(error as Error).message}`);
  }
  return errors;
}

function ensureIterationSkillLinks(dryRun: boolean) {
  const notes: string[] = [];
  const projectRoot = resolveProjectRoot();
  for (const skillName of KIMI_ITERATION_SKILL_NAMES) {
    const source = iterationCommandSourcePath(skillName);
    const linkPath = projectIterationSkillLinkPath(skillName);
    notes.push(ensureSymlink(source, linkPath, dryRun));
  }
  const gitignoreEntries = KIMI_ITERATION_SKILL_NAMES.map(iterationSkillGitignoreEntry);
  notes.push(...appendGitignore(projectRoot, gitignoreEntries, dryRun));
  notes.push(
    "Installed Kimi project-scoped iteration skills under .agents/skills/ (iteration-start, iteration-drive, iteration-loop) — symlinked to harness commands/*.md.",
  );
  return notes;
}

function validateIterationSkillLinks() {
  const errors: string[] = [];
  const projectRoot = resolveProjectRoot();
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  const lines = gitignore.split(/\r?\n/);
  for (const skillName of KIMI_ITERATION_SKILL_NAMES) {
    const source = iterationCommandSourcePath(skillName);
    const linkPath = projectIterationSkillLinkPath(skillName);
    errors.push(...validateSymlink(source, linkPath));
    const entry = iterationSkillGitignoreEntry(skillName);
    if (!lines.includes(entry)) errors.push(`Missing .gitignore entry: ${entry}`);
  }
  return errors;
}

function runInit(scope: Scope, dryRun: boolean) {
  const notes = ensureLocalHarnessRepo(dryRun);
  const manifestErrors = validateKimiPluginManifest();
  if (manifestErrors.length) {
    throw new Error(manifestErrors.join("\n"));
  }
  notes.push(`Validated Kimi plugin manifest at ${path.join(HARNESS_REPO_PATH, KIMI_PLUGIN_MARKER)}`);

  if (scope === "project") {
    const projectRoot = resolveProjectRoot();
    notes.push(...appendHarnessProjectGitignore(projectRoot, dryRun));
    notes.push(...ensureIterationSkillLinks(dryRun));
  } else {
    notes.push(GLOBAL_ITERATION_SKILLS_WARNING);
  }

  notes.push(`Install in Kimi TUI: /plugins install ${HARNESS_REPO_PATH}`);
  notes.push("Or from GitHub: /plugins install https://github.com/btspoony/mstar-harness");
  notes.push("After install or updates: /plugins reload (or /new for a fresh session)");
  notes.push(`Plugin commands: /${PLUGIN_NAME}:iteration-start, /${PLUGIN_NAME}:iteration-drive, /${PLUGIN_NAME}:iteration-loop`);
  notes.push("Kimi plugins are user-scoped (all projects); managed copy lives under $KIMI_CODE_HOME/plugins/managed/");

  return {
    location: path.join(HARNESS_REPO_PATH, KIMI_PLUGIN_MARKER),
    notes,
  };
}

function runDoctor(scope: Scope) {
  const manifestPath = path.join(HARNESS_REPO_PATH, KIMI_PLUGIN_MARKER);
  const errors = [...validateLocalHarnessRepo(), ...validateKimiPluginManifest()];

  if (scope === "project") {
    const projectRoot = resolveProjectRoot();
    const gitignorePath = path.join(projectRoot, ".gitignore");
    const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
    const lines = gitignore.split(/\r?\n/);
    for (const entry of SDD_SCRATCH_GITIGNORE) {
      if (!lines.includes(entry)) errors.push(`Missing .gitignore entry: ${entry}`);
    }
    errors.push(...validateIterationSkillLinks());
  }

  if (!errors.length) {
    // Non-fatal reminders when healthy
  }

  return { location: manifestPath, errors };
}

export const kimiAdapter: AgentAdapter = {
  target: "kimi",
  mode: "install",
  runInstallInit: (scope, dryRun) => runInit(scope, dryRun),
  runInstallDoctor: (scope) => runDoctor(scope),
};
