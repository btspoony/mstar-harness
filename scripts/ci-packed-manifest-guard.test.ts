/**
 * scripts/ci-packed-manifest-guard.ts — `workspace:` spec scan semantics.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWorkspaceSpecs } from "./ci-packed-manifest-guard.ts";

describe("findWorkspaceSpecs (packed manifest workspace: guard)", () => {
  test("flags workspace: specs in dependencies, peerDependencies, optionalDependencies", () => {
    const hits = findWorkspaceSpecs({
      dependencies: { "@mstar-harness/engine": "workspace:*" },
      peerDependencies: { zod: "workspace:^" },
      optionalDependencies: { fsevents: "workspace:~1.0.0" },
    });
    expect(hits).toEqual([
      'dependencies["@mstar-harness/engine"] = "workspace:*"',
      'peerDependencies["zod"] = "workspace:^"',
      'optionalDependencies["fsevents"] = "workspace:~1.0.0"',
    ]);
  });

  test("semver ranges and non-workspace protocols pass", () => {
    expect(
      findWorkspaceSpecs({
        dependencies: { "@mstar-harness/engine": "^3.5.0", zod: "^4.0.0" },
        peerDependencies: { react: ">=18" },
        optionalDependencies: { fsevents: "^2.3.3" },
      }),
    ).toEqual([]);
  });

  test("devDependencies are exempt (not shipped)", () => {
    expect(
      findWorkspaceSpecs({
        devDependencies: { "@mstar-harness/engine": "workspace:*" },
      }),
    ).toEqual([]);
  });

  test("missing dependency sections pass", () => {
    expect(findWorkspaceSpecs({})).toEqual([]);
  });
});

const GUARD_PATH = join(import.meta.dir, "ci-packed-manifest-guard.ts");

/** Spawn ceiling: a hung `bun pm pack` must fail the test, never wedge the suite. */
const GUARD_SPAWN_TIMEOUT_MS = 30_000;

interface GuardRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runGuard(cwd: string): GuardRun {
  const proc = Bun.spawnSync([process.execPath, GUARD_PATH], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: GUARD_SPAWN_TIMEOUT_MS,
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("guard process boundary (exit codes)", () => {
  let fixtureDir: string | undefined;

  afterEach(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  });

  function writeManifest(manifest: Record<string, unknown>): string {
    fixtureDir = mkdtempSync(join(tmpdir(), "packed-manifest-guard-fixture-"));
    writeFileSync(join(fixtureDir, "package.json"), JSON.stringify(manifest));
    return fixtureDir;
  }

  test(
    "exits non-zero when the root manifest carries a workspace: spec in dependencies",
    () => {
      const cwd = writeManifest({
        name: "guard-violation-fixture",
        version: "0.0.0",
        dependencies: { "@mstar-harness/engine": "workspace:*" },
      });
      const result = runGuard(cwd);
      // Raw violations fail fast: the guard prints its own banner and exits 1
      // before `bun pm pack` runs, so these assertions pin the guard's own
      // rejection path (a regression to pack-throws-first would lose the
      // banner and surface pack's error instead).
      // Fail closed: a spawn timeout yields `exitCode: null`, which must not
      // satisfy this assertion.
      expect(result.exitCode).not.toBeNull();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("workspace: protocol is unresolvable");
      expect(result.stderr).toContain('dependencies["@mstar-harness/engine"] = "workspace:*"');
    },
    60_000,
  );

  test(
    "exits 0 when the root manifest ships semver-only specs",
    () => {
      const cwd = writeManifest({
        name: "guard-clean-fixture",
        version: "0.0.0",
        dependencies: { zod: "^4.0.0" },
      });
      const result = runGuard(cwd);
      expect(result.exitCode).toBe(0);
      // The banner dash is U+2014; keep the source literal pure ASCII.
      expect(result.stdout).toContain("OK \u2014");
    },
    60_000,
  );
});
