import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureHostPresent, HOST_PRESENCE_BINARIES, HostPresenceRefusal } from "../src/adapters/host-presence";
import type { ProbeCommandRunner } from "../src/types";

const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalProjectRoot = process.env.MSTAR_CLI_PROJECT_ROOT;
const tempDirs: string[] = [];
const adapterHome = mkdtempSync(path.join(os.tmpdir(), "host-presence-adapter-home-"));
afterAll(() => rmSync(adapterHome, { recursive: true, force: true }));

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalProjectRoot === undefined) delete process.env.MSTAR_CLI_PROJECT_ROOT;
  else process.env.MSTAR_CLI_PROJECT_ROOT = originalProjectRoot;
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
function useAdapterHome(existingHarness = false): string {
  process.env.HOME = adapterHome;
  if (existingHarness) {
    const harness = path.join(adapterHome, ".mstar", "harness");
    mkdirSync(path.join(harness, ".omp-plugin"), { recursive: true });
    mkdirSync(path.join(harness, ".git"), { recursive: true });
    writeFileSync(path.join(harness, ".omp-plugin", "plugin.json"), "{}");
  }
  return adapterHome;
}

function captureError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected the adapter to refuse the install.");
}

describe("shared host-presence probe (injectable runner)", () => {
  test("throws typed, actionable refusals for the CLI targets with missing binaries", async () => {
    const expected = [
      ["omp", "omp", "Install Oh My Pi"],
      ["codex", "codex", "Install the Codex CLI"],
      ["dsh", "dsh", "Install the DeepSeek Harness CLI"],
      ["cursor", "cursor-agent", "Install Cursor (https://cursor.com) — the Cursor IDE / cursor-agent CLI — then re-run init"],
      ["kimi", "kimi", "https://www.kimi.com/code/docs/kimi-code-cli/"],
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
    const targets = ["omp", "cursor", "kimi"] as const;
    for (const target of targets) {
      await expect(ensureHostPresent(target, runner)).resolves.toBe(HOST_PRESENCE_BINARIES[target]);
    }
    expect(calls).toEqual([["omp", "--version"], ["cursor-agent", "--version"], ["kimi", "--version"]]);
  });
  test("zcode is absent from the host-presence map", () => {
    expect(HOST_PRESENCE_BINARIES).not.toHaveProperty("zcode");
  });
});

describe("omp host presence at init", () => {
  test("real init refuses before writes; dry-run still previews link without probing", async () => {
    const root = tempDir("omp-presence-project-");
    const home = useAdapterHome();
    process.env.PATH = tempDir("omp-presence-path-");
    process.env.MSTAR_CLI_PROJECT_ROOT = root;
    // Dynamic import is intentional: shared-install captures its HOME-derived path at module load.
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
describe("cursor and kimi host presence at init", () => {
  test("real init refuses before writes; dry-run previews without probing", async () => {
    for (const target of ["cursor", "kimi"] as const) {
      const home = useAdapterHome();
      const root = tempDir(`${target}-presence-project-`);
      absentOnPath();
      process.env.MSTAR_CLI_PROJECT_ROOT = root;
      // Dynamic import is intentional: shared-install captures HOME-derived paths at module load.
      const adapter = target === "cursor"
        ? (await import("../src/adapters/cursor")).cursorAdapter
        : (await import("../src/adapters/kimi")).kimiAdapter;
      let refusal: unknown;
      try {
        await adapter.runInstallInit?.("project", false);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(HostPresenceRefusal);
      expect(refusal).toMatchObject({
        target,
        binary: target === "cursor" ? "cursor-agent" : "kimi",
      });
      expect((refusal as Error).message).toContain(`${target === "cursor" ? "cursor-agent" : "kimi"} CLI not found on PATH`);
      expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
      expect(existsSync(path.join(home, ".mstar", "harness"))).toBe(false);
      const message = (refusal as Error).message;
      if (target === "cursor") {
        expect(message).toContain("Install Cursor (https://cursor.com)");
        expect(message).toContain("then re-run init");
      } else {
        expect(message).toContain("Install the Kimi Code CLI (https://www.kimi.com/code/docs/kimi-code-cli/)");
        expect(message).toContain("npx @mstar-harness/cli init --target kimi --scope <global|project>");
      }
      const preview = await adapter.runInstallInit?.("project", true);
      expect(preview?.notes.length).toBeGreaterThan(0);
      expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
      expect(existsSync(path.join(home, ".mstar", "harness"))).toBe(false);
    }
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
      "cursor-agent": `if [ "$1" = "--version" ]; then echo "cursor-agent test"; fi
exit 0`,
      kimi: `if [ "$1" = "--version" ]; then echo "kimi test"; fi
exit 0`,
      git: "exit 0",
    };
    for (const [name, script] of Object.entries(commands)) {
      const executable = path.join(binDir, name);
      writeFileSync(executable, `#!/bin/sh\n${script}\n`);
      chmodSync(executable, 0o755);
    }
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
      cursor: "Install Cursor (https://cursor.com) — the Cursor IDE / cursor-agent CLI — then re-run init",
      kimi: "https://www.kimi.com/code/docs/kimi-code-cli/",
    };
    const previewLine = {
      omp: "Would run: omp plugin link",
      codex: "Would run: codex plugin marketplace add",
      dsh: "Would run: dsh plugin",
      cursor: "Would clone",
      kimi: "Install via Kimi TUI: /plugins install",
    };
    for (const target of ["omp", "codex", "dsh", "cursor", "kimi"] as const) {
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
      expect(present.output).not.toContain(`${target === "cursor" ? "cursor-agent" : target} CLI not found on PATH`);
      if (target === "cursor" || target === "kimi") {
        expect(present.result.exitCode).toBe(0);
        expect(present.output).toContain("Status: configured");
      }
      console.log(`[smoke ${target} real/stub] ${present.output.trim().replaceAll("\n", " | ")}`);
    }
  }, 30_000);
});

describe("codex and dsh presence behavior remains pinned", () => {
  test("codex missing-binary refusal and dry-run preview are unchanged", async () => {
    const home = useAdapterHome(true);
    const root = tempDir("codex-presence-project-");
    absentOnPath();
    process.env.MSTAR_CLI_PROJECT_ROOT = root;
    // Dynamic import is intentional: shared-install captures its HOME-derived path at module load.
    const adapter = await import("../src/adapters/codex");
    const refusal = captureError(() => adapter.codexAdapter.runInstallInit?.("project", false));
    expect(refusal.message).toContain("codex CLI not found on PATH");
    expect(refusal.message).toContain("npm install -g @openai/codex");
    expect(refusal.message).toContain("then re-run init");
    expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
    const preview = adapter.codexAdapter.runInstallInit?.("project", true);
    expect(preview?.notes.some((note) => note.includes("Would run: codex plugin marketplace add"))).toBe(true);
    expect(existsSync(path.join(home, ".mstar", "harness"))).toBe(true);
    expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
  });

  test("dsh missing-binary refusal and pure dry-run preview are unchanged", async () => {
    const home = useAdapterHome();
    const root = tempDir("dsh-presence-project-");
    absentOnPath();
    process.env.MSTAR_CLI_PROJECT_ROOT = root;
    // Dynamic import is intentional: shared-install captures its HOME-derived path at module load.
    const adapter = await import("../src/adapters/dsh");
    const refusal = captureError(() => adapter.dshAdapter.runInstallInit?.("project", false));
    expect(refusal.message).toContain("dsh CLI not found on PATH");
    expect(refusal.message).toContain("pnpm add -g @deepseek-ai/dsh");
    expect(refusal.message).toContain("then re-run init");
    expect(existsSync(path.join(home, ".dsh"))).toBe(false);
    const preview = adapter.dshAdapter.runInstallInit?.("project", true);
    expect(preview?.notes.some((note) => note.includes("Would run: dsh plugin"))).toBe(true);
    expect(existsSync(path.join(home, ".dsh"))).toBe(false);
    expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
  });
});
