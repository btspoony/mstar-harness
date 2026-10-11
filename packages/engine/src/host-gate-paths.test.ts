/**
 * `host-gate-paths` — the single-sourced gate path glue (issue #442). The
 * landed-path resolver suite is ported from the opencode-v2 write gate (the
 * strongest shipped semantics, #438); the naming/classification cases pin the
 * FW-3 case-folded contract the four host copies must now share.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_SYMLINK_HOPS,
  STORE_AUTHORITY_NAMES,
  SYMLINK_RESOLUTION_REFUSED_CODE,
  SymlinkResolutionError,
  caseFoldedDocKind,
  caseFoldedRegisterRoot,
  isStoreAuthorityName,
  isStoreAuthorityTarget,
  landedPathOf,
} from "./host-gate-paths.js";

let root: string;
let harness: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "host-gate-paths-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  harness = join(root, ".mstar");
  mkdirSync(join(harness, "workflows", "wf-1"), { recursive: true });
  mkdirSync(join(harness, "projects", "_g"), { recursive: true });
  writeFileSync(join(harness, "status.json"), JSON.stringify({ version: 2, updated_at: "2026-10-11", workflows: [] }));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("host-gate-paths.landedPathOf", () => {
  test("resolves an existing file to its canonical path", () => {
    const file = join(root, "plain.txt");
    writeFileSync(file, "x");
    expect(landedPathOf(file)).toBe(realpathSync(file));
  });

  test("resolves a fresh (absent) file to itself under its canonical ancestor", () => {
    const fresh = join(root, "fresh.txt");
    expect(landedPathOf(fresh)).toBe(join(realpathSync(root), "fresh.txt"));
  });

  test("resolves a dangling symlink to the file a write through it creates", () => {
    const target = join(harness, "store.db-wal");
    const link = join(root, "dangling");
    symlinkSync(target, link);
    const landed = landedPathOf(link);
    expect(landed.endsWith("store.db-wal")).toBe(true);
    expect(isStoreAuthorityTarget(landed)).toBe(true);
  });

  test("follows a multi-hop dangling symlink chain (the batch-1 bypass)", () => {
    const target = join(harness, "store.db-wal");
    const inner = join(root, "chain-inner");
    const outer = join(root, "chain-outer");
    symlinkSync(target, inner);
    symlinkSync("chain-inner", outer);
    const landed = landedPathOf(outer);
    expect(landed.endsWith("store.db-wal")).toBe(true);
    expect(isStoreAuthorityTarget(landed)).toBe(true);
  });

  test("resolves a fresh file through a symlinked ancestor directory", () => {
    const alias = join(root, "alias-projects");
    symlinkSync(join(harness, "projects", "_g"), alias);
    const landed = landedPathOf(join(alias, "residuals.json"));
    expect(landed).toBe(join(realpathSync(join(harness, "projects", "_g")), "residuals.json"));
  });

  test("refuses a cyclic symlink chain instead of allowing or hanging", () => {
    const a = join(root, "cycle-a");
    const b = join(root, "cycle-b");
    symlinkSync("cycle-b", a);
    symlinkSync("cycle-a", b);
    expect(() => landedPathOf(a)).toThrow(SymlinkResolutionError);
    try {
      landedPathOf(a);
    } catch (error) {
      expect((error as SymlinkResolutionError).code).toBe(SYMLINK_RESOLUTION_REFUSED_CODE);
    }
  });

  test("bounds the hop count", () => {
    expect(MAX_SYMLINK_HOPS).toBe(8);
  });
});

describe("host-gate-paths authority naming", () => {
  test("matches the authority names case-insensitively (FW-3)", () => {
    expect(STORE_AUTHORITY_NAMES).toEqual(["store.db", "store.db-wal", "store.db-shm"]);
    for (const name of ["store.db", "store.db-wal", "store.db-shm", "Store.db", "STORE.DB-WAL"]) {
      expect(isStoreAuthorityName(name)).toBe(true);
    }
    expect(isStoreAuthorityName("notes.md")).toBe(false);
  });

  test("classifies the authority database only directly at a harness root", () => {
    expect(isStoreAuthorityTarget(join(harness, "store.db"))).toBe(true);
    expect(isStoreAuthorityTarget(join(harness, "Store.db"))).toBe(true);
    expect(isStoreAuthorityTarget(join(harness, "nested", "store.db"))).toBe(false);
    expect(isStoreAuthorityTarget(join(root, "store.db"))).toBe(false);
  });
});

describe("host-gate-paths case-folded document classification", () => {
  test("classifies case-variant coordination documents by their canonical shape", () => {
    expect(caseFoldedDocKind(join(harness, "STATUS.json"))).toEqual({ harnessDir: harness, kind: "status" });
    expect(caseFoldedDocKind(join(harness, "workflows", "wf-1", "SNAPSHOT.json"))).toEqual({
      harnessDir: harness,
      kind: "snapshot",
    });
    expect(caseFoldedRegisterRoot(join(harness, "projects", "_g", "RESIDUALS.json"))).toBe(harness);
  });

  test("ignores names that are not coordination documents or the canonical shape", () => {
    expect(caseFoldedDocKind(join(harness, "notes.md"))).toBeNull();
    expect(caseFoldedDocKind(join(harness, "projects", "_g", "deep", "residuals.json"))).toBeNull();
    expect(caseFoldedRegisterRoot(join(harness, "STATUS.json"))).toBeNull();
  });

  test("follows a symlinked register landing through an outside alias", () => {
    const alias = join(root, "alias-register");
    symlinkSync(join(harness, "projects", "_g"), alias);
    expect(caseFoldedRegisterRoot(landedPathOf(join(alias, "residuals.json")))).toBe(realpathSync(harness));
  });
});
