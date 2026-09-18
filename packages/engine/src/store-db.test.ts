/**
 * store-db.test.ts — C1 proof for the issue-store runtime boundary
 * (plan 20260918-issue-store-core). Run with `bun test packages/engine/src/store-db.test.ts`.
 *
 * The scenario suite below is executed against the REAL store-db.ts
 * implementation and the REAL node:sqlite driver — twice: once in-process
 * under Bun 1.4.0 (the test runner itself) and once per scenario as a child
 * process under Node >=24.18.0 and Bun 1.4.0, using the test-only
 * `store-test-runtime.ts` helper bundled into a temporary directory. No mock
 * database exists anywhere in this proof. The bundle and all temporary
 * databases are removed after the run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIN_BUN_VERSION,
  MIN_NODE_VERSION,
  StoreError,
  assertStoreRuntimeSupported,
  compareVersions,
} from "./store-db.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-store-db-test-"));
const BUNDLE = join(ROOT, "store-test-runtime.mjs");

/** Node binary used for the Node-floor leg; overridable for local runs. */
const NODE_BIN = process.env.MSTAR_TEST_NODE_BIN ?? "node";
let nodeVersion = "";
let bundleError = "";

function runtimeVersion(bin: string, args: string[]): string {
  const probe = spawnSync(bin, args, { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.trim() : `unavailable (${probe.stderr.trim()})`;
}

beforeAll(() => {
  const built = spawnSync(
    process.execPath,
    ["build", join(import.meta.dir, "store-test-runtime.ts"), "--target", "node", "--outfile", BUNDLE],
    { encoding: "utf8" },
  );
  if (built.status !== 0) bundleError = built.stderr || `bun build exited ${built.status}`;
  nodeVersion = runtimeVersion(NODE_BIN, ["--version"]);
}, 60_000);

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** Spawn one scenario under a real runtime binary in a fresh temp dir. */
function runScenarioOn(bin: string, scenario: string, dir: string): { status: number; output: string } {
  const run = spawnSync(bin, [BUNDLE, scenario, dir], {
    encoding: "utf8",
    env: { ...process.env, MSTAR_STORE_TEST_RUNNER: "1" },
    timeout: 60_000,
  });
  return { status: run.status ?? -1, output: `${run.stdout}${run.stderr}`.trim() };
}

const SCENARIOS: string[] = [
  "import-lazy",
  "below-floor-refusal",
  "missing-read",
  "initialize-schema",
  "double-init",
  "checksum-drift",
  "newer-schema",
  "fk-enforcement",
  "second-writer-busy",
] as const;

describe("store-db runtime floors (actual versions)", () => {
  test(`Bun runner is >= ${MIN_BUN_VERSION} and Node child is >= ${MIN_NODE_VERSION}`, () => {
    expect(bundleError).toBe("");
    expect(Bun.version).toMatch(/^1\.[4-9]\./);
    expect(nodeVersion).toMatch(/^v24\.(1[89]|[2-9]\d)\./);
  });

  test("compareVersions orders floors numerically", () => {
    expect(compareVersions("24.18.0", "24.18.0")).toBe(0);
    expect(compareVersions("24.17.0", "24.18.0")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });

  test("below-floor and missing-capability refusals are actionable (in-process, real logic)", () => {
    expect(() => assertStoreRuntimeSupported({ isBun: false, version: "22.5.0" })).toThrow(StoreError);
    expect(() => assertStoreRuntimeSupported({ isBun: true, version: "1.3.14" })).toThrow(/Bun >=1\.4\.0/);
    expect(() => assertStoreRuntimeSupported({ isBun: false, version: "24.17.9" })).toThrow(/Node >=24\.18\.0/);
    expect(() => assertStoreRuntimeSupported({ isBun: false, version: "24.18.0", hasSqlite: false })).toThrow(
      /node:sqlite/,
    );
    expect(() => assertStoreRuntimeSupported({ isBun: true, version: MIN_BUN_VERSION })).not.toThrow();
    expect(() => assertStoreRuntimeSupported({ isBun: false, version: MIN_NODE_VERSION })).not.toThrow();
  });
});

describe.each([
  { runtime: "node", bin: NODE_BIN, version: () => nodeVersion },
  { runtime: "bun", bin: process.execPath, version: () => Bun.version },
])("store scenarios under $runtime (${version()})", ({ runtime, bin, version }) => {
  test.each(SCENARIOS)(`${runtime}: %s`, (scenario) => {
    expect(bundleError).toBe("");
    const dir = mkdtempSync(join(ROOT, `${runtime}-${scenario}-`));
    try {
      const result = runScenarioOn(bin, scenario, dir);
      if (result.status !== 0) {
        throw new Error(`${runtime} ${scenario} failed (exit ${result.status}):\n${result.output}`);
      }
      expect(result.output).toContain(`OK ${scenario}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test(`recorded ${runtime} version is a supported floor`, () => {
    expect(version()).toMatch(/^(v?1\.[4-9]\.|v24\.1[89]\.|v2[5-9]\.)/);
  });
});
