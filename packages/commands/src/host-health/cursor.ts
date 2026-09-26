import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProjectRoot } from "./paths.js";

const CURSOR_PLUGIN_NAME = "morning-star-harness";
const CURSOR_PLUGIN_MARKER = ".cursor-plugin/plugin.json";
const CURSOR_PLUGIN_LINK = ".cursor/plugins/morning-star-harness";
const CURSOR_AGENT_SMOKE_NAMES = ["fullstack-dev", "qc-specialist"];

export type CursorScope = "global" | "project";
export type CursorDoctorResult = { location: string; errors: string[] };

/** Cursor install roots — shared by doctor and plugin-version discovery. */
export function globalInstallPath(home: string = os.homedir()): string {
  return path.join(home, ".cursor", "plugins", "local", CURSOR_PLUGIN_NAME);
}

export function projectInstallPath(projectRoot: string = resolveProjectRoot()): string {
  return path.join(projectRoot, CURSOR_PLUGIN_LINK);
}

function validateGitCheckout(checkoutPath: string): string[] {
  const errors: string[] = [];
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(checkoutPath);
  } catch {
    errors.push(`Missing checkout directory: ${checkoutPath}`);
    return errors;
  }
  if (stat.isSymbolicLink()) {
    errors.push(
      `Path must be a real directory, not a symlink: ${checkoutPath}. Run: mstar-harness init --target cursor`,
    );
    return errors;
  }
  if (!fs.existsSync(path.join(checkoutPath, ".git"))) {
    errors.push(`Path is not a git checkout: ${checkoutPath}`);
  }
  const marker = path.join(checkoutPath, CURSOR_PLUGIN_MARKER);
  if (!fs.existsSync(marker)) errors.push(`Missing marker file: ${marker}`);
  return errors;
}

function validatePluginAgents(pluginRoot: string): string[] {
  const errors: string[] = [];
  const agentsDir = path.join(pluginRoot, "agents");
  if (!fs.existsSync(agentsDir)) {
    errors.push(`Missing plugin agents directory: ${agentsDir}`);
    return errors;
  }
  for (const agentName of CURSOR_AGENT_SMOKE_NAMES) {
    const agentPath = path.join(agentsDir, `${agentName}.md`);
    if (!fs.existsSync(agentPath)) {
      errors.push(`Missing plugin agent file: ${agentPath}`);
      continue;
    }
    const content = fs.readFileSync(agentPath, "utf8");
    if (!/^---\nname:\s/m.test(content)) {
      errors.push(
        `Plugin agent ${agentName}.md must use Cursor-first frontmatter (name, description, model before OpenCode fields).`,
      );
    }
  }
  return errors;
}

/** Assemble read-only Cursor checkout and plugin diagnostics for the selected install scope. */
export function diagnoseCursorHost(
  scope: CursorScope,
  roots?: { project?: string; global?: string },
): CursorDoctorResult {
  const location = scope === "global"
    ? roots?.global ?? globalInstallPath()
    : roots?.project ?? projectInstallPath();
  return {
    location,
    errors: [...validateGitCheckout(location), ...validatePluginAgents(location)],
  };
}
