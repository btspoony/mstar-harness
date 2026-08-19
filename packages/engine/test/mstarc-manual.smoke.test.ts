/**
 * No-engine `.mstarc` manual resolution smoke (plan-conventions § `.mstarc`
 * 格式 "无 engine 时的手工解析"): the skill text is the authoritative
 * resolver when the runtime is absent — this test pins the documented
 * hand-parsing rules (nearest config, bounded walk, relative-to-config
 * resolution, specs_dir authority, defaults) so the skill prose and the
 * engine implementation cannot silently diverge.
 *
 * Run WITHOUT importing anything from `../src/` — a plain Node script, the
 * same way a skill-driven agent would resolve the config.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { test, expect } from "bun:test";

type RcConfig = Record<string, string>;

/** Skill text § 无 engine 时的手工解析 steps 1–2: find-first-stop, bounded. */
function findMstarcManual(startDir: string, boundary: string): string | null {
  let dir = resolve(startDir);
  const bound = resolve(boundary);
  for (;;) {
    if (relative(bound, dir).startsWith("..") && dir !== bound) return null;
    const candidate = join(dir, ".mstarc");
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    if (existsSync(candidate)) return candidate;
    if (dir === bound) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Skill text § 无 engine 时的手工解析 step 2: [config] key=value, last wins, comments ignored. */
function parseMstarcManual(text: string): RcConfig {
  const out: RcConfig = {};
  let section: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      section = header[1];
      continue;
    }
    if (section !== "config") continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (value !== "") out[key] = value;
  }
  return out;
}

/** Skill text § 无 engine 时的手工解析 steps 3–5. */
function resolveDirsManual(startDir: string, boundary: string): Record<string, string> {
  const rc = findMstarcManual(startDir, boundary);
  const config = rc !== null ? parseMstarcManual(require("node:fs").readFileSync(rc, "utf8")) : {};
  const base = rc !== null ? dirname(rc) : resolve(startDir);
  const harnessDir = config.harness_dir ? (isAbsolute(config.harness_dir) ? config.harness_dir : join(base, config.harness_dir)) : join(boundary, ".mstar");
  // Sub-directory keys come from the nearest .mstarc at the harness dir or its parent.
  const sub = findMstarcManual(harnessDir, dirname(harnessDir));
  const subConfig = sub !== null ? parseMstarcManual(require("node:fs").readFileSync(sub, "utf8")) : {};
  const subBase = sub !== null ? dirname(sub) : base;
  const pick = (key: string, def: string): string => {
    const v = subConfig[key];
    return v ? (isAbsolute(v) ? v : join(subBase, v)) : join(harnessDir, def);
  };
  return {
    harness: harnessDir,
    plan: pick("plan_dir", "plans"),
    sdd: join(pick("sdd_dir", "sdd"), "plan-1"),
    iteration: pick("iteration_dir", "iterations"),
    knowledge: pick("knowledge_dir", "knowledge"),
    specs: subConfig.specs_dir ? (isAbsolute(subConfig.specs_dir) ? subConfig.specs_dir : join(subBase, subConfig.specs_dir)) : join(harnessDir, "specs"),
  };
}

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("no-engine manual resolution: all six keys from a repo-root .mstarc", () => {
  const root = tmpRoot("manual-rc-");
  try {
    writeFileSync(
      join(root, ".mstarc"),
      "[config]\nharness_dir=.custom_dir\nplan_dir=planning\nsdd_dir=process/sdd\niteration_dir=process/iterations\nknowledge_dir=knowledge\nspecs_dir=specs/custom\n",
    );
    const dirs = resolveDirsManual(root, root);
    expect(dirs.harness).toBe(join(root, ".custom_dir"));
    expect(dirs.plan).toBe(join(root, "planning"));
    expect(dirs.sdd).toBe(join(root, "process", "sdd", "plan-1"));
    expect(dirs.iteration).toBe(join(root, "process", "iterations"));
    expect(dirs.knowledge).toBe(join(root, "knowledge"));
    expect(dirs.specs).toBe(join(root, "specs", "custom"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no-engine manual resolution: defaults when no .mstarc exists", () => {
  const root = tmpRoot("manual-none-");
  try {
    const dirs = resolveDirsManual(root, root);
    expect(dirs.harness).toBe(join(root, ".mstar"));
    expect(dirs.plan).toBe(join(root, ".mstar", "plans"));
    expect(dirs.sdd).toBe(join(root, ".mstar", "sdd", "plan-1"));
    expect(dirs.iteration).toBe(join(root, ".mstar", "iterations"));
    expect(dirs.knowledge).toBe(join(root, ".mstar", "knowledge"));
    expect(dirs.specs).toBe(join(root, ".mstar", "specs"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no-engine manual resolution: nearest config wins; config above the boundary never applies", () => {
  const root = tmpRoot("manual-boundary-");
  try {
    writeFileSync(join(root, ".mstarc"), "[config]\nplan_dir=outer-plans\n");
    mkdirSync(join(root, "proj"), { recursive: true });
    writeFileSync(join(root, "proj", ".mstarc"), "[config]\nplan_dir=inner-plans\n");
    const dirs = resolveDirsManual(join(root, "proj"), join(root, "proj"));
    expect(dirs.plan).toBe(join(root, "proj", "inner-plans"));
    // harness default lives under the boundary too
    expect(dirs.harness).toBe(join(root, "proj", ".mstar"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no-engine manual resolution: comments, CRLF, last-key-wins", () => {
  const root = tmpRoot("manual-comments-");
  try {
    writeFileSync(join(root, ".mstarc"), "# comment\r\n[config]\r\nplan_dir=first\r\nplan_dir=second ; (inline not stripped — full-line comments only)\r\n");
    const dirs = resolveDirsManual(root, root);
    expect(dirs.plan).toBe(join(root, "second ; (inline not stripped — full-line comments only)"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
