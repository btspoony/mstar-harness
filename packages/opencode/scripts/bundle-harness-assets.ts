/**
 * Copies repo-root `skills/`, `agents/`, and `commands/` into this package for npm publish,
 * then merges this package's OpenCode-only `agents/` overlays into `harness-agents/`.
 * Run from `packages/opencode` via the `build` script (monorepo checkout required).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(__dirname, "..");
export const repoRoot = path.resolve(packageRoot, "..", "..");
export const sourceSkills = path.join(repoRoot, "skills");
export const sourceAgents = path.join(repoRoot, "agents");
export const sourceCommands = path.join(repoRoot, "commands");
export const sourceOpenCodeAgents = path.join(packageRoot, "agents");
export const destSkills = path.join(packageRoot, "harness-skills");
export const destAgents = path.join(packageRoot, "harness-agents");
export const destCommands = path.join(packageRoot, "harness-commands");

export function copyTree(label: string, from: string, to: string) {
  if (!fs.existsSync(from)) {
    console.error(`bundle-harness-assets: missing ${label} directory: ${from}`);
    process.exit(1);
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

/** Overlay merge: copies `from` on top of `to` without clearing it first. */
export function mergeTree(label: string, from: string, to: string) {
  if (!fs.existsSync(from)) {
    console.error(`bundle-harness-assets: missing ${label} directory: ${from}`);
    process.exit(1);
  }
  fs.cpSync(from, to, { recursive: true });
}

// Run only when executed directly (`bun run bundle-assets`): the sync only
// runs under `import.meta.main`, so tests can import this module side-effect
// free (same seam as the packages/dsh bundle-assets script).
if (import.meta.main) {
  copyTree("skills", sourceSkills, destSkills);
  copyTree("agents", sourceAgents, destAgents);
  // Primary seats (the `mode: primary` project-manager) are OpenCode-only —
  // repo-root agents/ is the cross-host subagent surface and must not carry them.
  mergeTree("opencode-agents", sourceOpenCodeAgents, destAgents);
  copyTree("commands", sourceCommands, destCommands);
  console.log(`bundle-harness-assets: synced skills -> ${destSkills}, agents -> ${destAgents} (+ OpenCode-only overlays), commands -> ${destCommands}`);
}
