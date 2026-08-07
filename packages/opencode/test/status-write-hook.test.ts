/**
 * OpenCode plugin — non-blocking `status.json` write lint (roadmap §8.5
 * `beforeStatusWrite`, v1).
 *
 * Spec sources:
 * - `beforeStatusWrite` host hook + v1 non-blocking warn / never-block
 *   contract: `.harness/references/skill-programmatic-roadmap.md` §8.5 +
 *   D2 (v1 = non-blocking lints; hard gates are v2 opt-in).
 * - status.json schema + root-only `residual_findings` (reject dual-write)
 *   + severity enum: engine `status.validateStatus` (spec-cited in
 *   `packages/engine/test/status.test.ts`).
 *
 * The exported `validateStatusWrite` helper is the hook module; the plugin
 * wiring (`tool.execute.before` on opencode `write`/`edit`) is exercised
 * end-to-end at the bottom.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MorningStarHarnessPlugin, validateStatusWrite, type StatusLogger } from "../src/mstar.js";

/**
 * Ambient MSTAR_HARNESS_DIR is pinned out for the whole file (qc3 F-4):
 * resolveHarnessDir honors the env var ahead of `.mstar/` probing, so an
 * ambient value would redirect every `.mstar` fixture to the env dir.
 */
const ENV_KEY = "MSTAR_HARNESS_DIR";
let previousEnv: string | undefined;
beforeEach(() => {
  previousEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});
afterEach(() => {
  if (previousEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previousEnv;
});

const validDoc = {
  version: 1,
  updated_at: "2026-08-08",
  plans: [],
  residual_findings: {},
  metadata: {},
};

/** Deliberately invalid: bad severity ("urgent") + dual-write under metadata. */
const invalidDoc = {
  version: 1,
  updated_at: "2026-08-08",
  plans: [],
  residual_findings: {
    "plan-1": [
      {
        id: "R1",
        title: "bad severity",
        severity: "urgent",
        source: "task-6-fixture",
        scope: "engine",
        decision: "defer",
        owner: "fullstack-dev",
        target: "2026-08-09",
        tracking: "fixture",
      },
    ],
  },
  metadata: {
    residual_findings: { "plan-1": [] },
  },
};

const makeHarnessStatusFile = (doc: unknown): string => {
  const project = mkdtempSync(join(tmpdir(), "mstar-opencode-"));
  mkdirSync(join(project, ".mstar"));
  const statusPath = join(project, ".mstar", "status.json");
  writeFileSync(statusPath, JSON.stringify(doc, null, 2));
  return statusPath;
};

describe("validateStatusWrite (exported hook module)", () => {
  test("valid status.json → ok result, no warnings", () => {
    const statusPath = makeHarnessStatusFile(validDoc);
    try {
      const warnings: string[] = [];
      const log: StatusLogger = (level, message) => {
        if (level === "warn") warnings.push(message);
      };
      const result = validateStatusWrite(statusPath, { log });
      expect(result).not.toBeNull();
      expect(result!.ok).toBe(true);
      expect(warnings).toEqual([]);
    } finally {
      rmSync(statusPath, { recursive: true, force: true });
    }
  });

  test("invalid status.json (bad severity + dual-write) → warn emitted, returns, never throws", () => {
    const statusPath = makeHarnessStatusFile(invalidDoc);
    try {
      const warnings: string[] = [];
      const log: StatusLogger = (level, message) => {
        if (level === "warn") warnings.push(message);
      };
      const result = validateStatusWrite(statusPath, { log });
      expect(result).not.toBeNull();
      expect(result!.ok).toBe(false);
      expect(warnings.some((w) => w.includes("status.dual-write-residuals"))).toBe(true);
      expect(warnings.some((w) => w.includes("status.residual.invalid-severity"))).toBe(true);
    } finally {
      rmSync(statusPath, { recursive: true, force: true });
    }
  });

  test("doc-based validation (write-tool content) catches invalid content pre-write", () => {
    const project = mkdtempSync(join(tmpdir(), "mstar-opencode-"));
    mkdirSync(join(project, ".mstar"));
    const statusPath = join(project, ".mstar", "status.json");
    try {
      const warnings: string[] = [];
      const log: StatusLogger = (level, message) => {
        if (level === "warn") warnings.push(message);
      };
      // File does not exist yet — the doc is all we can validate.
      const result = validateStatusWrite(statusPath, { doc: invalidDoc, log });
      expect(result).not.toBeNull();
      expect(result!.ok).toBe(false);
      expect(warnings.some((w) => w.includes("status.dual-write-residuals"))).toBe(true);
      // Valid doc → silent even when the file does not exist.
      warnings.length = 0;
      const okResult = validateStatusWrite(statusPath, { doc: validDoc, log });
      expect(okResult!.ok).toBe(true);
      expect(warnings).toEqual([]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("never throws on garbage content — degrades to invalid-json warn", () => {
    const project = mkdtempSync(join(tmpdir(), "mstar-opencode-"));
    mkdirSync(join(project, ".mstar"));
    const statusPath = join(project, ".mstar", "status.json");
    writeFileSync(statusPath, "not json {{{");
    try {
      const warnings: string[] = [];
      const log: StatusLogger = (level, message) => {
        if (level === "warn") warnings.push(message);
      };
      let result;
      expect(() => {
        result = validateStatusWrite(statusPath, { log });
      }).not.toThrow();
      expect(result!.ok).toBe(false);
      expect(warnings.some((w) => w.includes("status.invalid-json"))).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("non-status targets and non-harness paths are silent nulls", () => {
    const project = mkdtempSync(join(tmpdir(), "mstar-opencode-"));
    mkdirSync(join(project, ".mstar"));
    try {
      const warnings: string[] = [];
      const log: StatusLogger = (level, message) => {
        if (level === "warn") warnings.push(message);
      };
      // Not named status.json.
      expect(validateStatusWrite(join(project, "package.json"), { log })).toBeNull();
      // status.json outside the resolved harness dir (different subtree).
      const stray = join(project, "dist", "status.json");
      mkdirSync(join(project, "dist"));
      writeFileSync(stray, JSON.stringify(invalidDoc));
      expect(validateStatusWrite(stray, { log })).toBeNull();
      // Harness status.json that does not exist yet, no doc → nothing to validate.
      expect(validateStatusWrite(join(project, ".mstar", "status.json"), { log })).toBeNull();
      expect(warnings).toEqual([]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("plugin wiring (tool.execute.before)", () => {
  const captureConsoleWarn = (): (() => string[]) => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    return () => {
      console.warn = original;
      return warnings;
    };
  };

  test("write tool with invalid content warns; valid content stays silent", async () => {
    const plugin = await MorningStarHarnessPlugin();
    const project = mkdtempSync(join(tmpdir(), "mstar-opencode-"));
    mkdirSync(join(project, ".mstar"));
    const statusPath = join(project, ".mstar", "status.json");
    try {
      const restore = captureConsoleWarn();
      const beforeWrite = plugin["tool.execute.before"];
      expect(beforeWrite).toBeDefined();

      await beforeWrite!(
        { tool: "write", sessionID: "s1", callID: "c1" },
        { args: { filePath: statusPath, content: JSON.stringify(invalidDoc) } },
      );
      let warnings = restore();
      expect(warnings.some((w) => w.includes("[mstar-harness]") && w.includes("status.dual-write-residuals"))).toBe(true);

      const restore2 = captureConsoleWarn();
      await beforeWrite!(
        { tool: "write", sessionID: "s1", callID: "c2" },
        { args: { filePath: statusPath, content: JSON.stringify(validDoc) } },
      );
      warnings = restore2();
      expect(warnings.filter((w) => w.includes("[mstar-harness]"))).toEqual([]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("edit tool warns when the current file is invalid; read tool is ignored", async () => {
    const plugin = await MorningStarHarnessPlugin();
    const statusPath = makeHarnessStatusFile(invalidDoc);
    try {
      const restore = captureConsoleWarn();
      const beforeWrite = plugin["tool.execute.before"];

      await beforeWrite!(
        { tool: "edit", sessionID: "s1", callID: "c1" },
        { args: { filePath: statusPath, oldString: "x", newString: "y" } },
      );
      let warnings = restore();
      expect(warnings.some((w) => w.includes("[mstar-harness]") && w.includes("status.dual-write-residuals"))).toBe(true);

      // Non-write tools carrying a filePath must not trigger the lint.
      const restore2 = captureConsoleWarn();
      await beforeWrite!(
        { tool: "read", sessionID: "s1", callID: "c2" },
        { args: { filePath: statusPath } },
      );
      warnings = restore2();
      expect(warnings.filter((w) => w.includes("[mstar-harness]"))).toEqual([]);
    } finally {
      rmSync(statusPath, { recursive: true, force: true });
    }
  });
});
