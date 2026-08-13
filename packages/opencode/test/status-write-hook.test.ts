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
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MorningStarHarnessPlugin, validateStatusWrite, type StatusLogger } from "../src/mstar.js";
import type { GateResult } from "@mstar-harness/engine";

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

/**
 * Temp project rooted in a real git repo. `resolveHarnessDir` bounds its
 * upward probe at the git top-level (roadmap §7c; a non-git start probes
 * only itself), so harness fixtures must live inside a git work tree —
 * matching real consumer repos.
 */
const makeProject = (): string => {
  const project = mkdtempSync(join(tmpdir(), "mstar-opencode-"));
  execFileSync("git", ["init", "-q", project], { stdio: "ignore" });
  return project;
};

const makeHarnessStatusFile = (doc: unknown): string => {
  const project = makeProject();
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
    const project = makeProject();
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
    const project = makeProject();
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

  test("non-string targetPath stays silent (no paths[0] abort)", () => {
    // Bun path.resolve(object) → `The "paths[0]" property must be of type string, got object`.
    const entries: Array<[string, string]> = [];
    const log: StatusLogger = (level, message) => {
      entries.push([level, message]);
    };
    for (const bad of [{ path: "/tmp/.mstar/status.json" }, ["/tmp/.mstar/status.json"], 123, null, undefined] as unknown[]) {
      expect(validateStatusWrite(bad as string, { log })).toBeNull();
    }
    expect(entries.filter(([, msg]) => msg.includes("status.json validation aborted"))).toEqual([]);
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
    const project = makeProject();
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

  test("write tool accepts args.path alias and object content; getter re-access stays quiet", async () => {
    const plugin = await MorningStarHarnessPlugin();
    const project = makeProject();
    mkdirSync(join(project, ".mstar"));
    const statusPath = join(project, ".mstar", "status.json");
    try {
      const beforeWrite = plugin["tool.execute.before"];
      expect(beforeWrite).toBeDefined();

      const errors: string[] = [];
      const originalError = console.error;
      console.error = (message?: unknown) => {
        errors.push(String(message));
      };
      try {
        // path alias + already-parsed object content
        await beforeWrite!(
          { tool: "write", sessionID: "s1", callID: "c1" },
          { args: { path: statusPath, content: invalidDoc } },
        );
        // Getter that flips type after the typeof snapshot would previously
        // reach path.resolve(object) and log status.json validation aborted.
        let reads = 0;
        const flakyArgs = {
          get filePath() {
            reads += 1;
            return reads === 1 ? statusPath : ({ path: statusPath } as unknown as string);
          },
          content: JSON.stringify(validDoc),
        };
        await beforeWrite!({ tool: "write", sessionID: "s1", callID: "c2" }, { args: flakyArgs });
      } finally {
        console.error = originalError;
      }
      expect(errors.filter((e) => e.includes("status.json validation aborted"))).toEqual([]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("hard mode (compass enforcement: hard — Slice 5, roadmap §8.5 C4/D2)", () => {
  // Spec: roadmap §8.5 C4 + D2 — v2 hard gates are opt-in per
  // Assignment/compass; compass frontmatter `enforcement: hard` in the repo
  // makes invalid status writes refused (structured result with
  // `hardBlocked`, error-level logs, never a raw throw); flag absent →
  // warn-only (unchanged); explicit `opts.enforcement` (write context)
  // overrides the compass probe.
  const capture = (): { entries: Array<[string, string]>; log: StatusLogger } => {
    const entries: Array<[string, string]> = [];
    const log: StatusLogger = (level, message) => {
      entries.push([level, message]);
    };
    return { entries, log };
  };

  /** Create a project with `.mstar/status.json` + an iteration compass. */
  const makeHardRepo = (hard: boolean): { project: string; statusPath: string } => {
    const project = makeProject();
    const harness = join(project, ".mstar");
    mkdirSync(join(harness, "iterations", "20260808-demo"), { recursive: true });
    const enforcement = hard ? "enforcement: hard\n" : "";
    writeFileSync(
      join(harness, "iterations", "20260808-demo", "delivery-compass.md"),
      `---\niteration_id: 20260808-demo\nstatus: active\n${enforcement}---\n\n# Delivery Compass\n`,
      "utf8",
    );
    const statusPath = join(harness, "status.json");
    writeFileSync(statusPath, JSON.stringify(validDoc, null, 2));
    return { project, statusPath };
  };

  test("repo compass enforcement: hard + invalid write → hardBlocked true, error logs, no raw throw", () => {
    const { project, statusPath } = makeHardRepo(true);
    try {
      const { entries, log } = capture();
      let result: GateResult | null = null;
      expect(() => {
        result = validateStatusWrite(statusPath, { doc: invalidDoc, log });
      }).not.toThrow();
      expect(result!.ok).toBe(false);
      expect(result!.hardBlocked).toBe(true);
      expect(
        entries.some(([level, text]) => level === "error" && text.includes("status.dual-write-residuals")),
      ).toBe(true);
      // No warn-level lines for the same violations in hard mode.
      expect(entries.some(([level]) => level === "warn")).toBe(false);
      // Skill-text pointer present.
      expect(entries.some(([, text]) => text.includes("Enforcement: hard"))).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("repo compass enforcement: hard + valid write → ok, hardBlocked false, silent", () => {
    const { project, statusPath } = makeHardRepo(true);
    try {
      const { entries, log } = capture();
      const result = validateStatusWrite(statusPath, { doc: validDoc, log });
      expect(result!.ok).toBe(true);
      expect(result!.hardBlocked).toBe(false);
      expect(entries).toEqual([]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("no compass enforcement in the repo → warn-only, hardBlocked false (unchanged v1 behavior)", () => {
    const { project, statusPath } = makeHardRepo(false);
    try {
      const { entries, log } = capture();
      const result = validateStatusWrite(statusPath, { doc: invalidDoc, log });
      expect(result!.ok).toBe(false);
      expect(result!.hardBlocked).toBe(false);
      expect(entries.some(([level]) => level === "warn")).toBe(true);
      expect(entries.some(([level]) => level === "error")).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("explicit write-context enforcement (opts.enforcement) overrides the compass probe", () => {
    // No compass at all — the explicit flag decides.
    const project = makeProject();
    mkdirSync(join(project, ".mstar"));
    const statusPath = join(project, ".mstar", "status.json");
    try {
      const { entries, log } = capture();
      const hard = validateStatusWrite(statusPath, {
        doc: invalidDoc,
        log,
        enforcement: { hard: true, source: "assignment" },
      });
      expect(hard!.hardBlocked).toBe(true);
      expect(entries.some(([level]) => level === "error")).toBe(true);

      // Explicit non-hard override wins over a hard compass.
      const { project: hardProject, statusPath: hardStatusPath } = makeHardRepo(true);
      try {
        const soft = validateStatusWrite(hardStatusPath, {
          doc: invalidDoc,
          log,
          enforcement: { hard: false, source: "none" },
        });
        expect(soft!.hardBlocked).toBe(false);
      } finally {
        rmSync(hardProject, { recursive: true, force: true });
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("plugin wiring: write tool in a hard repo logs error-level lines, never throws", async () => {
    const { project, statusPath } = makeHardRepo(true);
    try {
      const plugin = await MorningStarHarnessPlugin();
      const beforeWrite = plugin["tool.execute.before"];
      const errors: string[] = [];
      const original = console.error;
      console.error = (message?: unknown) => {
        errors.push(String(message));
      };
      try {
        await beforeWrite!(
          { tool: "write", sessionID: "s1", callID: "c1" },
          { args: { filePath: statusPath, content: JSON.stringify(invalidDoc) } },
        );
      } finally {
        console.error = original;
      }
      expect(errors.some((e) => e.includes("[mstar-harness]") && e.includes("hard gate"))).toBe(true);
      // The GateResult is not silently discarded: the hook surfaces the
      // hardBlocked state explicitly (host has no refusal channel).
      expect(errors.some((e) => e.includes("hard-gate blocked (hardBlocked=true)"))).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
