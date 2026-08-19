/**
 * `.mstarc` module tests — parseMstarc (INI subset) + findMstarc (bounded
 * walk-up). Spec source: `skills/mstar-plan-conventions/SKILL.md`
 * § {HARNESS_DIR} 解析顺序 step 2 (`.mstarc` 格式) + § Git 跟踪策略
 * (gitignored by default).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMstarc, parseMstarc } from "../src/mstarc.js";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("parseMstarc — minimal INI subset ([config] harness_dir)", () => {
  test("parses every harness directory symbol key", () => {
    const text = [
      "[config]",
      "harness_dir=.custom_dir",
      "plan_dir=planning",
      "sdd_dir=process/sdd",
      "iteration_dir=process/iterations",
      "knowledge_dir=knowledge",
      "specs_dir=specs/custom",
      "workflow_dir=process/workflows",
      "project_dir=projects/archive",
    ].join("\n");
    expect(parseMstarc(text)).toEqual({
      harnessDir: ".custom_dir",
      planDir: "planning",
      sddDir: "process/sdd",
      iterationDir: "process/iterations",
      knowledgeDir: "knowledge",
      specsDir: "specs/custom",
      workflowDir: "process/workflows",
      projectDir: "projects/archive",
    });
  });

  test("parses the workflow_dir / project_dir keys (v3 workflow layout)", () => {
    expect(parseMstarc("[config]\nworkflow_dir=workflows\nproject_dir=projects\n")).toEqual({
      workflowDir: "workflows",
      projectDir: "projects",
    });
    expect(parseMstarc("[config]\nworkflow_dir=\nproject_dir=\n")).toEqual({});
  });

  test("parses the enforcement policy key (hard / soft; invalid ignored)", () => {
    expect(parseMstarc("[config]\nenforcement=hard\n")).toEqual({ enforcement: "hard" });
    expect(parseMstarc("[config]\nenforcement=soft\n")).toEqual({ enforcement: "soft" });
    expect(parseMstarc("[config]\nenforcement=aggressive\n")).toEqual({});
    expect(parseMstarc("[config]\nenforcement=\n")).toEqual({});
  });

  test("parses the canonical [config] harness_dir form", () => {
    expect(parseMstarc("[config]\nharness_dir=.custom_dir\n")).toEqual({ harnessDir: ".custom_dir" });
  });

  test("trims whitespace around keys and values", () => {
    expect(parseMstarc("[config]\n  harness_dir =  .custom_dir  \n")).toEqual({ harnessDir: ".custom_dir" });
  });

  test("ignores # and ; comments and blank lines", () => {
    const text = "# comment\n\n; another\n[config]\nharness_dir=.a\n";
    expect(parseMstarc(text)).toEqual({ harnessDir: ".a" });
  });

  test("ignores other sections and unknown keys (forward compatibility)", () => {
    const text = "[other]\nharness_dir=.wrong\n[config]\nsome_key=1\nharness_dir=.right\n";
    expect(parseMstarc(text)).toEqual({ harnessDir: ".right" });
  });

  test("the last harness_dir wins; an empty value is treated as unset", () => {
    expect(parseMstarc("[config]\nharness_dir=.a\nharness_dir=.b\n")).toEqual({ harnessDir: ".b" });
    expect(parseMstarc("[config]\nharness_dir=\n")).toEqual({});
  });

  test("an empty text / no [config] section yields an empty config", () => {
    expect(parseMstarc("")).toEqual({});
    expect(parseMstarc("[section]\nharness_dir=.x\n")).toEqual({});
  });

  test("CRLF line endings are tolerated", () => {
    expect(parseMstarc("[config]\r\nharness_dir=.custom_dir\r\n")).toEqual({ harnessDir: ".custom_dir" });
  });
});

describe("findMstarc — bounded find-first-stop walk-up", () => {
  test("finds the config in the start dir", () => {
    const root = tmpRoot("mstarc-find-");
    try {
      writeFileSync(join(root, ".mstarc"), "");
      expect(findMstarc(root, root)).toBe(join(root, ".mstarc"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("walks up to the boundary", () => {
    const root = tmpRoot("mstarc-walk-");
    try {
      writeFileSync(join(root, ".mstarc"), "");
      mkdirSync(join(root, "a", "b"), { recursive: true });
      expect(findMstarc(join(root, "a", "b"), root)).toBe(join(root, ".mstarc"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never reads a config above the boundary", () => {
    const root = tmpRoot("mstarc-boundary-");
    try {
      writeFileSync(join(root, ".mstarc"), "");
      mkdirSync(join(root, "proj"), { recursive: true });
      expect(findMstarc(join(root, "proj"), join(root, "proj"))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nearest config wins over an outer one", () => {
    const root = tmpRoot("mstarc-nearest-");
    try {
      writeFileSync(join(root, ".mstarc"), "");
      mkdirSync(join(root, "inner"));
      writeFileSync(join(root, "inner", ".mstarc"), "");
      expect(findMstarc(join(root, "inner", "deep"), root)).toBe(join(root, "inner", ".mstarc"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null when no config exists within the boundary", () => {
    const root = tmpRoot("mstarc-none-");
    try {
      expect(findMstarc(root, root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
