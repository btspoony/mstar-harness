/**
 * dsh target adapter — install orchestration (`runInstallInit`).
 *
 * Drives the adapter with a fake `dsh` executable injected on PATH (a shell
 * script that records argv to a log file and serves a `--dump-config`
 * fixture), so the exact subprocess surface is asserted without a real dsh
 * install:
 *   - default install: two `dsh plugin --profile web add <spec>` calls,
 *     mstar first then dsh-llm-fallbacks (F4 double-command contract, AC-6);
 *   - `--no-fallbacks`: one add (mstar only), fallbacks noted skipped-by-flag;
 *   - missing dsh bin: fail-loud throw carrying an install hint;
 *   - dry-run: no subprocess at all, notes preview the would-run commands;
 *   - idempotency: lines already present in the composed loader tree are
 *     skipped (`skipped-existing` notes, zero add calls).
 * Plus end-to-end wiring through the real CLI entry (`init --target dsh` /
 * `--no-fallbacks` / missing bin) with the fake bin injected via PATH.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dshAdapter } from "../src/adapters/dsh";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

/** Spawn env with ambient harness env vars pinned out (same convention as
 * the other cli suites): the CLI would otherwise resolve harness dirs from
 * MSTAR_HARNESS_DIR and redirect fixtures. */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR" || key === "MSTAR_WORKING_BRANCH") {
      continue;
    }
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Run the real CLI entry as a subprocess; cwd + env overrides per test. */
function runCli(args: string[], opts: { env?: Record<string, string> } = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: CLI_ROOT,
    env: { ...cliEnv(), ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

interface FakeDsh {
  binDir: string;
  logFile: string;
  remove: () => void;
}

/** Create a fake `dsh` executable in a temp dir: records argv (space-joined)
 * to logFile, answers `--version` (exit 0), prints the `--dump-config`
 * fixture, and exits 0 for `plugin ... add ...`. The script uses shell
 * builtins only so it works under a PATH restricted to the fake dir. */
function makeFakeDsh(dumpFixture: string): FakeDsh {
  const binDir = mkdtempSync(join(tmpdir(), "dsh-fake-"));
  const logFile = join(binDir, "argv.log");
  const dumpFile = join(binDir, "dump.yml");
  writeFileSync(dumpFile, dumpFixture);
  const binPath = join(binDir, "dsh");
  writeFileSync(
    binPath,
    [
      "#!/bin/sh",
      `echo "$@" >> "${logFile}"`,
      'if [ "$1" = "--version" ]; then exit 0; fi',
      `if [ "$1" = "--profile" ] && [ "$3" = "--dump-config" ]; then`,
      `  while IFS= read -r line; do printf '%s\\n' "$line"; done < "${dumpFile}"`,
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n") + "\n",
  );
  chmodSync(binPath, 0o755);
  return { binDir, logFile, remove: () => rmSync(binDir, { recursive: true, force: true }) };
}

/** Run fn with PATH restricted to `pathEntry` (snapshot/restore). */
function withPath(pathEntry: string, fn: () => void): void {
  const prev = process.env.PATH;
  process.env.PATH = pathEntry;
  try {
    fn();
  } finally {
    process.env.PATH = prev;
  }
}

/** All recorded invocations, one line per argv (space-joined). A missing
 * log means no subprocess ever ran (e.g. dry-run). */
function argvLines(fake: FakeDsh): string[] {
  if (!existsSync(fake.logFile)) return [];
  const raw = readFileSync(fake.logFile, "utf8").trim();
  return raw ? raw.split("\n") : [];
}

/** Only the `plugin --profile web add <spec>` invocations (the F4 contract). */
function addLines(fake: FakeDsh): string[] {
  return argvLines(fake).filter((line) => line.startsWith("plugin --profile web add "));
}

/** Assert one notes line carries the marker prefix (notes append trailing
 * detail after the marker, so exact element match would be wrong). */
function expectNote(notes: string[], marker: string): void {
  expect(notes.some((note) => note.startsWith(marker))).toBe(true);
}

const MSTAR_SPEC = "@mstar-harness/dsh";
const FALLBACKS_SPEC = "dsh-llm-fallbacks";

/** Empty loader tree: nothing installed. */
const DUMP_EMPTY = "";

/** Loader tree with both plugin lines present (real dump-config shape:
 * `# == <bundle>` header, then `- id: <id>` / `name: <spec>` loader entries). */
const DUMP_BOTH = [
  "# == @mstar-harness/dsh",
  "- id: mstar",
  "  name: '@mstar-harness/dsh'",
  "  config: {}",
  "# == dsh-llm-fallbacks",
  "- id: llm-fallbacks",
  "  name: dsh-llm-fallbacks",
  "  config: {}",
  "",
].join("\n");

describe("dshAdapter.runInstallInit", () => {
  test("default install: two adds, mstar first then fallbacks (AC-6)", () => {
    const fake = makeFakeDsh(DUMP_EMPTY);
    try {
      let result: { location: string; notes: string[] } | undefined;
      withPath(fake.binDir, () => {
        result = dshAdapter.runInstallInit?.("global", false);
      });
      expect(result).toBeDefined();
      expect(addLines(fake)).toEqual([
        `plugin --profile web add ${MSTAR_SPEC}`,
        `plugin --profile web add ${FALLBACKS_SPEC}`,
      ]);
      expectNote(result!.notes, `installed: ${MSTAR_SPEC}`);
      expectNote(result!.notes, `installed: ${FALLBACKS_SPEC}`);
      expect(result!.location).toContain(join("profiles", "web"));    } finally {
      fake.remove();
    }
  });

  test("--no-fallbacks: only the mstar add runs; fallbacks noted skipped-by-flag", () => {
    const fake = makeFakeDsh(DUMP_EMPTY);
    try {
      let result: { location: string; notes: string[] } | undefined;
      withPath(fake.binDir, () => {
        result = dshAdapter.runInstallInit?.("global", false, { noFallbacks: true });
      });
      expect(result).toBeDefined();
      expect(addLines(fake)).toEqual([`plugin --profile web add ${MSTAR_SPEC}`]);
      expectNote(result!.notes, `skipped-by-flag: ${FALLBACKS_SPEC}`);
    } finally {
      fake.remove();
    }
  });

  test("missing dsh bin: fail-loud throw carrying an install hint", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "dsh-nobin-"));
    try {
      let error: unknown;
      withPath(emptyDir, () => {
        try {
          dshAdapter.runInstallInit?.("global", false);
        } catch (e) {
          error = e;
        }
      });
      expect(String(error)).toContain("dsh CLI not found on PATH");
      expect(String(error)).toContain("@deepseek-ai/dsh");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("dry-run: no subprocess at all; notes preview the would-run adds", () => {
    const fake = makeFakeDsh(DUMP_EMPTY);
    try {
      let result: { location: string; notes: string[] } | undefined;
      withPath(fake.binDir, () => {
        result = dshAdapter.runInstallInit?.("global", true);
      });
      expect(result).toBeDefined();
      expect(argvLines(fake)).toEqual([]);
      expectNote(result!.notes, `Would run: dsh plugin --profile web add ${MSTAR_SPEC}`);
      expectNote(result!.notes, `Would run: dsh plugin --profile web add ${FALLBACKS_SPEC}`);
    } finally {
      fake.remove();
    }
  });

  test("idempotent: already-installed lines are skipped (skipped-existing)", () => {
    const fake = makeFakeDsh(DUMP_BOTH);
    try {
      let result: { location: string; notes: string[] } | undefined;
      withPath(fake.binDir, () => {
        result = dshAdapter.runInstallInit?.("global", false);
      });
      expect(result).toBeDefined();
      expect(addLines(fake)).toEqual([]);
      // The only subprocesses are the availability check + installed-state probe.
      expect(argvLines(fake)).toEqual(["--version", "--profile web --dump-config"]);
      expectNote(result!.notes, `skipped-existing: ${MSTAR_SPEC}`);
      expectNote(result!.notes, `skipped-existing: ${FALLBACKS_SPEC}`);
    } finally {
      fake.remove();
    }
  });
});

describe("CLI init --target dsh (fake dsh on PATH)", () => {
  const fakePathEnv = (fake: FakeDsh): { PATH: string } => ({
    PATH: `${fake.binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
  });

  test("wires --target dsh through the adapter (two adds, exit 0)", () => {
    const fake = makeFakeDsh(DUMP_EMPTY);
    try {
      const result = runCli(["init", "--target", "dsh"], { env: fakePathEnv(fake) });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`installed: ${MSTAR_SPEC}`);
      expect(result.stdout).toContain(`installed: ${FALLBACKS_SPEC}`);
      expect(addLines(fake)).toEqual([
        `plugin --profile web add ${MSTAR_SPEC}`,
        `plugin --profile web add ${FALLBACKS_SPEC}`,
      ]);
    } finally {
      fake.remove();
    }
  });

  test("--no-fallbacks maps to a single mstar add", () => {
    const fake = makeFakeDsh(DUMP_EMPTY);
    try {
      const result = runCli(["init", "--target", "dsh", "--no-fallbacks"], { env: fakePathEnv(fake) });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`skipped-by-flag: ${FALLBACKS_SPEC}`);
      expect(addLines(fake)).toEqual([`plugin --profile web add ${MSTAR_SPEC}`]);
    } finally {
      fake.remove();
    }
  });

  test("missing dsh bin: Setup failed + exit 1 (fail-loud, no silent skip)", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "dsh-nobin-"));
    try {
      const result = runCli(["init", "--target", "dsh"], { env: { PATH: emptyDir } });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Setup failed: dsh CLI not found on PATH");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
