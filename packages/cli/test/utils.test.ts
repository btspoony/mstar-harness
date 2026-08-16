/**
 * CLI utils — `resolveCliPath` workspace/project-root resolution (audit-002).
 *
 * Contract (plan 002-cli-project-root-paths, PM amendment 2026-08-16):
 * absolute paths unchanged; relative paths resolve against
 * `MSTAR_CLI_PROJECT_ROOT` override → nearest ancestor `package.json`
 * declaring `workspaces` (monorepo root) → nearest ancestor `package.json`
 * (single-package project root) → cwd-relative terminal fallback.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCliPath } from "../src/utils";

const prevRoot = process.env.MSTAR_CLI_PROJECT_ROOT;

function withEnvRoot(value: string | undefined, fn: () => void): void {
  const prev = process.env.MSTAR_CLI_PROJECT_ROOT;
  try {
    if (value === undefined) delete process.env.MSTAR_CLI_PROJECT_ROOT;
    else process.env.MSTAR_CLI_PROJECT_ROOT = value;
    fn();
  } finally {
    if (prev === undefined) delete process.env.MSTAR_CLI_PROJECT_ROOT;
    else process.env.MSTAR_CLI_PROJECT_ROOT = prev;
  }
}

/** chdir into a fixture dir for the walk-up cases; cwd restored after. */
function withCwd(dir: string, fn: () => void): void {
  const prev = process.cwd();
  try {
    process.chdir(dir);
    fn();
  } finally {
    process.chdir(prev);
  }
}

describe("resolveCliPath", () => {
  // mkdtemp under /var/... is a symlink on macOS (real /private/var/...);
  // realpath-normalize so expected joins match process.cwd()-derived roots.
  const tempDir = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

  test("absolute path returned unchanged", () => {
    const abs = "/tmp/some/project/skills/mstar-audit";
    expect(resolveCliPath(abs)).toBe(abs);
  });

  test("MSTAR_CLI_PROJECT_ROOT override wins over any walk-up", () => {
    const dir = tempDir("mstar-utils-root-");
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
      withEnvRoot(dir, () => {
        withCwd(dir, () => {
          expect(resolveCliPath("skills/mstar-audit")).toBe(join(dir, "skills", "mstar-audit"));
        });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("workspaces walk-up: nested member dir resolves to the monorepo root", () => {
    const dir = tempDir("mstar-utils-mono-");
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mono", workspaces: ["packages/*"] }));
      const member = join(dir, "packages", "cli");
      mkdirSync(member, { recursive: true });
      // the member itself carries a plain manifest (no workspaces) — the walk
      // must skip it and keep going up to the root marker.
      writeFileSync(join(member, "package.json"), JSON.stringify({ name: "@mono/cli" }));
      withEnvRoot(undefined, () => {
        withCwd(member, () => {
          expect(resolveCliPath("skills/mstar-audit")).toBe(join(dir, "skills", "mstar-audit"));
        });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("single-package walk-up: nested dir resolves to the nearest package.json root", () => {
    const dir = tempDir("mstar-utils-single-");
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer-app" }));
      const nested = join(dir, "src", "deep");
      mkdirSync(nested, { recursive: true });
      withEnvRoot(undefined, () => {
        withCwd(nested, () => {
          expect(resolveCliPath("config/app.json")).toBe(join(dir, "config", "app.json"));
        });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("terminal fallback: outside any package.json tree stays cwd-relative", () => {
    const dir = tempDir("mstar-utils-bare-");
    try {
      withEnvRoot(undefined, () => {
        withCwd(dir, () => {
          expect(resolveCliPath("skills/mstar-audit")).toBe(join(dir, "skills", "mstar-audit"));
        });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// restore any ambient override after the last env-managed test
if (prevRoot === undefined) delete process.env.MSTAR_CLI_PROJECT_ROOT;
else process.env.MSTAR_CLI_PROJECT_ROOT = prevRoot;
