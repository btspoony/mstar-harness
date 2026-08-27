/**
 * Engine backlog-register tests (plan 20260826-backlog-register-cli Task 2):
 * `appendProjectRegisterEntries` / `closeProjectRegisterEntry` — normal
 * append + validate, other-key preservation, concurrent serialization
 * (incl. B-9 ① same-day key bump under concurrency), kill-mid-write
 * crash-safety (atomic replace), same-day key bump, close in place, and
 * fail-loud rejection (incl. B-9 ② duplicate id + Task-1 review minors).
 *
 * Spec sources (each test cites the plan/brief section it enforces):
 * - Task 2 test contract items 1–7 (plan 20260826-backlog-register-cli).
 * - Architect B-9 amendment ① (same-day key bump inside the lock — two
 *   concurrent same-day appends land on distinct keys, no merged array, no
 *   id collision) and ② (entry-id uniqueness within the selected key).
 * - Task-1 review minors: `Object.hasOwn` occupancy (prototype-name
 *   safety), empty `entries` must not write an empty key, and the
 *   uniqueness seed from the selected key's existing entries.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../src/core.js";
import { createFsStore, setArtifactStore } from "../src/store.js";
import {
  PROJECT_REGISTER_FILE,
  appendProjectRegisterEntries,
  closeProjectRegisterEntry,
  validateProjectRegister,
} from "../src/project.js";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function registerPath(projectDir: string): string {
  return join(projectDir, PROJECT_REGISTER_FILE);
}
/** Harness root + a canonical `<root>/projects/<id>` project dir (Task 2:
 * the register writers persist via `getArtifactStore().put` with
 * `kind: "residuals", key: <project id>`; the injected FsStore must resolve
 * the register to the same file the tests read back). */
function harnessProject(prefix: string, projectId = "test-project"): { root: string; dir: string } {
  const root = tmpRoot(prefix);
  setArtifactStore(createFsStore(root));
  const dir = join(root, "projects", projectId);
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

afterEach(() => {
  setArtifactStore(undefined);
});

/** Valid residual entry — nine required fields + `registered_at` (provenance `source_plan` is set by the API). */
function residualEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "R-1",
    title: "deferred PR backlog entry",
    severity: "high",
    source: "pr-deep-review",
    scope: "skills/mstar-audit/references/pr-review.md",
    decision: "defer",
    owner: "@fullstack-dev",
    target: null,
    tracking: "20260826-pr-deep-review",
    lifecycle: "open",
    registered_at: "2026-08-26",
    ...overrides,
  };
}

/** Pre-seed a valid register with one entry under `existing` (source_plan matches its key). */
function seedRegister(dir: string): string {
  const doc = {
    entries: {
      existing: [residualEntry({ id: "E-1", source_plan: "existing" })],
    },
  };
  const content = `${JSON.stringify(doc, null, 2)}\n`;
  writeFileSync(registerPath(dir), content, "utf8");
  return content;
}

describe("appendProjectRegisterEntries — normal append + validate (Task 2 contract 1)", () => {
  test("appends two entries under the base key; register parses, nine fields + provenance complete, validates", async () => {
    const { dir, root } = harnessProject("backlog-append-");
    try {
      const result = await appendProjectRegisterEntries({
        projectDir: dir,
        basePlanKey: "pr-deep-review-2026-08-26",
        entries: [residualEntry({ id: "R-1" }), residualEntry({ id: "R-2" })],
      });
      expect(result).toEqual({ ok: true, key: "pr-deep-review-2026-08-26" });

      const doc = JSON.parse(readFileSync(registerPath(dir), "utf8"));
      expect(validateProjectRegister(doc).ok).toBe(true);
      const entries = doc.entries["pr-deep-review-2026-08-26"];
      expect(entries).toHaveLength(2);
      for (const entry of entries) {
        for (const field of [
          "id",
          "title",
          "severity",
          "source",
          "scope",
          "decision",
          "owner",
          "target",
          "tracking",
          "source_plan",
          "registered_at",
        ]) {
          expect(entry).toHaveProperty(field);
        }
        expect(entry.source_plan).toBe("pr-deep-review-2026-08-26");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("appendProjectRegisterEntries — preserves other keys (Task 2 contract 2)", () => {
  test("a pre-existing key's entries survive the append verbatim", async () => {
    const { dir, root } = harnessProject("backlog-preserve-");
    try {
      const before = seedRegister(dir);

      await appendProjectRegisterEntries({
        projectDir: dir,
        basePlanKey: "pr-deep-review-2026-08-26",
        entries: [residualEntry({ id: "R-1" })],
      });

      const doc = JSON.parse(readFileSync(registerPath(dir), "utf8"));
      expect(doc.entries.existing).toEqual([residualEntry({ id: "E-1", source_plan: "existing" })]);
      expect(doc.entries["pr-deep-review-2026-08-26"]).toHaveLength(1);
      expect(validateProjectRegister(doc).ok).toBe(true);
      expect(before).not.toBe(readFileSync(registerPath(dir), "utf8"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("appendProjectRegisterEntries — concurrent appends serialize (Task 2 contract 3)", () => {
  test("two concurrent appends with different base keys both land (no lost update)", async () => {
    const { dir, root } = harnessProject("backlog-concurrent-");
    try {
      const [a, b] = await Promise.all([
        appendProjectRegisterEntries({ projectDir: dir, basePlanKey: "plan-a", entries: [residualEntry({ id: "A-1" })] }),
        appendProjectRegisterEntries({ projectDir: dir, basePlanKey: "plan-b", entries: [residualEntry({ id: "B-1" })] }),
      ]);
      expect(a.key).toBe("plan-a");
      expect(b.key).toBe("plan-b");

      const doc = JSON.parse(readFileSync(registerPath(dir), "utf8"));
      expect(doc.entries["plan-a"]).toHaveLength(1);
      expect(doc.entries["plan-b"]).toHaveLength(1);
      expect(validateProjectRegister(doc).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("B-9 ①: two concurrent same-day appends land on distinct keys — no merged array, no id collision", async () => {
    const { dir, root } = harnessProject("backlog-concurrent-sameday-");
    try {
      const base = "pr-deep-review-2026-08-26";
      const [a, b] = await Promise.all([
        appendProjectRegisterEntries({ projectDir: dir, basePlanKey: base, entries: [residualEntry({ id: "R-1" })] }),
        appendProjectRegisterEntries({ projectDir: dir, basePlanKey: base, entries: [residualEntry({ id: "R-1" })] }),
      ]);
      expect([a.key, b.key].sort()).toEqual([base, `${base}-2`]);

      const doc = JSON.parse(readFileSync(registerPath(dir), "utf8"));
      // Each key holds exactly its own entry — the arrays were never merged.
      expect(doc.entries[base].map((e: { id: string }) => e.id)).toEqual(["R-1"]);
      expect(doc.entries[`${base}-2`].map((e: { id: string }) => e.id)).toEqual(["R-1"]);
      expect(validateProjectRegister(doc).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("appendProjectRegisterEntries — kill-mid-write crash safety (Task 2 contract 4)", () => {
  test("a write-phase failure leaves the original register byte-unchanged (atomic replace)", async () => {
    const { dir, root } = harnessProject("backlog-crash-");
    try {
      const before = seedRegister(dir);

      // Simulate a crash during the write phase: writeJson throws before the
      // atomic temp+rename completes. The register on disk must be untouched.
      const spy = spyOn(core, "writeJson").mockImplementation(() => {
        throw new Error("simulated crash mid-write");
      });
      try {
        await expect(
          appendProjectRegisterEntries({
            projectDir: dir,
            basePlanKey: "pr-deep-review-2026-08-26",
            entries: [residualEntry({ id: "R-1" })],
          }),
        ).rejects.toThrow("simulated crash mid-write");
      } finally {
        spy.mockRestore();
      }

      expect(readFileSync(registerPath(dir), "utf8")).toBe(before);
      // Lock released on the failure path too.
      expect(existsSync(join(dir, ".status-write.lockdir"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("appendProjectRegisterEntries — same-day key bump (Task 2 contract 5)", () => {
  test("second same-day append lands on -2; both keys coexist, not merged", async () => {
    const { dir, root } = harnessProject("backlog-bump-");
    try {
      const base = "pr-deep-review-2026-08-26";
      const first = await appendProjectRegisterEntries({ projectDir: dir, basePlanKey: base, entries: [residualEntry({ id: "R-1" })] });
      expect(first.key).toBe(base);

      // Close the first entry in place (mirrors the real workflow: a review
      // completes, then a new same-day session registers more PRs).
      await closeProjectRegisterEntry({ projectDir: dir, planKey: base, entryId: "R-1", closureNote: "review complete" });

      const second = await appendProjectRegisterEntries({ projectDir: dir, basePlanKey: base, entries: [residualEntry({ id: "R-1" })] });
      expect(second.key).toBe(`${base}-2`);

      const doc = JSON.parse(readFileSync(registerPath(dir), "utf8"));
      expect(Object.keys(doc.entries).sort()).toEqual([base, `${base}-2`]);
      expect(doc.entries[base]).toHaveLength(1);
      expect(doc.entries[base][0].lifecycle).toBe("resolved");
      expect(doc.entries[`${base}-2`]).toHaveLength(1);
      expect(doc.entries[`${base}-2`][0].lifecycle).toBe("open");
      expect(validateProjectRegister(doc).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("closeProjectRegisterEntry — close in place (Task 2 contract 6)", () => {
  test("closes an entry in place (lifecycle resolved + closed_at + closure_note) and the register validates", async () => {
    const { dir, root } = harnessProject("backlog-close-");
    try {
      const base = "pr-deep-review-2026-08-26";
      await appendProjectRegisterEntries({ projectDir: dir, basePlanKey: base, entries: [residualEntry({ id: "R-1" })] });

      const result = await closeProjectRegisterEntry({ projectDir: dir, planKey: base, entryId: "R-1", closureNote: "review complete" });
      expect(result).toEqual({ ok: true });

      const doc = JSON.parse(readFileSync(registerPath(dir), "utf8"));
      const entry = doc.entries[base][0];
      expect(entry.lifecycle).toBe("resolved");
      expect(entry.closed_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.closure_note).toBe("review complete");
      expect(validateProjectRegister(doc).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("closing an absent entry id throws and leaves the register unchanged", async () => {
    const { dir, root } = harnessProject("backlog-close-absent-");
    try {
      const base = "pr-deep-review-2026-08-26";
      await appendProjectRegisterEntries({ projectDir: dir, basePlanKey: base, entries: [residualEntry({ id: "R-1" })] });
      const before = readFileSync(registerPath(dir), "utf8");

      await expect(
        closeProjectRegisterEntry({ projectDir: dir, planKey: base, entryId: "no-such-id", closureNote: "x" }),
      ).rejects.toThrow("not found");
      expect(readFileSync(registerPath(dir), "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("closing an absent key throws", async () => {
    const { dir, root } = harnessProject("backlog-close-nokey-");
    try {
      await expect(
        closeProjectRegisterEntry({ projectDir: dir, planKey: "no-such-key", entryId: "R-1", closureNote: "x" }),
      ).rejects.toThrow("no entries for key");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("appendProjectRegisterEntries — fail-loud rejection (Task 2 contract 7)", () => {
  test("a bad entry (missing required field) throws and the register is byte-unchanged", async () => {
    const { dir, root } = harnessProject("backlog-fail-");
    try {
      const before = seedRegister(dir);
      const bad = residualEntry({ id: "R-1" });
      delete bad.title;

      await expect(
        appendProjectRegisterEntries({ projectDir: dir, basePlanKey: "pr-deep-review-2026-08-26", entries: [bad] }),
      ).rejects.toThrow("invalid residual entry");
      expect(readFileSync(registerPath(dir), "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a bad severity throws and the register is byte-unchanged", async () => {
    const { dir, root } = harnessProject("backlog-fail-severity-");
    try {
      const before = seedRegister(dir);

      await expect(
        appendProjectRegisterEntries({
          projectDir: dir,
          basePlanKey: "pr-deep-review-2026-08-26",
          entries: [residualEntry({ id: "R-1", severity: "catastrophic" })],
        }),
      ).rejects.toThrow("invalid residual entry");
      expect(readFileSync(registerPath(dir), "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("B-9 ②: duplicate entry id within one call throws and the register is byte-unchanged", async () => {
    const { dir, root } = harnessProject("backlog-dup-");
    try {
      const before = seedRegister(dir);

      await expect(
        appendProjectRegisterEntries({
          projectDir: dir,
          basePlanKey: "pr-deep-review-2026-08-26",
          entries: [residualEntry({ id: "R-1" }), residualEntry({ id: "R-1" })],
        }),
      ).rejects.toThrow("duplicate entry id");
      expect(readFileSync(registerPath(dir), "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Task-1 review minor: empty entries array throws a clear error and writes no empty key", async () => {
    const { dir, root } = harnessProject("backlog-empty-");
    try {
      const before = seedRegister(dir);

      await expect(
        appendProjectRegisterEntries({ projectDir: dir, basePlanKey: "pr-deep-review-2026-08-26", entries: [] }),
      ).rejects.toThrow("entries must not be empty");
      expect(readFileSync(registerPath(dir), "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Task-1 review minor: uniqueness is scoped to the selected key — a pre-existing id in the base key does not collide with the bumped key", async () => {
    const { dir, root } = harnessProject("backlog-seed-");
    try {
      const base = "pr-deep-review-2026-08-26";
      // Pre-existing entry with id R-1 under the base key.
      await appendProjectRegisterEntries({ projectDir: dir, basePlanKey: base, entries: [residualEntry({ id: "R-1" })] });

      // A second same-day append reuses id R-1 — it lands on the bumped key,
      // where the id is free. Uniqueness is per-key, seeded from the selected
      // key's existing entries, never from the base key's.
      const second = await appendProjectRegisterEntries({ projectDir: dir, basePlanKey: base, entries: [residualEntry({ id: "R-1" })] });
      expect(second.key).toBe(`${base}-2`);

      const doc = JSON.parse(readFileSync(registerPath(dir), "utf8"));
      expect(doc.entries[base]).toHaveLength(1);
      expect(doc.entries[`${base}-2`]).toHaveLength(1);
      expect(validateProjectRegister(doc).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fail-loud path agreement (qc3 F-201) — register writers vs the active store root", () => {
  test("appendProjectRegisterEntries fails loud when projectDir lies outside the store root; nothing written", async () => {
    const root = tmpRoot("backlog-append-outside-");
    const other = tmpRoot("backlog-outside-");
    setArtifactStore(createFsStore(root));
    try {
      const projectDir = join(other, "projects", "test-project");
      await expect(
        appendProjectRegisterEntries({
          projectDir,
          basePlanKey: "pr-deep-review-2026-08-26",
          entries: [residualEntry({ id: "R-1" })],
        }),
      ).rejects.toThrow(/routed writer path mismatch/);
      expect(existsSync(join(projectDir, PROJECT_REGISTER_FILE))).toBe(false);
      expect(existsSync(join(root, "projects", "test-project", PROJECT_REGISTER_FILE))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("closeProjectRegisterEntry fails loud when projectDir lies outside the store root; nothing written", async () => {
    const root = tmpRoot("backlog-close-outside-");
    const other = tmpRoot("backlog-outside-");
    setArtifactStore(createFsStore(root));
    try {
      const projectDir = join(other, "projects", "test-project");
      await expect(
        closeProjectRegisterEntry({ projectDir, planKey: "pr-deep-review-2026-08-26", entryId: "R-1", closureNote: "x" }),
      ).rejects.toThrow(/routed writer path mismatch/);
      expect(existsSync(join(projectDir, PROJECT_REGISTER_FILE))).toBe(false);
      expect(existsSync(join(root, "projects", "test-project", PROJECT_REGISTER_FILE))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
});
