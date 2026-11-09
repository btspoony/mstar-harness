/**
 * Probe-failure contract: when Git cannot answer (missing executable, timeout),
 * harness discovery refuses instead of adopting the caller's own checkout. The
 * write gate compensates with its own process-root fallback, so a refusal here
 * never disables enforcement.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHarnessDir } from "../src/path.js";

const roots: string[] = [];

function dir(): string {
  const root = mkdtempSync(join(tmpdir(), "probe-failure-"));
  roots.push(root);
  mkdirSync(join(root, ".mstar"), { recursive: true });
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("resolveHarnessDir probe failure", () => {
  test("an unanswerable Git probe refuses discovery instead of using the local harness", () => {
    const root = dir();
    const savedPath = process.env.PATH;
    const savedHarness = process.env.MSTAR_HARNESS_DIR;
    process.env.PATH = "/nonexistent";
    delete process.env.MSTAR_HARNESS_DIR;
    try {
      // The local `.mstar` exists; only the failed probe stands between it and
      // being adopted as the process root.
      expect(resolveHarnessDir(root)).toBeNull();
    } finally {
      process.env.PATH = savedPath;
      if (savedHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = savedHarness;
    }
  });

  test("an explicit harness override still wins without Git", () => {
    const root = dir();
    const savedPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      expect(resolveHarnessDir(root, { harnessDir: join(root, ".mstar") })).toBe(join(root, ".mstar"));
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test("a local probe asks about the checkout itself and needs no Git", () => {
    const root = dir();
    const savedPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      expect(resolveHarnessDir(root, { localProbe: true })).toBe(join(root, ".mstar"));
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
