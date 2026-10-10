import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureHostPresent, HOST_PRESENCE_BINARIES, HostPresenceRefusal } from "../src/adapters/host-presence";
import type { ProbeCommandRunner } from "../src/types";

const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalProjectRoot = process.env.MSTAR_CLI_PROJECT_ROOT;
const originalHarnessDir = process.env.MSTAR_HARNESS_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalProjectRoot === undefined) delete process.env.MSTAR_CLI_PROJECT_ROOT;
  else process.env.MSTAR_CLI_PROJECT_ROOT = originalProjectRoot;
  if (originalHarnessDir === undefined) delete process.env.MSTAR_HARNESS_DIR;
  else process.env.MSTAR_HARNESS_DIR = originalHarnessDir;
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function absentOnPath(): string {
  const directory = tempDir("host-presence-empty-path-");
  process.env.PATH = directory;
  return directory;
}
function useHome(prefix: string, existingHarness = false): string {
  const home = tempDir(prefix);
  process.env.HOME = home;
  if (existingHarness) {
    const harness = path.join(home, ".mstar", "harness");
    mkdirSync(path.join(harness, ".omp-plugin"), { recursive: true });
    mkdirSync(path.join(harness, ".git"), { recursive: true });
    writeFileSync(path.join(harness, ".omp-plugin", "plugin.json"), "{}");
  }
  return home;
}

describe("shared host-presence probe (injectable runner)", () => {
  test("throws typed, actionable refusals for the CLI targets with missing binaries", async () => {
    const expected = [
      ["omp", "omp", "Install Oh My Pi"],
      ["codex", "codex", "Install the Codex CLI"],
      ["dsh", "dsh", "Install the DeepSeek Harness CLI"],
    ] as const;
    const runner: ProbeCommandRunner = async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    for (const [target, binary, hint] of expected) {
      let refusal: unknown;
      try {
        await ensureHostPresent(target, runner);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(HostPresenceRefusal);
      expect(refusal).toMatchObject({ target, binary });
      expect((refusal as Error).message).toContain(hint);
    }
  });

  test("a present host passes the gate using its mapped executable", async () => {
    const calls: string[][] = [];
    const runner: ProbeCommandRunner = async (command) => {
      calls.push([...command]);
      return "version";
    };
    await expect(ensureHostPresent("omp", runner)).resolves.toBe("omp");
    expect(calls).toEqual([["omp", "--version"]]);
  });

  test("zcode is absent from the host-presence map", () => {
    expect(HOST_PRESENCE_BINARIES).not.toHaveProperty("zcode");
  });
});

describe("omp host presence at init", () => {
  test("real init refuses before writes; dry-run still previews link without probing", async () => {
    const root = tempDir("omp-presence-project-");
    const home = useHome("omp-presence-home-");
    process.env.PATH = tempDir("omp-presence-path-");
    process.env.MSTAR_CLI_PROJECT_ROOT = root;
    const adapter = await import("../src/adapters/omp");
    let refusal: unknown;
    try {
      await adapter.ompAdapter.runInstallInit?.("project", false);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(HostPresenceRefusal);
    expect((refusal as Error).message).toContain("omp plugin install @mstar-harness/omp");
    expect(existsSync(path.join(home, ".mstar", "harness"))).toBe(false);
    expect(existsSync(path.join(root, ".gitignore"))).toBe(false);

    const result = await adapter.ompAdapter.runInstallInit?.("project", true);
    expect(result?.notes.some((note) => note.includes("Would run: omp plugin link"))).toBe(true);
    expect(existsSync(path.join(home, ".mstar", "harness"))).toBe(false);
    expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
  });
});

// These are product-behaviour pins for existing adapter paths; no source behavior
// changes are intended for codex or dsh in this task.
const CLI_DIST = path.resolve(import.meta.dir, "../dist/mstar-harness.js");

function smokeCli(target: string, mode: "missing" | "stub", dryRun = false) {
  const home = tempDir(`host-presence-${target}-home-`);
  const root = tempDir(`host-presence-${target}-project-`);
  const binDir = tempDir(`host-presence-${target}-bin-`);
  const harness = path.join(home, ".mstar", "harness");
  mkdirSync(path.join(harness, ".omp-plugin"), { recursive: true });
  mkdirSync(path.join(harness, ".git"), { recursive: true });
  writeFileSync(path.join(harness, ".omp-plugin", "plugin.json"), "{}");
  if (mode === "stub") {
    const commands: Record<string, string> = {
      omp: `if [ "$1" = "--version" ]; then echo "omp test"; fi
exit 0`,
      codex: `if [ "$1" = "--version" ]; then echo "codex test"; elif [ "$*" = "plugin marketplace list --json" ]; then printf '{"marketplaces":[]}'; fi
exit 0`,
      dsh: `if [ "$1" = "--version" ]; then echo "dsh test"; elif [ "$*" = "--profile web --dump-config" ]; then echo "[]"; fi
exit 0`,
    };
    const executable = path.join(binDir, target);
    writeFileSync(executable, `#!/bin/sh\n${commands[target]}\n`);
    chmodSync(executable, 0o755);
  }
  const args = [
    "init", "--target", target, "--scope", "project", "--yes", "--no-global-cli",
    ...(dryRun ? ["--dry-run"] : []),
  ];
  const result = Bun.spawnSync([process.execPath, CLI_DIST, ...args], {
    cwd: root,
    env: {
      ...process.env,
      PATH: binDir,
      HOME: home,
      MSTAR_CLI_PROJECT_ROOT: root,
      MSTAR_HARNESS_DIR: path.join(home, ".mstar"),
      MSTAR_CONTROL_ROOT: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    home,
    root,
    result,
    output: `${result.stdout.toString()}\n${result.stderr.toString()}`,
  };
}

describe("repo-built CLI host-presence smoke", () => {
  test("real init refuses missing hosts, dry-run previews, and stub hosts pass presence gate", () => {
    const installLine = {
      omp: "omp plugin install @mstar-harness/omp",
      codex: "npm install -g @openai/codex",
      dsh: "pnpm add -g @deepseek-ai/dsh",
    };
    const previewLine = {
      omp: "Would run: omp plugin link",
      codex: "Would run: codex plugin marketplace add",
      dsh: "Would run: dsh plugin",
    };
    for (const target of ["omp", "codex", "dsh"] as const) {
      const refused = smokeCli(target, "missing");
      expect(refused.result.exitCode).not.toBe(0);
      expect(refused.output).toContain(installLine[target]);
      expect(existsSync(path.join(refused.root, ".gitignore"))).toBe(false);
      expect(readFileSync(path.join(refused.home, ".mstar", "harness", ".omp-plugin", "plugin.json"), "utf8")).toBe("{}");
      console.log(`[smoke ${target} real/missing] ${refused.output.split("\n").find((line) => line.includes(installLine[target]))}`);

      const preview = smokeCli(target, "missing", true);
      expect(preview.result.exitCode).toBe(0);
      expect(preview.output).toContain(previewLine[target]);
      expect(existsSync(path.join(preview.root, ".gitignore"))).toBe(false);
      console.log(`[smoke ${target} dry-run] ${preview.output.split("\n").find((line) => line.includes(previewLine[target]))}`);

      const present = smokeCli(target, "stub");
      expect(present.output).not.toContain(`${target} CLI not found on PATH`);
      console.log(`[smoke ${target} real/stub] ${present.output.trim().replaceAll("\n", " | ")}`);
    }
  });
});

describe("codex and dsh presence behavior remains pinned", () => {
  test("codex missing-binary refusal and dry-run preview are unchanged", async () => {
    const home = useHome("codex-presence-home-", true);
    const root = tempDir("codex-presence-project-");
    absentOnPath();
    process.env.MSTAR_CLI_PROJECT_ROOT = root;
    const adapter = await import("../src/adapters/codex");
    expect(() => adapter.codexAdapter.runInstallInit?.("project", false)).toThrow(
      "codex CLI not found on PATH. Install the Codex CLI (https://github.com/openai/codex), e.g. `npm install -g @openai/codex`, then re-run init.",
    );
    expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
    const preview = adapter.codexAdapter.runInstallInit?.("project", true);
    expect(preview?.notes.some((note) => note.includes("Would run: codex plugin marketplace add"))).toBe(true);
    expect(existsSync(path.join(home, ".mstar", "harness"))).toBe(true);
    expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
  });

  test("dsh missing-binary refusal and pure dry-run preview are unchanged", async () => {
    const home = useHome("dsh-presence-home-");
    const root = tempDir("dsh-presence-project-");
    absentOnPath();
    process.env.MSTAR_CLI_PROJECT_ROOT = root;
    const adapter = await import("../src/adapters/dsh");
    expect(() => adapter.dshAdapter.runInstallInit?.("project", false)).toThrow(
      "dsh CLI not found on PATH. Install the DeepSeek Harness CLI (@deepseek-ai/dsh), e.g. `pnpm add -g @deepseek-ai/dsh` or `npm install -g @deepseek-ai/dsh`, then re-run init.",
    );
    expect(existsSync(path.join(home, ".dsh"))).toBe(false);
    const preview = adapter.dshAdapter.runInstallInit?.("project", true);
    expect(preview?.notes.some((note) => note.includes("Would run: dsh plugin"))).toBe(true);
    expect(existsSync(path.join(home, ".dsh"))).toBe(false);
    expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
  });
});
