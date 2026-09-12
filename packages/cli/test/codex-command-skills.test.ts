import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const adapterUrl = new URL("../src/adapters/codex.ts", import.meta.url).href;

// A fresh subprocess isolates os.homedir and imported installer constants
// from other tests. No HOME override, real config, CLI install, or network.
function dryRun(scope: "project" | "global", root: string) {
  const script = `import os from "node:os";
os.homedir = () => process.env.MSTAR_TEST_ROOT;
const { codexAdapter } = await import(${JSON.stringify(adapterUrl)});
console.log(JSON.stringify(codexAdapter.runInstallInit(${JSON.stringify(scope)}, true)));`;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: root,
    env: { ...process.env, MSTAR_TEST_ROOT: root, MSTAR_CLI_PROJECT_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString()) as { notes: string[] };
}

describe("amazing-e2e-check Codex command skill dry-run", () => {
  test("project reports the command-to-skill link without writing it", () => {
    const root = mkdtempSync(join(tmpdir(), "mstar-codex-command-"));
    try {
      const { notes } = dryRun("project", root);
      const source = join(root, ".mstar", "harness", "commands", "amazing-e2e-check.md");
      const destination = resolve(root, ".agents", "skills", "amazing-e2e-check", "SKILL.md");
      expect(notes).toContain(`Linked ${destination} -> ${source}`);
      expect(notes).toContain("Added .agents/skills/amazing-e2e-check to .gitignore");
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("global skips command links and retains the project-scope notice", () => {
    const root = mkdtempSync(join(tmpdir(), "mstar-codex-command-"));
    try {
      const { notes } = dryRun("global", root);
      expect(notes.some((note) => note.startsWith("Linked ") && note.includes("amazing-e2e-check"))).toBe(false);
      expect(notes.some((note) => note.includes("amazing-e2e-check") && note.includes("--scope project"))).toBe(true);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
