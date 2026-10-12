/**
 * CLI `mstar migrate` — the RETIRED verb.
 *
 * The v1-to-v2 file-staging writer is gone. `migrate` is now a mutation-free
 * refusal that names the supported replacement (`mstar store upgrade
 * --operator <name>`), so the CLI surface stays discoverable instead of
 * dropping the verb silently.
 *
 * The v1 fixture is the ENGINE's committed snapshot fixture
 * (`packages/engine/test/fixtures/migrate-real/` — the repo's single v1
 * fixture; CLI tests must not fork a second one).
 */
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");
/** Reuse the engine's committed v1 snapshot fixture (single v1 source). */
const V1_FIXTURE = join(CLI_ROOT, "..", "engine", "test", "fixtures", "migrate-real");

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn env with ambient harness env vars pinned out: an ambient value must
 * never redirect a fixture.
 */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: opts.cwd ?? CLI_ROOT,
    env: { ...cliEnv(), ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function fixtureTree(): string {
  const root = mkdtempSync(join(tmpdir(), "migrate-cli-fixture-"));
  cpSync(V1_FIXTURE, root, { recursive: true });
  return root;
}

function treeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full.slice(root.length + 1));
    }
  };
  walk(root);
  return out.sort();
}

interface CliEnvelope {
  version: number;
  command: string;
  status: string;
  code: string;
  exitCode: number;
  message?: string;
  details?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

function envelopeOf(result: RunResult, status?: string, code?: string): CliEnvelope {
  const envelope = JSON.parse(result.stdout) as CliEnvelope;
  expect(envelope.version).toBe(1);
  expect(envelope.command).toBe("migrate");
  expect(envelope.exitCode).toBe(result.exitCode);
  if (status !== undefined) expect(envelope.status).toBe(status);
  if (code !== undefined) expect(envelope.code).toBe(code);
  return envelope;
}

describe("mstar migrate — retired verb", () => {
  test("a v1 tree is refused with the supported replacement and writes nothing", () => {
    const root = fixtureTree();
    try {
      const before = treeFiles(root);
      const r = runCli(["migrate", "--path", root]);
      expect(r.exitCode).toBe(1);
      const envelope = envelopeOf(r, "refused", "migrate.verb-retired");
      expect(envelope.message).toContain("store upgrade");
      // The refusal names the supported route and mutates nothing.
      expect(treeFiles(root)).toEqual(before);
      expect(existsSync(join(root, "archived", "status.v1.json"))).toBe(false);
      expect(existsSync(join(root, "workflows"))).toBe(false);
      expect(existsSync(join(root, "store.db"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses the same way with no path and with a missing harness dir", () => {
    const root = fixtureTree();
    try {
      const cwd = runCli(["migrate"], { cwd: root });
      expect(cwd.exitCode).toBe(1);
      const envelope = envelopeOf(cwd, "refused", "migrate.verb-retired");
      expect(envelope.message).toContain("mstar store upgrade --operator <name>");
      // `--help` still reaches the verb so the retirement is discoverable.
      const help = runCli(["migrate", "--help"], { cwd: root });
      expect(help.exitCode).toBe(0);
      expect(`${help.stdout}${help.stderr}`).toContain("migrate");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
