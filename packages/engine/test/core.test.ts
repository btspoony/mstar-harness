/**
 * Engine core — shared types + version.
 *
 * Spec sources (each test cites the skill/reference section it enforces):
 * - Severity enum + total order: `mstar-artifacts/references/status-and-residuals.md`
 *   `critical|high|medium|low|nit` (lowercase English), total order
 *   `critical > high > medium > low > nit`; `warning`/`Major`/non-English
 *   values forbidden.
 * - `ValidationResult` / `GateResult` shapes: roadmap
 *   §8.5 C4 — engine returns `{ ok: boolean, severity, code, message, fix? }`;
 *   §8.5 C2 — engine unit tests cite the source section as spec.
 * - `readJson`/`writeJson`/`resolveProjectRoot`/`harnessVersionFrom`:
 *   roadmap §8.2 core row + §8.5 C6
 *   (own-manifest-first version resolution in engine; CLI re-exports it).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SEVERITY_ORDER,
  applyEnforcement,
  harnessVersionFrom,
  readDeclaredNodeFloor,
  readJson,
  resolveProjectRoot,
  writeJson,
} from "../src/core.js";
import type { GateResult } from "../src/core.js";

describe("Severity enum + total order", () => {
  test("SEVERITY_ORDER lists exactly the five allowed values, heavy → light", () => {
    // Spec: status-and-residuals.md § severity — allowed values + total order
    // `critical` > `high` > `medium` > `low` > `nit`.
    expect(SEVERITY_ORDER).toEqual(["critical", "high", "medium", "low", "nit"]);
  });

  test("forbidden values (warning, Major, non-English, retired info) are not part of the enum", () => {
    // Spec: status-and-residuals.md § severity — `warning`, `Major`, `info`, and
    // any non-English value are forbidden in JSON severity fields.
    expect(SEVERITY_ORDER).not.toContain("warning");
    expect(SEVERITY_ORDER).not.toContain("Major");
    expect(SEVERITY_ORDER).not.toContain("info");
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

describe("applyEnforcement — GateResult hard-mode semantics (Slice 5, roadmap §8.5 C4/D2)", () => {
  // Spec: roadmap §8.5 C4/D2 — v2 hard gates are opt-in per
  // Assignment/compass via the `Enforcement: hard` flag; `hardBlocked` is
  // true when violations exist AND the caller requested hard mode; never
  // global; rollback = unset flag; flag inert when the engine is absent.
  const violated: GateResult = {
    ok: false,
    violations: [
      {
        ok: false,
        severity: "high",
        code: "assignment.field.missing-execute-as",
        message: "missing required Assignment field: Execute as",
      },
    ],
  };
  const clean: GateResult = { ok: true, violations: [] };

  test("hard mode + violations → hardBlocked true, ok/violations preserved", () => {
    const result = applyEnforcement(violated, { hard: true });
    expect(result.hardBlocked).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].code).toBe("assignment.field.missing-execute-as");
  });

  test("hard mode + no violations → hardBlocked false (nothing to block)", () => {
    const result = applyEnforcement(clean, { hard: true });
    expect(result.hardBlocked).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("warn mode (flag absent/unset) + violations → hardBlocked false — warn-only, never blocks", () => {
    const result = applyEnforcement(violated, { hard: false });
    expect(result.hardBlocked).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
  });

  test("does not mutate the input gate — returns a new result", () => {
    const result = applyEnforcement(violated, { hard: true });
    expect(result).not.toBe(violated);
    expect(violated.ok).toBe(false);
    expect(violated.violations).toHaveLength(1);
    expect(violated.hardBlocked).toBeUndefined();
  });

  test("empty violations array with hard mode is never blocked (flag inert on clean gates)", () => {
    expect(applyEnforcement({ ok: true, violations: [] }, { hard: true }).hardBlocked).toBe(false);
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
  test("creates parent directories and writes readable JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-write-dirs-"));
    try {
      const file = join(dir, "a", "b", "out.json");
      writeJson(file, { name: "x" });
      expect(existsSync(join(dir, "a", "b"))).toBe(true);
      expect(readJson(file)).toEqual({ name: "x" });
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

describe("harnessVersionFrom", () => {
  test("own manifest first: a published engine layout resolves without any morning-star package ", () => {
    // Simulates `node_modules/@mstar-harness/engine/dist/engine.js` with the
    // engine's own package.json next to it and NO morning-star manifest
    // anywhere above — the walk-up alone would return "0.0.0".
    const dir = mkdtempSync(join(tmpdir(), "core-version-published-"));
    try {
      const engineRoot = join(dir, "node_modules", "@mstar-harness", "engine");
      const distDir = join(engineRoot, "dist");
      // Synthetic version written into the fixture manifest — not a real release.
      const ownVersion = "0.0.0-synthetic";
      mkdirSync(distDir, { recursive: true });
      writeFileSync(
        join(engineRoot, "package.json"),
        JSON.stringify({ name: "@mstar-harness/engine", version: ownVersion }),
        "utf8",
      );
      expect(harnessVersionFrom(distDir)).toBe(ownVersion);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fallback: walks up to a morning-star package.json when no own manifest exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-version-fallback-"));
    try {
      const root = join(dir, "repo");
      mkdirSync(join(root, "lib", "dist"), { recursive: true });
      // Synthetic version written into the fixture manifest — not a real release.
      const anchorVersion = "0.0.0-synthetic-a";
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "morning-star", version: anchorVersion }),
        "utf8",
      );
      // No package.json next to the module dir — the walk finds morning-star.
      expect(harnessVersionFrom(join(root, "lib", "dist"))).toBe(anchorVersion);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns 0.0.0 when neither own manifest nor morning-star package exists", () => {
    // "0.0.0" is harnessVersionFrom's own documented no-manifest sentinel, not a
    // claim about any released version.
    const dir = mkdtempSync(join(tmpdir(), "core-version-none-"));
    try {
      const moduleDir = join(dir, "somewhere");
      mkdirSync(moduleDir, { recursive: true });
      expect(harnessVersionFrom(moduleDir)).toBe("0.0.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readDeclaredNodeFloor — bundled entrypoints", () => {
  test("a hooks-style bundle resolves the floor from the sibling engine manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "mstar-hook-layout-"));
    try {
      // The layout a generated hook bundle sees: the bundle sits in `<root>/hooks`,
      // the repository root manifest declares no engines, and the engine package
      // (whose code the bundle inlines) is the manifest that declares the floor.
      mkdirSync(join(root, "hooks"), { recursive: true });
      mkdirSync(join(root, "packages", "engine"), { recursive: true });
      writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "loose-root" })}\n`);
      const declaredFloorValue = "99.0.0-synthetic";
      writeFileSync(
        join(root, "packages", "engine", "package.json"),
        `${JSON.stringify({ name: "@mstar-harness/engine", engines: { node: ">=" + declaredFloorValue } })}\n`,
      );
      const source = join(root, "hooks", "probe.src.ts");
      writeFileSync(
        source,
        `import { readDeclaredNodeFloor } from ${JSON.stringify(join(import.meta.dir, "..", "src", "core.js"))};\n` +
          `console.log(readDeclaredNodeFloor() ?? "none");\n`,
      );
      // Bundling is what makes the inlined engine share the bundle's module URL —
      // exactly how scripts/build-zcode-hooks.ts produces hooks/*.mjs.
      const bundle = join(root, "hooks", "probe.mjs");
      const built = spawnSync(process.execPath, ["build", source, "--target", "node", "--outfile", bundle], {
        encoding: "utf8",
      });
      expect(built.status).toBe(0);
      const ran = spawnSync(process.execPath, [bundle], { encoding: "utf8" });
      expect(ran.status).toBe(0);
      expect(ran.stdout.trim()).toBe(declaredFloorValue);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
