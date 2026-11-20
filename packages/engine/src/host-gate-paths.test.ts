/**
 * `host-gate-paths` — the single-sourced gate path glue (issue #442). The
 * landed-path resolver suite is ported from the opencode-v2 write gate (the
 * strongest shipped semantics, #438); the naming/classification cases pin the
 * FW-3 case-folded contract the four host copies must now share.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLLABORATION_MARKER_FILE } from "./collaboration-store.js";
import {
  MAX_SYMLINK_HOPS,
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
    for (const name of ["store.db", "store.db-wal", "store.db-shm", "store.db-journal", "Store.db", "STORE.DB-WAL"]) {
      expect(isStoreAuthorityName(name)).toBe(true);
    }
    expect(isStoreAuthorityName("notes.md")).toBe(false);
  });

  test("classifies the authority database only directly at a harness root", () => {
    expect(isStoreAuthorityTarget(join(harness, "store.db"))).toBe(true);
    expect(isStoreAuthorityTarget(join(harness, "Store.db"))).toBe(true);
    expect(isStoreAuthorityTarget(join(harness, "store.db-journal"))).toBe(true);
    expect(isStoreAuthorityTarget(join(harness, "nested", "store.db"))).toBe(false);
    expect(isStoreAuthorityTarget(join(harness, "nested", "store.db-journal"))).toBe(false);
    expect(isStoreAuthorityTarget(join(root, "store.db"))).toBe(false);
  });
});

describe("host-gate-paths collaboration authority target", () => {
  let home: string;
  let homeSpy: { mockRestore(): void };

  beforeAll(() => {
    // why: The namespace is anchored on the process home and the exported guard
    // has no selector, so the isolated home is installed at the runtime
    // boundary the guard reads (the same seam the store suite uses).
    home = realpathSync(mkdtempSync(join(tmpdir(), "host-gate-home-")));
    homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => home);
  });

  afterAll(() => {
    homeSpy.mockRestore();
    rmSync(home, { recursive: true, force: true });
  });

  const collaborationDb = (): string => join(home, ".mstar", "repos", "github.com", "acme", "repo", "collaboration.db");

  /** The marker the store publishes beside its database. */
  const writeMarker = (dir: string, body: string = JSON.stringify({ version: 1, repositoryKey: "github.com/acme/repo" })): void =>
    writeFileSync(join(dir, COLLABORATION_MARKER_FILE), body);

  test("protects the collaboration database and every SQLite sidecar", () => {
    const db = collaborationDb();
    for (const target of [db, `${db}-wal`, `${db}-shm`, `${db}-journal`]) {
      expect(isStoreAuthorityTarget(target)).toBe(true);
    }
  });

  test("follows a dangling alias and a chain that lands in the namespace", () => {
    const link = join(root, "collaboration-alias");
    symlinkSync(collaborationDb(), link);
    expect(isStoreAuthorityTarget(landedPathOf(link))).toBe(true);
    const chain = join(root, "collaboration-chain");
    symlinkSync("collaboration-alias", chain);
    expect(isStoreAuthorityTarget(landedPathOf(chain))).toBe(true);
  });

  test("matches a case variant of the location and the name", () => {
    expect(isStoreAuthorityTarget(join(home, ".mstar", "repos", "GitHub.com", "Acme", "Repo", "Collaboration.DB-WAL"))).toBe(
      true,
    );
  });

  test("protects the physical location when the namespace itself is symlinked", () => {
    // why: `~/.mstar/repos` may be a symlink (a large or relocated user store).
    // The canonical selection then lives at the link target, and a host write to
    // that physical path must be refused exactly like the lexical spelling.
    const physical = realpathSync(mkdtempSync(join(tmpdir(), "host-gate-repos-")));
    const reposLink = join(home, ".mstar", "repos");
    mkdirSync(join(home, ".mstar"), { recursive: true });
    symlinkSync(physical, reposLink);
    try {
      const db = join(physical, "github.com", "acme", "repo", "collaboration.db");
      expect(isStoreAuthorityTarget(db)).toBe(true);
      expect(isStoreAuthorityTarget(`${db}-journal`)).toBe(true);
      expect(isStoreAuthorityTarget(collaborationDb())).toBe(true);
      expect(isStoreAuthorityTarget(join(physical, "..", "unrelated", "collaboration.db"))).toBe(false);
    } finally {
      rmSync(reposLink, { force: true });
      rmSync(physical, { recursive: true, force: true });
    }
  });

  test("protects a repository directory that carries the authority marker", () => {
    // why: a repository directory below the namespace can be a symlink to
    // external storage. The store's own marker beside the database is the
    // evidence that the physical location holds authority bytes, so the
    // physical-only spelling is denied without scanning the namespace.
    const physical = realpathSync(mkdtempSync(join(tmpdir(), "host-gate-repo-")));
    writeMarker(physical);
    const lexicalRepo = join(home, ".mstar", "repos", "github.com", "acme", "repo");
    mkdirSync(join(home, ".mstar", "repos", "github.com", "acme"), { recursive: true });
    symlinkSync(physical, lexicalRepo);
    try {
      const db = join(physical, "collaboration.db");
      expect(isStoreAuthorityTarget(db)).toBe(true);
      expect(isStoreAuthorityTarget(`${db}-shm`)).toBe(true);
      expect(isStoreAuthorityTarget(join(lexicalRepo, "collaboration.db"))).toBe(true);
      expect(isStoreAuthorityTarget(landedPathOf(join(lexicalRepo, "collaboration.db")))).toBe(true);
      // A file alias into the marked directory lands on authority bytes too.
      const alias = join(root, "collaboration-file-alias");
      symlinkSync(db, alias);
      expect(isStoreAuthorityTarget(landedPathOf(alias))).toBe(true);
      // A neighbouring tree without the marker is not claimed.
      expect(isStoreAuthorityTarget(join(physical, "..", "unrelated", "collaboration.db"))).toBe(false);
    } finally {
      rmSync(lexicalRepo, { force: true });
      rmSync(join(home, ".mstar", "repos", "github.com"), { recursive: true, force: true });
      rmSync(physical, { recursive: true, force: true });
    }
  });

  test("allows a same-named database outside the namespace without a valid marker", () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "host-gate-plain-")));
    try {
      // No marker: an ordinary file, however it is named.
      writeFileSync(join(plain, "collaboration.db"), "not authority bytes");
      expect(isStoreAuthorityTarget(join(plain, "collaboration.db"))).toBe(false);
      expect(isStoreAuthorityTarget(join(plain, "collaboration.db-wal"))).toBe(false);
      // A malformed or unsupported marker is not evidence either.
      writeMarker(plain, "{not json");
      expect(isStoreAuthorityTarget(join(plain, "collaboration.db"))).toBe(false);
      writeMarker(plain, JSON.stringify({ version: 2, repositoryKey: "github.com/acme/repo" }));
      expect(isStoreAuthorityTarget(join(plain, "collaboration.db"))).toBe(false);
      writeMarker(plain, JSON.stringify({ version: 1, repositoryKey: "" }));
      expect(isStoreAuthorityTarget(join(plain, "collaboration.db"))).toBe(false);
      // The valid marker beside the name is what makes it authority bytes.
      writeMarker(plain);
      expect(isStoreAuthorityTarget(join(plain, "collaboration.db"))).toBe(true);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("anchors on the process home, never a caller-selected one", () => {
    const otherHome = realpathSync(mkdtempSync(join(tmpdir(), "host-gate-other-home-")));
    try {
      expect(
        isStoreAuthorityTarget(join(otherHome, ".mstar", "repos", "github.com", "acme", "repo", "collaboration.db")),
      ).toBe(false);
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  });

  test("does not deny a similarly named database outside the user-level namespace", () => {
    expect(isStoreAuthorityTarget(join(root, ".mstar", "collaboration.db"))).toBe(false);
    expect(isStoreAuthorityTarget(join(home, ".mstar", "collaboration.db"))).toBe(false);
    expect(isStoreAuthorityTarget(join(home, ".mstar", "repos-archive", "acme", "repo", "collaboration.db"))).toBe(false);
    expect(isStoreAuthorityTarget(join(home, ".mstar", "repos", "github.com", "acme", "repo", "store.db"))).toBe(false);
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
