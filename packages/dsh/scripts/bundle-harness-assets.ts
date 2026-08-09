/**
 * Copies repo-root `skills/` and `commands/` into this package for the dsh
 * skill-local bundled mount (`harness-skills/`) and the `ctx.commands`
 * registrations (`harness-commands/`). Run from `packages/dsh` via the
 * `bundle-assets` script (monorepo checkout required; outputs are gitignored
 * — the mirror lives once in the repo root, same as `packages/opencode`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const sourceSkills = path.join(repoRoot, "skills");
const sourceCommands = path.join(repoRoot, "commands");
const destSkills = path.join(packageRoot, "harness-skills");
const destCommands = path.join(packageRoot, "harness-commands");

function copyTree(label: string, from: string, to: string) {
  if (!fs.existsSync(from)) {
    console.error(`bundle-harness-assets: missing ${label} directory: ${from}`);
    process.exit(1);
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

copyTree("skills", sourceSkills, destSkills);
copyTree("commands", sourceCommands, destCommands);
console.log(`bundle-harness-assets: synced skills -> ${destSkills}, commands -> ${destCommands}`);
