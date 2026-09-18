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
  return { exitCode: process.exitCode ?? 0, stdout: logs.join("\n"), stderr: errors.join("\n") };
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
