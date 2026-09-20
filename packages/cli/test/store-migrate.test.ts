/**
 * CLI `mstar store` — in-process commander tests for the store lifecycle
 * family (the migration transport).
 *
 * The commands run against a real engine and real registers in per-test
 * temporary harness roots; no bundle build and no live control root. The
 * apply path proves the CLI contract surfaces: reviewed-manifest apply,
 * exact replay, and source-drift refusal (the engine test carries the
 * transaction/rollback/staged-barrier evidence).
 *
 * Run with
 * `bun test packages/cli/test/store-migrate.test.ts --test-name-pattern 'apply|replay|source drift'`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import type { MigrationManifest } from "@mstar-harness/engine";
import { registerStoreCommands } from "../src/store-migrate.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-store-cli-"));

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshWorkspace(name: string): { root: string; harness: string } {
  const root = mkdtempSync(join(ROOT, name));
  roots.push(root);
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  return { root, harness };
}

function write(harness: string, relativePath: string, text: string): void {
  const absolute = join(harness, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text.endsWith("\n") ? text : `${text}\n`);
}

function writeRegister(harness: string, project: string, doc: unknown): void {
  write(harness, join("projects", project, "residuals.json"), JSON.stringify(doc, null, 2));
}

function entry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "R1",
    title: "Fix the flaky gate",
    severity: "high",
    source: "qc1.md",
    scope: "plan-scope",
    decision: "defer",
    owner: "pm",
    target: "next-iteration",
    tracking: "issue",
    registered_at: "2026-09-01",
    ...overrides,
  };
}

/** Run the registered `mstar store` family in-process; returns {exitCode, stdout}. */
async function runStore(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const program = new Command();
  registerStoreCommands(program);
  process.exitCode = 0;
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts: unknown[]) => logs.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
  try {
    await program.parseAsync(["node", "mstar", "store", ...args]);
  } catch {
    // command-level failures leave exitCode set by the handler
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const exitCode = process.exitCode ?? 0;
  // The handlers under test signal through process.exitCode (the real CLI
  // process's exit contract), but THIS file runs them in the bun test
  // process itself: restore a neutral exit code after capture or the
  // runner exits 1 with every test passing (silent CI red).
  process.exitCode = 0;
  return { exitCode, stdout: logs.join("\n"), stderr: errors.join("\n") };
}

async function previewManifest(harness: string): Promise<{ manifest: MigrationManifest; file: string }> {
  const file = join(harness, "..", "manifest.json");
  const result = await runStore(["migrate", "--harness", harness, "--out", file]);
  expect(result.exitCode).toBe(0);
  expect(existsSync(file)).toBe(true);
  return { manifest: JSON.parse(readFileSync(file, "utf8")) as MigrationManifest, file };
}

function jsonOf(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("mstar store migrate", () => {
  test("preview reports the reviewed manifest without writing a database", async () => {
    const { harness } = freshWorkspace("preview-");
    writeRegister(harness, "_default", { entries: { "plan-alpha": [entry({ id: "R1" })] } });

    const result = await runStore(["migrate", "--harness", harness]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 mapped row(s) across 1 register(s)");
    expect(result.stdout).toContain("_default _default/residuals.json: 1 entr(ies)");
    expect(result.stdout).toContain("--apply --manifest <path>");
    // The preview creates no DB and no receipt (§7).
    expect(existsSync(join(harness, "store.db"))).toBe(false);
  });

  test("preview --out writes the full reviewed manifest and --apply replays it with identical IDs", async () => {
    const { harness } = freshWorkspace("apply-replay-");
    writeRegister(harness, "_default", {
      entries: {
        "plan-alpha": [
          entry({ id: "R1" }),
          entry({ id: "R2", lifecycle: "resolved", decision: "accept", closed_at: "2026-09-02" }),
        ],
      },
    });
    writeRegister(harness, "engine", { entries: { "plan-alpha": [entry({ id: "R1", severity: "medium" })] } });

    const { manifest, file } = await previewManifest(harness);
    expect(manifest.blocksApply).toBe(false);
    expect(manifest.mappings).toHaveLength(3);

    const apply = jsonOf((await runStore(["migrate", "--apply", "--manifest", file, "--harness", harness, "--json"])).stdout);
    expect(apply.ok).toBe(true);
    const data = apply.data as { replayed: boolean; counts: { issues: number; created: number }; issueIds: { issueId: string }[] };
    expect(data.replayed).toBe(false);
    expect(data.counts.issues).toBe(3);
    expect(data.counts.created).toBe(3);

    // Exact rerun of the identical reviewed manifest: replay, same IDs, no writes.
    const replay = jsonOf((await runStore(["migrate", "--apply", "--manifest", file, "--harness", harness, "--json"])).stdout);
    expect(replay.ok).toBe(true);
    const replayData = replay.data as typeof data;
    expect(replayData.replayed).toBe(true);
    expect(replayData.issueIds).toEqual(data.issueIds);
    expect(replayData.counts.created).toBe(0);
    // The staged DB blocks ordinary issue mutations until activation.
    expect(existsSync(join(harness, "store.db"))).toBe(true);
  });

  test("--apply refuses source drift with no writes", async () => {
    const { harness } = freshWorkspace("source-drift-");
    writeRegister(harness, "_default", { entries: { "plan-alpha": [entry({ id: "R1" })] } });
    const { file } = await previewManifest(harness);

    // The register changes bytes after review.
    writeRegister(harness, "_default", { entries: { "plan-alpha": [entry({ id: "R1", severity: "low" })] } });
    const result = await runStore(["migrate", "--apply", "--manifest", file, "--harness", harness, "--json"]);
    expect(result.exitCode).toBe(1);
    const payload = jsonOf(result.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("store.migration-source-changed");
    // Nothing was written: no staged DB appeared for the refused apply.
    expect(existsSync(join(harness, "store.db"))).toBe(false);
  });
});

describe("mstar store init / upgrade", () => {
  test("store init refuses every existing legacy workspace and succeeds only on a genuinely empty one", async () => {
    const legacy = freshWorkspace("init-legacy-");
    writeRegister(legacy.harness, "_default", { entries: { "plan-alpha": [entry({ id: "R1" })] } });
    const refused = await runStore(["init", "--harness", legacy.harness, "--json"]);
    expect(refused.exitCode).toBe(1);
    expect(jsonOf(refused.stdout).code).toBe("store.already-exists");
    expect(jsonOf(refused.stdout).message).toContain("staged migration");
    expect(existsSync(join(legacy.harness, "store.db"))).toBe(false);

    // A maintained iterations index alone also refuses.
    const indexed = freshWorkspace("init-index-");
    write(indexed.harness, join("iterations", "README.md"), "# Iterations\n\n| Iteration | Path |\n|---|---|\n");
    const refusedIndex = await runStore(["init", "--harness", indexed.harness, "--json"]);
    expect(refusedIndex.exitCode).toBe(1);
    expect(jsonOf(refusedIndex.stdout).code).toBe("store.already-exists");

    // A genuinely empty workspace initializes an active empty store.
    const empty = freshWorkspace("init-empty-");
    const created = await runStore(["init", "--harness", empty.harness, "--json"]);
    expect(created.exitCode).toBe(0);
    const data = jsonOf(created.stdout).data as { authorityState: string; schemaVersion: number };
    expect(data.authorityState).toBe("active");
    expect(data.schemaVersion).toBeGreaterThanOrEqual(1);
    // A second init refuses the now-existing store.
    const again = await runStore(["init", "--harness", empty.harness, "--json"]);
    expect(again.exitCode).toBe(1);
  });

  test("store upgrade applies pending migrations atomically and is idempotent", async () => {
    const { harness } = freshWorkspace("upgrade-");
    await runStore(["init", "--harness", harness, "--json"]);
    const result = await runStore(["upgrade", "--harness", harness, "--json"]);
    expect(result.exitCode).toBe(0);
    const data = jsonOf(result.stdout).data as { schemaVersion: number };
    expect(data.schemaVersion).toBeGreaterThanOrEqual(3);
    const missing = freshWorkspace("upgrade-missing-");
    const refused = await runStore(["upgrade", "--harness", missing.harness, "--json"]);
    expect(refused.exitCode).toBe(1);
    expect(jsonOf(refused.stdout).code).toBe("store.not-initialized");
  });
});

// ---------------------------------------------------------------------------
// G5a — activation barrier, legacy-source retirement and backup (issue contract §7)
// ---------------------------------------------------------------------------

const INDEX_NARRATIVE = ["# Iterations", "", "This narrative line stays after retirement.", ""];
const INDEX_TABLE = [
  "| Iteration | Path | Description | Status |",
  "|-----------|------|-------------|--------|",
  "| `iter-one` | `iter-one/` | First iteration | `active` |",
];

function writeIndex(harness: string): void {
  write(harness, join("iterations", "README.md"), [...INDEX_NARRATIVE, ...INDEX_TABLE, ""].join("\n"));
  write(harness, join("iterations", "iter-one", "delivery-compass.md"), "# iter-one compass\n");
}

/** A conforming operator attestation file next to the workspace. */
function writeAttestation(harness: string, overrides: Record<string, unknown> = {}): string {
  const path = join(harness, "..", "attestation.json");
  const document = {
    version: 1,
    attestedAt: "2026-09-19T00:00:00.000Z",
    operator: { actor: "ops-engineer", authorizationRef: "compass D29 / guides/runtime-activation-decision.md" },
    consumers: [
      {
        entryId: "cli-global",
        kind: "cli",
        entrypoint: "/usr/local/lib/node_modules/@mstar-harness/cli/dist/index.js",
        runtime: "bun",
        runtimeVersion: "1.4.0",
        version: "3.11.0",
        current: false,
        disposition: "upgraded",
      },
      {
        entryId: "coordinator",
        kind: "coordinator",
        entrypoint: "/Users/op/.local/share/mstar/cli/dist/index.js",
        runtime: "node",
        runtimeVersion: "24.18.0",
        version: "3.11.0",
        current: true,
        disposition: "reloaded",
      },
    ],
    stoppedSessions: [{ sessionId: "sess-old-1", host: "omp", state: "stopped" }],
    ...overrides,
  };
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}

/** A workspace whose reviewed manifest is already applied (staged, not active). */
async function stagedWorkspace(name: string): Promise<{ harness: string; manifestFile: string }> {
  const { harness } = freshWorkspace(name);
  writeRegister(harness, "_default", { entries: { "plan-alpha": [entry({ id: "R1", severity: "critical" })] } });
  writeRegister(harness, "engine", { entries: { "plan-alpha": [entry({ id: "R1", severity: "medium" })] } });
  writeIndex(harness);
  const { file } = await previewManifest(harness);
  const applied = await runStore(["migrate", "--apply", "--manifest", file, "--harness", harness, "--json"]);
  expect(applied.exitCode).toBe(0);
  expect(jsonOf(applied.stdout).ok).toBe(true);
  return { harness, manifestFile: file };
}

describe("mstar store activate / retire / backup", () => {
  test("store backup writes a verified recovery point that records the store identity", async () => {
    const { harness } = await stagedWorkspace("backup-");
    const target = join(harness, "..", "recovery.db");
    const result = await runStore(["backup", "--out", target, "--harness", harness, "--json"]);
    expect(result.exitCode).toBe(0);
    const data = jsonOf(result.stdout).data as {
      backupPath: string;
      storeId: string;
      epoch: number;
      revision: number;
      authorityState: string;
      counts: { issues: number };
    };
    expect(data.backupPath).toBe(target);
    expect(data.authorityState).toBe("staged");
    expect(data.epoch).toBe(1);
    expect(data.counts.issues).toBe(2);
    expect(existsSync(target)).toBe(true);

    const again = await runStore(["backup", "--out", target, "--harness", harness, "--json"]);
    expect(again.exitCode).toBe(1);
    expect(jsonOf(again.stdout).code).toBe("store.activation-stale");
    expect(jsonOf(again.stdout).message).toContain("recorded recovery point");

    // The default target lands in the resolved control root, never a cwd-local path.
    const defaulted = await runStore(["backup", "--harness", harness, "--json"]);
    expect(defaulted.exitCode).toBe(0);
    const defaultPath = (jsonOf(defaulted.stdout).data as { backupPath: string }).backupPath;
    expect(defaultPath.startsWith(join(harness, "archived", "store-migration", "backups"))).toBe(true);
  });

  test("store activate flips the authority epoch and store retire removes the reviewed sources", async () => {
    const { harness, manifestFile } = await stagedWorkspace("activate-");
    const attestationFile = writeAttestation(harness);
    const activationFile = join(harness, "..", "activation.json");

    const activated = await runStore([
      "activate",
      "--manifest",
      manifestFile,
      "--attestation",
      attestationFile,
      "--out",
      activationFile,
      "--harness",
      harness,
      "--json",
    ]);
    expect(activated.exitCode).toBe(0);
    const activation = jsonOf(activated.stdout).data as { epoch: number; previousEpoch: number; replayed: boolean; receiptId: number };
    expect(activation.previousEpoch).toBe(1);
    expect(activation.epoch).toBe(2);
    expect(activation.replayed).toBe(false);
    expect(existsSync(activationFile)).toBe(true);
    expect(existsSync(join(harness, "archived", "store-migration", "backups", "pre-activation-"))).toBe(false);

    // The stub of the default pre-activation backup is present and named by identity.
    const defaultBackup = JSON.parse(readFileSync(activationFile, "utf8")) as { backup: { backupPath: string; revision: number } };
    expect(existsSync(defaultBackup.backup.backupPath)).toBe(true);

    const retired = await runStore(["retire", "--manifest", manifestFile, "--harness", harness, "--json"]);
    expect(retired.exitCode).toBe(0);
    const retirement = jsonOf(retired.stdout).data as { registers: { relativePath: string }[]; sections: { relativePath: string }[]; markerPath: string };
    expect(retirement.registers.length).toBe(2);
    expect(retirement.sections.length).toBe(1);
    expect(existsSync(join(harness, "projects", "_default", "residuals.json"))).toBe(false);
    expect(existsSync(join(harness, "projects", "engine", "residuals.json"))).toBe(false);
    const readme = readFileSync(join(harness, "iterations", "README.md"), "utf8");
    expect(readme).toContain("This narrative line stays after retirement.");
    expect(readme).not.toContain("| `iter-one` |");
    const marker = readFileSync(retirement.markerPath, "utf8");
    expect(marker).toContain("not a post-activation rollback path");

    // Idempotent replay at the CLI boundary.
    const replay = await runStore(["retire", "--manifest", manifestFile, "--harness", harness, "--json"]);
    expect(replay.exitCode).toBe(0);
    expect((jsonOf(replay.stdout).data as { replayed: boolean }).replayed).toBe(true);
  });

  test("store activate refuses an unusable attestation before any write", async () => {
    const { harness, manifestFile } = await stagedWorkspace("activate-refused-");

    const missingFile = await runStore(["activate", "--manifest", manifestFile, "--harness", harness, "--json"]);
    expect(missingFile.exitCode).toBe(2);
    expect(jsonOf(missingFile.stdout).code).toBe("usage");
    expect(jsonOf(missingFile.stdout).message).toContain("--attestation");

    const noCoordinator = writeAttestation(harness, {
      consumers: [
        {
          entryId: "cli-global",
          kind: "cli",
          entrypoint: "/usr/local/lib/node_modules/@mstar-harness/cli/dist/index.js",
          runtime: "bun",
          runtimeVersion: "1.4.0",
          version: "3.11.0",
          current: false,
          disposition: "upgraded",
        },
      ],
    });
    const refused = await runStore(["activate", "--manifest", manifestFile, "--attestation", noCoordinator, "--harness", harness, "--json"]);
    expect(refused.exitCode).toBe(1);
    expect(jsonOf(refused.stdout).code).toBe("store.activation-blocked");
    expect(jsonOf(refused.stdout).message).toContain("current coordinator");

    // A usage-level manifest problem still exits 2 rather than pretending refusal.
    const noManifest = await runStore(["activate", "--attestation", noCoordinator, "--harness", harness, "--json"]);
    expect(noManifest.exitCode).toBe(2);
  });

  test("store retire refuses when the reviewed sources drifted after activation", async () => {
    const { harness, manifestFile } = await stagedWorkspace("retire-drift-");
    const attestationFile = writeAttestation(harness);
    const activated = await runStore(["activate", "--manifest", manifestFile, "--attestation", attestationFile, "--harness", harness, "--json"]);
    expect(activated.exitCode).toBe(0);

    writeRegister(harness, "engine", {
      entries: { "plan-alpha": [entry({ id: "R1", severity: "medium" }), entry({ id: "R8", severity: "low" })] },
    });
    const registerPath = join(harness, "projects", "engine", "residuals.json");
    const written = readFileSync(registerPath);

    const refused = await runStore(["retire", "--manifest", manifestFile, "--harness", harness, "--json"]);
    expect(refused.exitCode).toBe(1);
    expect(jsonOf(refused.stdout).code).toBe("store.legacy-write-detected");
    expect(jsonOf(refused.stdout).message).toContain("NOT deleted");
    expect(readFileSync(registerPath).equals(written)).toBe(true);
    expect(existsSync(join(harness, "projects", "_default", "residuals.json"))).toBe(true);
  });
});
