/**
 * omp Gate-1 golden block/pass parity (cross-host hooks contract D1).
 *
 * The GOLDEN map below is the literal record of the PRE-refactor omp gate
 * behavior (captured by running the pre-extraction
 * `src/hooks/pre/mstar-gates.ts` handler over this exact matrix): matrix =
 * 5 tmp-dir harness trees x {status, snapshot,
 * register} x {valid, invalid-json, oversized, missing}. Enforcement comes
 * from the tree (hard compass / soft compass / soft-by-absence at the
 * outer root of the double tree). The post-refactor gate — Gate 1 core now
 * imported from the engine `gates` module — must produce the identical
 * block/pass decision for every cell.
 *
 * Tree set (each git-inited so the declared-root fallback's workspace
 * boundary probe works):
 * - hard-default: `.mstar/` full markers + hard compass.
 * - soft-default: `.mstar/` full markers + soft compass.
 * - hard-custom: `.mstarc` custom `workflow_dir`/`project_dir` (Phase-5
 *   F1) + hard compass; canonical paths are the DECLARED dir names.
 * - hard-double: outer FULL-marker root (soft by absence of a compass) +
 *   inner SPARSE hard-governed harness (W-REV-3 re-classification).
 * - hard-declared: root `.mstarc` `harness_dir`, harness unpopulated
 *   (declared-root fallback branch).
 *
 * Target files for snapshot/register are absent in every tree (the write
 * path validates the content string, not the disk); the `missing` variant
 * sends a content-less edit event to the same absent paths (fresh-scaffold
 * silent pass). The status target exists in the marker trees (marker
 * requirement) — its `missing` cell there pins the on-disk edit path.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mstarGates from "../src/hooks/pre/mstar-gates";


// --- fixture docs ---

const VALID_STATUS = JSON.stringify({ version: 2, updated_at: "2026-09-08", workflows: [] });
const VALID_SNAPSHOT = JSON.stringify({
  schema_version: 1,
  id: "wf-g",
  type: "plan",
  status: "running",
  started_at: "2026-09-01",
  updated_at: "2026-09-08",
  plans: [],
});
const VALID_REGISTER = JSON.stringify({ entries: {} });
const INVALID_JSON = "{ not json";
const OVERSIZED = "x".repeat(2 * 1024 * 1024 + 1);

function compass(enforcement: "hard" | "soft"): string {
  return [
    "---",
    "iteration_id: iter-parity",
    "start_date: 2026-09-01",
    "status: active",
    `enforcement: ${enforcement}`,
    "iteration_base_branch: main",
    "target_branch: main",
    "plans:",
    "  - plan-a",
    "---",
    "",
    "# iter-parity Delivery Compass",
    "",
  ].join("\n");
}

function gitInit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
}

/** Target parent dirs exist (never the target file): the declared-root
 * fallback's git-probe needs an existing cwd, and canonical paths must
 * classify while the file stays absent (fresh-scaffold cells). */
function mkdirParents(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
}

interface Tree {
  id: string;
  root: string;
  status: string;
  snapshot: string;
  register: string;
}

function writeCompass(harness: string, enforcement: "hard" | "soft"): void {
  mkdirSync(join(harness, "iterations", "iter-parity"), { recursive: true });
  writeFileSync(join(harness, "iterations", "iter-parity", "delivery-compass.md"), compass(enforcement));
}

function buildTree(base: string, id: string): { root: string; harness: string } {
  const root = mkdtempSync(join(base, `${id}-`));
  return { root, harness: join(root, ".mstar") };
}

function buildHardDefault(base: string): Tree {
  const { root, harness } = buildTree(base, "hard-default");
  mkdirSync(join(harness, "workflows"), { recursive: true });
  mkdirSync(join(harness, "projects"), { recursive: true });
  writeFileSync(join(harness, "status.json"), VALID_STATUS);
  writeCompass(harness, "hard");
  gitInit(root);
  const tree: Tree = {
    id: "hard-default",
    root,
    status: join(harness, "status.json"),
    snapshot: join(harness, "workflows", "wf-g", "snapshot.json"),
    register: join(harness, "projects", "_g", "residuals.json"),
  };
  mkdirParents(tree.snapshot);
  mkdirParents(tree.register);
  return tree;
}

function buildSoftDefault(base: string): Tree {
  const { root, harness } = buildTree(base, "soft-default");
  mkdirSync(join(harness, "workflows"), { recursive: true });
  mkdirSync(join(harness, "projects"), { recursive: true });
  writeFileSync(join(harness, "status.json"), VALID_STATUS);
  writeCompass(harness, "soft");
  gitInit(root);
  const tree: Tree = {
    id: "soft-default",
    root,
    status: join(harness, "status.json"),
    snapshot: join(harness, "workflows", "wf-g", "snapshot.json"),
    register: join(harness, "projects", "_g", "residuals.json"),
  };
  mkdirParents(tree.snapshot);
  mkdirParents(tree.register);
  return tree;
}

function buildHardCustom(base: string): Tree {
  const { root, harness } = buildTree(base, "hard-custom");
  // Custom layout: coordination docs live under the DECLARED dir names,
  // never workflows//projects/ (Phase-5 F1).
  mkdirSync(join(harness, "cw-wf"), { recursive: true });
  mkdirSync(join(harness, "cw-pj"), { recursive: true });
  writeFileSync(join(harness, "status.json"), VALID_STATUS);
  writeFileSync(join(harness, ".mstarc"), "[config]\nworkflow_dir=cw-wf\nproject_dir=cw-pj\n");
  writeCompass(harness, "hard");
  gitInit(root);
  const tree: Tree = {
    id: "hard-custom",
    root,
    status: join(harness, "status.json"),
    snapshot: join(harness, "cw-wf", "wf-g", "snapshot.json"),
    register: join(harness, "cw-pj", "_g", "residuals.json"),
  };
  mkdirParents(tree.snapshot);
  mkdirParents(tree.register);
  return tree;
}

function buildHardDouble(base: string): Tree {
  // Outer FULL-marker root (soft by absence of a compass); inner SPARSE
  // hard-governed harness. Targets point at the inner harness.
  const { root } = buildTree(base, "hard-double");
  mkdirSync(join(root, "workflows"), { recursive: true });
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(join(root, "status.json"), VALID_STATUS);
  const inner = join(root, "inner", ".mstar");
  mkdirSync(join(inner, "workflows", "wf-g"), { recursive: true });
  mkdirSync(join(inner, "projects", "_g"), { recursive: true });
  writeCompass(inner, "hard");
  gitInit(root);
  return {
    id: "hard-double",
    root,
    status: join(inner, "status.json"), // absent at classification time
    snapshot: join(inner, "workflows", "wf-g", "snapshot.json"),
    register: join(inner, "projects", "_g", "residuals.json"),
  };
}

function buildHardDeclared(base: string): Tree {
  // Declared root only: `.mstarc` harness_dir at the repo root, harness
  // dir NOT populated with markers.
  const root = mkdtempSync(join(base, "hard-declared-"));
  writeFileSync(join(root, ".mstarc"), "[config]\nharness_dir=.harness\n");
  const harness = join(root, ".harness");
  mkdirSync(harness, { recursive: true });
  writeCompass(harness, "hard");
  gitInit(root);
  const tree: Tree = {
    id: "hard-declared",
    root,
    status: join(harness, "status.json"),
    snapshot: join(harness, "workflows", "wf-g", "snapshot.json"),
    register: join(harness, "projects", "_g", "residuals.json"),
  };
  mkdirParents(tree.snapshot);
  mkdirParents(tree.register);
  return tree;
}

// --- the parity run ---

const trees: Tree[] = [];

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "gate-parity-"));
  trees.push(
    buildHardDefault(base),
    buildSoftDefault(base),
    buildHardCustom(base),
    buildHardDouble(base),
    buildHardDeclared(base),
  );
});

afterAll(() => {
  for (const tree of trees) rmSync(tree.root, { recursive: true, force: true });
});

describe("omp Gate-1 coordination write refusal for retired FILE-route inputs", () => {
  test("the missing ACTIVE authority fails closed across coordination-document forms", async () => {
    const warnings: string[] = [];
    let handler: ((event: unknown) => Promise<unknown>) | undefined;
    mstarGates({
      on: (_event: string, fn: (event: unknown) => Promise<unknown>) => {
        handler = fn;
      },
      logger: { warn: (m: string) => warnings.push(m), error: () => undefined },
    } as never);
    expect(handler).toBeDefined();

    const actual: Record<string, "block" | "pass"> = {};
    for (const tree of trees) {
      const targets: Array<[string, string]> = [
        ["status", tree.status],
        ["snapshot", tree.snapshot],
        ["register", tree.register],
      ];
      for (const [kind, path] of targets) {
        const variants: Array<[string, string, string | undefined]> = [
          ["valid", "write", kind === "status" ? VALID_STATUS : kind === "snapshot" ? VALID_SNAPSHOT : VALID_REGISTER],
          ["invalid-json", "write", INVALID_JSON],
          ["oversized", "write", OVERSIZED],
          ["missing", "edit", undefined],
        ];
        for (const [variant, toolName, content] of variants) {
          const res = (await handler!({
            toolName,
            input: content === undefined ? { path } : { path, content },
          })) as { block: boolean; reason: string } | undefined;
          actual[`${tree.id}/${kind}/${variant}`] = res === undefined ? "pass" : "block";
        }
      }
    }

    // Retired-file route subjects (T7a/T21): the old captured pre-refactor
    // block/pass matrix is no longer authoritative. With no ACTIVE store,
    // every coordination-document operation is refused instead of falling
    // through to the retired document validator.
    const mismatches = Object.entries(actual).filter(([, result]) => result !== "block");
    expect(Object.keys(actual)).toHaveLength(60);
    expect(mismatches).toEqual([]);
  }, 60_000);
});
