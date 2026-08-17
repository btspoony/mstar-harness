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
 *     skipped (`skipped-existing` notes, zero add calls) — including rows
 *     that are present but disabled;
 *   - probe degradation: a failing `--dump-config` probe or a malformed
 *     (format-drifted) dump yields an explicit warning note while the adds
 *     still run (pinned no-op keeps it idempotent);
 *   - add failure: a non-zero `add` exit throws `Failed to install <spec>`;
 *   - stalled add: a hung pnpm forward is killed by the bounded subprocess
 *     timeout (ETIMEDOUT) instead of blocking the CLI forever;
 *   - `--dry-run` + `--no-fallbacks`: previews a single add with zero
 *     subprocesses.
 * Doctor (`runInstallDoctor`): reports each plugin row's capability state
 * with the AC-2 words `uninstalled` / `disabled` / `mounted` — issue states
 * (uninstalled/disabled) land in `errors` (CLI exits 1), every state also
 * gets a worded notes line (healthy runs show `mounted`), and an unusable
 * probe degrades into an explicit error rather than a silent pass. Disabled
 * rows are pinned in all literal marker shapes: standalone `enabled: false`,
 * standalone `disabled: true`, and inline `disabled: true` on the `- id:` /
 * `name:` lines.
 * Plus end-to-end wiring through the real CLI entry (`init --target dsh` /
 * `--no-fallbacks` / missing bin / `doctor --target dsh`) with the fake bin
 * injected via PATH.
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
 * builtins only so it works under a PATH restricted to the fake dir.
 * `opts.dumpExit` / `opts.addExit` force a non-zero exit on the
 * `--dump-config` / `plugin ... add` branches to simulate probe and add
 * failures; `opts.addSleepSec` makes the add branch sleep first (via
 * /bin/sleep, PATH-independent) to simulate a stalled pnpm forward. */
function makeFakeDsh(
  dumpFixture: string,
  opts: { dumpExit?: number; addExit?: number; addSleepSec?: number } = {},
): FakeDsh {
  const binDir = mkdtempSync(join(tmpdir(), "dsh-fake-"));
  const logFile = join(binDir, "argv.log");
  const dumpFile = join(binDir, "dump.yml");
  writeFileSync(dumpFile, dumpFixture);
  const dumpExit = opts.dumpExit ?? 0;
  const addExit = opts.addExit ?? 0;
  const addSleep = opts.addSleepSec ? `  /bin/sleep ${opts.addSleepSec}\n` : "";
  const binPath = join(binDir, "dsh");
  writeFileSync(
    binPath,
    [
      "#!/bin/sh",
      `echo "$@" >> "${logFile}"`,
      'if [ "$1" = "--version" ]; then exit 0; fi',
      `if [ "$1" = "--profile" ] && [ "$3" = "--dump-config" ]; then`,
      `  while IFS= read -r line; do printf '%s\\n' "$line"; done < "${dumpFile}"`,
      `  exit ${dumpExit}`,
      "fi",
      'if [ "$1" = "plugin" ]; then',
      addSleep,
      `  exit ${addExit}`,
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

/** Run fn with an env var set (snapshot/restore). */
function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
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

/** Fallbacks row present but disabled via patch — `enabled: false` is the
 * shape observed on dsh 0.1.0-rc.6 when cordis.patch.yml disables a row. */
const DUMP_FALLBACKS_DISABLED = [
  "# == @mstar-harness/dsh",
  "- id: mstar",
  "  name: '@mstar-harness/dsh'",
  "  config: {}",
  "# == dsh-llm-fallbacks, patched by .../cordis.patch.yml",
  "- id: llm-fallbacks",
  "  name: dsh-llm-fallbacks",
  "  config: {}",
  "  enabled: false",
  "",
].join("\n");

/** Fallbacks row disabled via a literal `disabled: true` line — the built-in
 * shape observed on dsh 0.1.0-rc.6 (fresh-profile dump: the `hmr` row carries
 * a standalone 2-space `disabled: true` under a `patched by ...` header). */
const DUMP_FALLBACKS_DISABLED_TRUE = [
  "# == @mstar-harness/dsh",
  "- id: mstar",
  "  name: '@mstar-harness/dsh'",
  "  config: {}",
  "# == dsh-llm-fallbacks, patched by .../cordis.patch.yml",
  "- id: llm-fallbacks",
  "  name: dsh-llm-fallbacks",
  "  config: {}",
  "  disabled: true",
  "",
].join("\n");

/** Fallbacks row disabled inline on the `- id:` line (hypothetical dump-shape
 * drift; the parser must still report the row as disabled, never mounted). */
const DUMP_FALLBACKS_DISABLED_INLINE_ID = [
  "# == @mstar-harness/dsh",
  "- id: mstar",
  "  name: '@mstar-harness/dsh'",
  "  config: {}",
  "# == dsh-llm-fallbacks, patched by .../cordis.patch.yml",
  "- id: llm-fallbacks, disabled: true",
  "  name: dsh-llm-fallbacks",
  "  config: {}",
  "",
].join("\n");

/** Fallbacks row disabled inline on the `name:` line (same drift class). */
const DUMP_FALLBACKS_DISABLED_INLINE_NAME = [
  "# == @mstar-harness/dsh",
  "- id: mstar",
  "  name: '@mstar-harness/dsh'",
  "  config: {}",
  "# == dsh-llm-fallbacks, patched by .../cordis.patch.yml",
  "- id: llm-fallbacks",
  "  name: dsh-llm-fallbacks, disabled: true",
  "  config: {}",
  "",
].join("\n");

/** Only the mstar row present; fallbacks uninstalled. */
const DUMP_FALLBACKS_MISSING = [
  "# == @mstar-harness/dsh",
  "- id: mstar",
  "  name: '@mstar-harness/dsh'",
  "  config: {}",
  "",
].join("\n");

/** Only the fallbacks row present; mstar uninstalled. */
const DUMP_MSTAR_MISSING = [
  "# == dsh-llm-fallbacks",
  "- id: llm-fallbacks",
  "  name: dsh-llm-fallbacks",
  "  config: {}",
  "",
].join("\n");

/** mstar row present but disabled; fallbacks mounted. */
const DUMP_MSTAR_DISABLED = [
  "# == @mstar-harness/dsh",
  "- id: mstar",
  "  name: '@mstar-harness/dsh'",
  "  config: {}",
  "  enabled: false",
  "# == dsh-llm-fallbacks",
  "- id: llm-fallbacks",
  "  name: dsh-llm-fallbacks",
  "  config: {}",
  "",
].join("\n");

/** Non-empty output with no parseable loader entries (format drift). */
const DUMP_MALFORMED = [
  "not a loader dump",
  "some: other: thing",
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
      expect(result!.location).toContain(join("profiles", "web"));
    } finally {
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

  test("dry-run + --no-fallbacks: previews a single add, zero subprocesses", () => {
    const fake = makeFakeDsh(DUMP_EMPTY);
    try {
      let result: { location: string; notes: string[] } | undefined;
      withPath(fake.binDir, () => {
        result = dshAdapter.runInstallInit?.("global", true, { noFallbacks: true });
      });
      expect(result).toBeDefined();
      expect(argvLines(fake)).toEqual([]);
      expectNote(result!.notes, `Would run: dsh plugin --profile web add ${MSTAR_SPEC}`);
      expectNote(result!.notes, `skipped-by-flag: ${FALLBACKS_SPEC}`);
      expect(result!.notes.filter((note) => note.startsWith("Would run:")).length).toBe(1);
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

  test("idempotent: a present-but-disabled row still counts as installed (skipped-existing)", () => {
    const fake = makeFakeDsh(DUMP_FALLBACKS_DISABLED);
    try {
      let result: { location: string; notes: string[] } | undefined;
      withPath(fake.binDir, () => {
        result = dshAdapter.runInstallInit?.("global", false);
      });
      expect(result).toBeDefined();
      expect(addLines(fake)).toEqual([]);
      expectNote(result!.notes, `skipped-existing: ${MSTAR_SPEC}`);
      expectNote(result!.notes, `skipped-existing: ${FALLBACKS_SPEC}`);
    } finally {
      fake.remove();
    }
  });

  test("probe failure (dump non-zero exit): warning note + still adds both (M4)", () => {
    const fake = makeFakeDsh(DUMP_EMPTY, { dumpExit: 1 });
    try {
      let result: { location: string; notes: string[] } | undefined;
      withPath(fake.binDir, () => {
        result = dshAdapter.runInstallInit?.("global", false);
      });
      expect(result).toBeDefined();
      expectNote(result!.notes, "Warning: could not probe installed plugins");
      expect(addLines(fake)).toEqual([
        `plugin --profile web add ${MSTAR_SPEC}`,
        `plugin --profile web add ${FALLBACKS_SPEC}`,
      ]);
    } finally {
      fake.remove();
    }
  });

  test("malformed dump (format drift): parse-degradation warning + still adds both (M3)", () => {
    const fake = makeFakeDsh(DUMP_MALFORMED);
    try {
      let result: { location: string; notes: string[] } | undefined;
      withPath(fake.binDir, () => {
        result = dshAdapter.runInstallInit?.("global", false);
      });
      expect(result).toBeDefined();
      expectNote(result!.notes, "Warning: could not parse installed plugins from dump");
      expect(addLines(fake)).toEqual([
        `plugin --profile web add ${MSTAR_SPEC}`,
        `plugin --profile web add ${FALLBACKS_SPEC}`,
      ]);
    } finally {
      fake.remove();
    }
  });

  test("add non-zero exit: throws Failed to install <spec> (M6)", () => {
    const fake = makeFakeDsh(DUMP_EMPTY, { addExit: 1 });
    try {
      let error: unknown;
      withPath(fake.binDir, () => {
        try {
          dshAdapter.runInstallInit?.("global", false);
        } catch (e) {
          error = e;
        }
      });
      expect(String(error)).toContain(`Failed to install ${MSTAR_SPEC}`);
      // The failing add was still attempted (argv recorded before the exit).
      expect(addLines(fake)).toEqual([`plugin --profile web add ${MSTAR_SPEC}`]);
    } finally {
      fake.remove();
    }
  });

  test("stalled add (hung pnpm forward) is killed by the subprocess timeout (S-001)", () => {
    const fake = makeFakeDsh(DUMP_EMPTY, { addSleepSec: 30 });
    try {
      let error: unknown;
      withPath(fake.binDir, () => {
        // Shrink the conservative 300s network ceiling so the kill path is
        // exercised fast: the fake add branch sleeps 30s, the timeout fires
        // in 300ms, execFileSync kills the child and throws.
        withEnv("MSTAR_DSH_SUBPROCESS_TIMEOUT_MS", "300", () => {
          try {
            dshAdapter.runInstallInit?.("global", false);
          } catch (e) {
            error = e;
          }
        });
      });
      expect(String(error)).toContain(`Failed to install ${MSTAR_SPEC}`);
      // The timeout fired (execFileSync kills the child with SIGTERM and
      // reports ETIMEDOUT), it did not simply exit non-zero.
      expect(String(error)).toContain("ETIMEDOUT");
      // The add was attempted and killed (argv recorded before the sleep).
      expect(addLines(fake)).toEqual([`plugin --profile web add ${MSTAR_SPEC}`]);
    } finally {
      fake.remove();
    }
  });
});

describe("dshAdapter.runInstallDoctor", () => {
  test("both rows mounted: healthy, capability words present in notes", () => {
    const fake = makeFakeDsh(DUMP_BOTH);
    try {
      let result: { location: string; errors: string[]; notes?: string[] } | undefined;
      withPath(fake.binDir, () => {
        result = dshAdapter.runInstallDoctor?.("global");
      });
      expect(result).toBeDefined();
      expect(result!.errors).toEqual([]);
      expectNote(result!.notes ?? [], `${MSTAR_SPEC}: mounted`);
      expectNote(result!.notes ?? [], `${FALLBACKS_SPEC}: mounted`);
    } finally {
      fake.remove();
    }
  });

  for (const [label, dump] of [
    ["enabled: false standalone", DUMP_FALLBACKS_DISABLED],
    ["disabled: true standalone", DUMP_FALLBACKS_DISABLED_TRUE],
    ["disabled: true inline on the - id: line", DUMP_FALLBACKS_DISABLED_INLINE_ID],
    ["disabled: true inline on the name: line", DUMP_FALLBACKS_DISABLED_INLINE_NAME],
  ] as const) {
    test(`fallbacks disabled (${label}): notes say disabled, errors carry the issue`, () => {
      const fake = makeFakeDsh(dump);
      try {
        let result: { location: string; errors: string[]; notes?: string[] } | undefined;
        withPath(fake.binDir, () => {
          result = dshAdapter.runInstallDoctor?.("global");
        });
        expect(result).toBeDefined();
        expectNote(result!.notes ?? [], `${MSTAR_SPEC}: mounted`);
        expectNote(result!.notes ?? [], `${FALLBACKS_SPEC}: disabled`);
        expect(result!.errors.some((line) => line.includes(`${FALLBACKS_SPEC} is disabled`))).toBe(true);
      } finally {
        fake.remove();
      }
    });
  }

  test("fallbacks missing: notes say uninstalled, errors carry the issue", () => {
    const fake = makeFakeDsh(DUMP_FALLBACKS_MISSING);
    try {
      let result: { location: string; errors: string[]; notes?: string[] } | undefined;
      withPath(fake.binDir, () => {
        result = dshAdapter.runInstallDoctor?.("global");
      });
      expect(result).toBeDefined();
      expectNote(result!.notes ?? [], `${MSTAR_SPEC}: mounted`);
      expectNote(result!.notes ?? [], `${FALLBACKS_SPEC}: uninstalled`);
      expect(result!.errors.some((line) => line.includes(`${FALLBACKS_SPEC} is uninstalled`))).toBe(true);
    } finally {
      fake.remove();
    }
  });

  test("mstar missing: errors carry the uninstalled issue", () => {
    const fake = makeFakeDsh(DUMP_MSTAR_MISSING);
    try {
      let result: { location: string; errors: string[]; notes?: string[] } | undefined;
      withPath(fake.binDir, () => {
        result = dshAdapter.runInstallDoctor?.("global");
      });
      expect(result).toBeDefined();
      expectNote(result!.notes ?? [], `${MSTAR_SPEC}: uninstalled`);
      expectNote(result!.notes ?? [], `${FALLBACKS_SPEC}: mounted`);
      expect(result!.errors.some((line) => line.includes(`${MSTAR_SPEC} is uninstalled`))).toBe(true);
    } finally {
      fake.remove();
    }
  });

  test("mstar disabled: errors carry the disabled issue", () => {
    const fake = makeFakeDsh(DUMP_MSTAR_DISABLED);
    try {
      let result: { location: string; errors: string[]; notes?: string[] } | undefined;
      withPath(fake.binDir, () => {
        result = dshAdapter.runInstallDoctor?.("global");
      });
      expect(result).toBeDefined();
      expectNote(result!.notes ?? [], `${MSTAR_SPEC}: disabled`);
      expectNote(result!.notes ?? [], `${FALLBACKS_SPEC}: mounted`);
      expect(result!.errors.some((line) => line.includes(`${MSTAR_SPEC} is disabled`))).toBe(true);
    } finally {
      fake.remove();
    }
  });

  test("probe failure: explicit degradation error, not a silent pass", () => {
    const fake = makeFakeDsh(DUMP_BOTH, { dumpExit: 1 });
    try {
      let result: { location: string; errors: string[]; notes?: string[] } | undefined;
      withPath(fake.binDir, () => {
        result = dshAdapter.runInstallDoctor?.("global");
      });
      expect(result).toBeDefined();
      expect(result!.errors.some((line) => line.includes("could not probe installed plugins"))).toBe(true);
      expect(result!.errors.some((line) => line.includes("cannot verify install state"))).toBe(true);
    } finally {
      fake.remove();
    }
  });

  test("malformed dump: explicit parse-degradation error, not a silent pass", () => {
    const fake = makeFakeDsh(DUMP_MALFORMED);
    try {
      let result: { location: string; errors: string[]; notes?: string[] } | undefined;
      withPath(fake.binDir, () => {
        result = dshAdapter.runInstallDoctor?.("global");
      });
      expect(result).toBeDefined();
      expect(result!.errors.some((line) => line.includes("could not parse installed plugins from dump"))).toBe(
        true,
      );
      // Same granularity as the probe-failure test: the degradation line must
      // keep its "cannot verify install state" tail (wording-drift guard).
      expect(result!.errors.some((line) => line.includes("cannot verify install state"))).toBe(true);
    } finally {
      fake.remove();
    }
  });

  test("missing dsh bin: doctor reports the fail-loud error", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "dsh-nobin-"));
    try {
      let result: { location: string; errors: string[]; notes?: string[] } | undefined;
      withPath(emptyDir, () => {
        result = dshAdapter.runInstallDoctor?.("global");
      });
      expect(result).toBeDefined();
      expect(result!.errors.some((line) => line.includes("dsh CLI not found on PATH"))).toBe(true);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
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

describe("CLI doctor --target dsh (fake dsh on PATH)", () => {
  const fakePathEnv = (fake: FakeDsh): { PATH: string } => ({
    PATH: `${fake.binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
  });

  test("both mounted: exit 0 and capability words are printed on the healthy run (AC-2)", () => {
    const fake = makeFakeDsh(DUMP_BOTH);
    try {
      const result = runCli(["doctor", "--target", "dsh"], { env: fakePathEnv(fake) });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`${MSTAR_SPEC}: mounted`);
      expect(result.stdout).toContain(`${FALLBACKS_SPEC}: mounted`);
      expect(result.stdout).toContain("Doctor result: healthy");
    } finally {
      fake.remove();
    }
  });

  test("fallbacks disabled: exit 1 and the disabled issue is printed", () => {
    const fake = makeFakeDsh(DUMP_FALLBACKS_DISABLED);
    try {
      const result = runCli(["doctor", "--target", "dsh"], { env: fakePathEnv(fake) });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(`${FALLBACKS_SPEC}: disabled`);
      expect(result.stdout).toContain(`${FALLBACKS_SPEC} is disabled`);
    } finally {
      fake.remove();
    }
  });

  test("disabled: true standalone row: exit 1 and the disabled issue is printed", () => {
    const fake = makeFakeDsh(DUMP_FALLBACKS_DISABLED_TRUE);
    try {
      const result = runCli(["doctor", "--target", "dsh"], { env: fakePathEnv(fake) });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(`${FALLBACKS_SPEC}: disabled`);
      expect(result.stdout).toContain(`${FALLBACKS_SPEC} is disabled`);
    } finally {
      fake.remove();
    }
  });

  test("probe failure: exit 1 with the explicit degradation line (no silent pass)", () => {
    const fake = makeFakeDsh(DUMP_BOTH, { dumpExit: 1 });
    try {
      const result = runCli(["doctor", "--target", "dsh"], { env: fakePathEnv(fake) });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("could not probe installed plugins");
      expect(result.stdout).toContain("cannot verify install state");
    } finally {
      fake.remove();
    }
  });
});
