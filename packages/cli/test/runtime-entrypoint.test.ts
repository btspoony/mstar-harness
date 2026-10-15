/**
 * runtime-entrypoint.test.ts — the published CLI is a Node entrypoint.
 *
 * The bin's shebang decides the runtime of every plain invocation, every
 * `npx @mstar-harness/cli` launch and every host MCP launch, so a build that
 * emits another runtime's shebang silently changes the CLI's runtime contract.
 * `bun build` copies the entry's first line into the bundle, so the source
 * entry and the built artifact are both asserted, together with the single
 * runtime requirement the published manifest declares.
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_ROOT = join(import.meta.dir, "..");
const DIST = join(CLI_ROOT, "dist", "mstar-harness.js");
/** Node binary used for the below-floor leg; overridable for local runs. */
const NODE_BIN = process.env.MSTAR_TEST_NODE_BIN ?? "node";

test("the CLI entry point is a Node script", () => {
  expect(readFileSync(join(CLI_ROOT, "src", "index.ts"), "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
  // `dist/` is this package's own build output and its test script builds it
  // first: a missing or stale bundle must fail here, never report green.
  expect(readFileSync(DIST, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
});

test("the published CLI manifest declares one runtime requirement", () => {
  const manifest = JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8")) as {
    engines?: Record<string, string>;
  };
  expect(manifest.engines).toEqual({ node: ">=24.18.0" });
});

test("a below-floor Node runtime refuses a store command with a Node-only recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "mstar-cli-runtime-floor-"));
  try {
    // Spoof only the reported version: the real Node runs the published bundle,
    // so the refusal is the one a below-floor Node user receives.
    const preload = join(root, "spoof-node-version.mjs");
    writeFileSync(preload, 'Object.defineProperty(process.versions, "node", { value: "22.5.0", configurable: true });\n');
    const proc = spawnSync(
      NODE_BIN,
      ["--import", preload, DIST, "store", "upgrade", "--operator", "fixture-operator", "--harness", join(root, ".mstar")],
      { encoding: "utf8" },
    );
    expect(proc.error).toBeUndefined();
    expect(proc.status).toBe(1);
    const envelope = JSON.parse(proc.stdout) as {
      status: string;
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };
    expect(envelope).toMatchObject({ status: "refused", code: "store.runtime-unsupported", exitCode: 1 });
    expect(envelope.message).toContain("Node >=24.18.0");
    expect(String(envelope.details?.recovery)).toContain("Node.js >=24.18.0");
    expect(proc.stdout).not.toMatch(/[Bb]un/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
