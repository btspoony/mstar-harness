/**
 * Engine core — shared types + version.
 *
 * Spec sources (each test cites the skill/reference section it enforces):
 * - Severity enum + total order: `mstar-plan-artifacts/references/status-and-residuals.md`
 *   § "Residual findings: `severity` (SSOT, machine field)" — allowed values
 *   `critical|high|medium|low|nit` (lowercase English), total order
 *   `critical > high > medium > low > nit`, `nit` always lighter than `low`,
 *   `warning`/`Major`/non-English values forbidden.
 * - `ValidationResult` / `GateResult` shapes: `.harness/references/skill-programmatic-roadmap.md`
 *   §8.5 C4 — engine returns `{ ok: boolean, severity, code, message, fix? }`;
 *   §8.5 C2 — engine unit tests cite the source section as spec.
 * - `readJson`/`writeJson`/`resolveProjectRoot`/`readHarnessVersion`: plan
 *   20260808-slice1-engine-foundation Task 2 + roadmap §8.2 core row + §8.5 C6
 *   (version single-source in engine; CLI re-exports).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SEVERITY_ORDER,
  readHarnessVersion,
  readJson,
  resolveProjectRoot,
  writeJson,
} from "../src/core.js";

describe("Severity enum + total order", () => {
  test("SEVERITY_ORDER lists exactly the five allowed values, heavy → light", () => {
    // Spec: status-and-residuals.md § severity — allowed values + total order
    // `critical` > `high` > `medium` > `low` > `nit`.
    expect(SEVERITY_ORDER).toEqual(["critical", "high", "medium", "low", "nit"]);
  });

  test("nit is always lighter than low — never inverted or equated", () => {
    // Spec: status-and-residuals.md § severity — "`nit` is always lighter than
    // `low` — never invert or equate".
    expect(SEVERITY_ORDER.indexOf("nit")).toBeGreaterThan(SEVERITY_ORDER.indexOf("low"));
  });

  test("forbidden values (warning, Major, non-English) are not part of the enum", () => {
    // Spec: status-and-residuals.md § severity — `warning`, `Major`, and any
    // non-English value are forbidden in JSON severity fields.
    expect(SEVERITY_ORDER).not.toContain("warning");
    expect(SEVERITY_ORDER).not.toContain("Major");
    for (const value of SEVERITY_ORDER) {
      expect(value).toBe(value.toLowerCase());
      expect(value).toMatch(/^[a-z]+$/);
    }
  });

  test("order has no duplicates", () => {
    expect([...new Set(SEVERITY_ORDER)]).toEqual(SEVERITY_ORDER);
  });
});

describe("ValidationResult / GateResult shapes", () => {
  test("ValidationResult carries ok/severity/code/message; fix is optional", () => {
    // Spec: roadmap §8.5 C4 — engine returns `{ ok: boolean, severity, code,
    // message, fix? }`.
    const full: {
      ok: boolean;
      severity: (typeof SEVERITY_ORDER)[number];
      code: string;
      message: string;
      fix?: string;
    } = { ok: false, severity: "high", code: "STATUS-001", message: "bad", fix: "edit status.json" };
    const minimal: typeof full = { ok: true, severity: "nit", code: "X", message: "n/a" };

    expect(full.ok).toBe(false);
    expect(full.severity).toBe("high");
    expect(full.code).toBe("STATUS-001");
    expect(full.message).toBe("bad");
    expect(full.fix).toBe("edit status.json");
    expect(minimal.fix).toBeUndefined();
    expect(minimal.ok).toBe(true);
  });

  test("GateResult carries ok + violations: empty violations gate passes, non-empty fails", () => {
    // Spec: roadmap §8.2 core row — `GateResult { ok, violations: ValidationResult[] }`.
    const pass: { ok: boolean; violations: { ok: boolean; severity: string; code: string; message: string }[] } = {
      ok: true,
      violations: [],
    };
    const fail: typeof pass = {
      ok: false,
      violations: [{ ok: false, severity: "critical", code: "LEASE-001", message: "lease missing" }],
    };
    expect(pass.ok).toBe(true);
    expect(pass.violations).toHaveLength(0);
    expect(fail.ok).toBe(false);
    expect(fail.violations).toHaveLength(1);
    expect(fail.violations[0].severity).toBe("critical");
  });
});

describe("readJson", () => {
  test("missing file reads as {}", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-read-missing-"));
    try {
      expect(readJson(join(dir, "nope.json"))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty file reads as {}", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-read-empty-"));
    try {
      const file = join(dir, "empty.json");
      writeFileSync(file, "   \n");
      expect(readJson(file)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("valid JSON parses to an object", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-read-valid-"));
    try {
      const file = join(dir, "ok.json");
      writeFileSync(file, '{"a": 1, "b": [true]}');
      expect(readJson(file)).toEqual({ a: 1, b: [true] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed JSON throws with the file path in the message", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-read-bad-"));
    try {
      const file = join(dir, "bad.json");
      writeFileSync(file, "{ not json");
      expect(() => readJson(file)).toThrow(/^Invalid JSON in .*bad\.json:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeJson (atomic)", () => {
  test("creates parent directories and writes pretty JSON with trailing newline", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-write-dirs-"));
    try {
      const file = join(dir, "a", "b", "out.json");
      writeJson(file, { name: "x" });
      expect(readFileSync(file, "utf8")).toBe('{\n  "name": "x"\n}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("overwrites existing content and leaves no temp files behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-write-atomic-"));
    try {
      const file = join(dir, "out.json");
      writeJson(file, { v: 1 });
      writeJson(file, { v: 2 });
      expect(readJson(file)).toEqual({ v: 2 });
      // Atomic write = temp + rename: the directory must contain exactly the
      // target file after the write, with no leftover temp artifacts.
      expect(readdirSync(dir)).toEqual(["out.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("round-trips through readJson", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-write-roundtrip-"));
    try {
      const file = join(dir, "data.json");
      const value = { plans: [{ id: "p1", status: "Todo" }], residual_findings: {} };
      writeJson(file, value);
      expect(readJson(file)).toEqual(value);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveProjectRoot", () => {
  test("walks up to the nearest ancestor containing package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-root-pkg-"));
    try {
      const project = join(dir, "proj");
      const nested = join(dir, "proj", "sub", "deep");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "package.json"), "{}");
      expect(resolveProjectRoot(nested)).toBe(resolve(project));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("walks up to the nearest ancestor containing bun.lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-root-lock-"));
    try {
      const project = join(dir, "proj");
      const nested = join(dir, "proj", "sub");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "bun.lock"), "");
      expect(resolveProjectRoot(nested)).toBe(resolve(project));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to the start directory when no marker exists up to the filesystem root", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-root-none-"));
    try {
      const nested = join(dir, "a", "b");
      expect(resolveProjectRoot(nested)).toBe(resolve(nested));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readHarnessVersion", () => {
  test("returns the root morning-star package.json version (1.8.8)", () => {
    // Spec: roadmap §8.5 C6 — single source for the harness version; the root
    // package.json (`name: "morning-star"`) is the version anchor. Engine,
    // cli, opencode and root all share it (single-version invariant).
    const repoRoot = resolve(import.meta.dir, "..", "..", "..");
    const rootPkg = readJson(join(repoRoot, "package.json"));
    expect(rootPkg.name).toBe("morning-star");
    expect(readHarnessVersion()).toBe(rootPkg.version);
    expect(readHarnessVersion()).toBe("1.8.8");
  });
});
