/**
 * Copies repo-root `skills/`, `commands/`, `agents/`, `assets/` and the
 * `.omp-plugin/plugin.json` manifest into this package for npm publish.
 * Run from `packages/omp` via the `build` script (monorepo checkout required).
 *
 * Two mirror sets are produced:
 * - `harness-skills/` / `harness-commands/` / `harness-agents/` — the
 *   canonical bundled assets (opencode/dsh parity).
 * - `skills/` / `commands/` / `agents/` at the package root — omp discovers
 *   plugin surfaces by CONVENTION from the installed package root
 *   (`<pkg>/skills/`, `<pkg>/hooks/pre|post/`, `<pkg>/tools/`,
 *   `<pkg>/commands/`), not from `dist/` or `harness-*` (verified against
 *   pi-coding-agent `discovery/omp-plugins.ts` + omp 18.1.5 scratch install
 *   2026-09-03). The `hooks/` + `tools/` root mirrors are produced by the
 *   `build` script from the `dist/` bundles.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const sourceSkills = path.join(repoRoot, "skills");
const sourceCommands = path.join(repoRoot, "commands");
const sourceAgents = path.join(repoRoot, "agents");
const sourceAssets = path.join(repoRoot, "assets");
const sourcePluginManifest = path.join(repoRoot, ".omp-plugin", "plugin.json");

function copyTree(label: string, from: string, to: string) {
  if (!fs.existsSync(from)) {
    console.error(`bundle-harness-assets: missing ${label} directory: ${from}`);
    process.exit(1);
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

// Canonical bundled mirrors (opencode/dsh parity).
copyTree("skills", sourceSkills, path.join(packageRoot, "harness-skills"));
copyTree("commands", sourceCommands, path.join(packageRoot, "harness-commands"));
copyTree("agents", sourceAgents, path.join(packageRoot, "harness-agents"));
// omp convention-discovery mirrors at the package root.
copyTree("skills", sourceSkills, path.join(packageRoot, "skills"));
copyTree("commands", sourceCommands, path.join(packageRoot, "commands"));
copyTree("agents", sourceAgents, path.join(packageRoot, "agents"));
copyTree("assets", sourceAssets, path.join(packageRoot, "assets"));

// Package-root plugin.json (Agent Plugins format) — omp link/npm installs
// classify the root by this file; keep `.omp-plugin/plugin.json` as base.
if (!fs.existsSync(sourcePluginManifest)) {
  console.error(`bundle-harness-assets: missing omp plugin manifest: ${sourcePluginManifest}`);
  process.exit(1);
}
fs.copyFileSync(sourcePluginManifest, path.join(packageRoot, "plugin.json"));

console.log(
  `bundle-harness-assets: synced skills/commands/agents -> harness-* + root mirrors, assets -> assets, plugin.json`,
);
