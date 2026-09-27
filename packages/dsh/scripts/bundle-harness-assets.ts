/**
 * Copies repo-root `skills/`, `commands/`, and `agents/` into this package
 * for the dsh skill-filesystem bundled mount (`harness-skills/`), the
 * `ctx.commands` registrations (`harness-commands/`), and the role-persona
 * default source (`harness-agents/`). Run from `packages/dsh` via the
 * `bundle-assets` script (monorepo checkout required; outputs are gitignored
 * — each mirror lives once in the repo root, same as `packages/opencode`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(__dirname, "..");
export const repoRoot = path.resolve(packageRoot, "..", "..");
export const sourceSkills = path.join(repoRoot, "skills");
export const sourceCommands = path.join(repoRoot, "commands");
export const sourceAgents = path.join(repoRoot, "agents");
export const destSkills = path.join(packageRoot, "harness-skills");
export const destCommands = path.join(packageRoot, "harness-commands");
export const destHarnessAgents = path.join(packageRoot, "harness-agents");

export function copyTree(label: string, from: string, to: string) {
  if (!fs.existsSync(from)) {
    console.error(`bundle-harness-assets: missing ${label} directory: ${from}`);
    process.exit(1);
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

// Run only when executed directly (`bun run bundle-assets`): the sync only
// runs under `import.meta.main`, so tests can import this module side-effect
// free (same seam as `build-client-bundle.ts`). NOTE: `import.meta.main` is
// undefined in non-bun runtimes, so direct execution there silently no-ops —
// the script is wired as a bun script (`package.json` scripts), matching the
// sibling seam.
if (import.meta.main) {
  copyTree("skills", sourceSkills, destSkills);
  copyTree("commands", sourceCommands, destCommands);
  copyTree("agents", sourceAgents, destHarnessAgents);
  console.log(
    `bundle-harness-assets: synced skills -> ${destSkills}, commands -> ${destCommands}, agents -> ${destHarnessAgents}`,
  );
}
