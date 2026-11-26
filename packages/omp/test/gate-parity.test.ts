/** why: omp Gate-1 golden block/pass parity (cross-host hooks contract D1).
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
 * Tree set (each git-inited so the fixed `<main worktree>/.mstar`
 * resolution answers a root):
 * - hard-default: `.mstar/` full markers + hard compass.
 * - soft-default: `.mstar/` full markers + soft compass.
 * - hard-custom: `.mstarc` custom `workflow_dir`/`project_dir` (Phase-5
 *   F1) + hard compass; canonical paths are the DECLARED dir names.
 * - retired-legacy: a sparse `.agents/` harness (retired candidate —
 *   classification refuses `harness.root-retired`).
 * - retired-declared: root `.mstarc` `harness_dir` (retired declaration —
 *   resolution refuses `harness.root-retired`).
 *
 * Target files for snapshot/register are absent in every tree (the write
 * path validates the content string, not the disk); the `missing` variant
 * sends a content-less edit event to the same absent paths (fresh-scaffold
 * silent pass). The status target exists in the marker trees (marker
 * requirement) — its `missing` cell there pins the on-disk edit path.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function buildRetiredLegacy(base: string): Tree {
  // why: A `.agents/` layout is ignored, never adopted: without `.mstar` there
  // is no harness root, so the gate does not classify these writes at all.
  const root = mkdtempSync(join(base, "retired-legacy-"));
  const harness = join(root, ".agents");
  writeCompass(harness, "hard");
  gitInit(root);
  const tree: Tree = {
    id: "retired-legacy",
    root,
    status: join(harness, "status.json"),
    snapshot: join(harness, "workflows", "wf-g", "snapshot.json"),
    register: join(harness, "projects", "_g", "residuals.json"),
  };
  mkdirParents(tree.snapshot);
  mkdirParents(tree.register);
  return tree;
}

function buildRetiredDeclared(base: string): Tree {
  // why: `.mstarc` `harness_dir` is ignored: the declared `.harness` dir is not
  // a root, so these writes are not classified.
  const root = mkdtempSync(join(base, "retired-declared-"));
  writeFileSync(join(root, ".mstarc"), "[config]\nharness_dir=.harness\n");
  const harness = join(root, ".harness");
  mkdirSync(harness, { recursive: true });
  writeCompass(harness, "hard");
  gitInit(root);
  const tree: Tree = {
    id: "retired-declared",
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
    buildRetiredLegacy(base),
    buildRetiredDeclared(base),
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
    const reasons: Record<string, string> = {};
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
          if (res !== undefined) reasons[`${tree.id}/${kind}/${variant}`] = res.reason;
        }
      }
    }

    // Retired-file route subjects (T7a/T21): the old captured pre-refactor
    // block/pass matrix is no longer authoritative. With no ACTIVE store,
    // every coordination-document operation is refused instead of falling
    // through to the retired document validator.
    const mismatches = Object.entries(actual).filter(([key, result]) => {
      const retired = key.startsWith("retired-legacy/") || key.startsWith("retired-declared/");
      return retired ? result !== "pass" : result !== "block";
    });
    expect(Object.keys(actual)).toHaveLength(60);
    expect(mismatches).toEqual([]);

    // why: Retired trees are ignored, not refused — the gate does not classify
    // them at all, so no retired-contract reason is produced.
    for (const key of Object.keys(reasons)) {
      expect(key.startsWith("retired-legacy/") || key.startsWith("retired-declared/")).toBe(false);
    }
  }, 60_000);
});

describe("omp gate unexpected errors", () => {
  test("blocks unexpected gate failures and preserves normal pass behavior", async () => {
    let handler: ((event: unknown) => Promise<unknown>) | undefined;
    mstarGates({
      on: (_event: string, fn: (event: unknown) => Promise<unknown>) => {
        handler = fn;
      },
      logger: { warn: () => undefined, error: () => undefined },
    } as never);
    expect(handler).toBeDefined();

    const failure = new Error("injected gate failure");
    const throwingEvent = {
      toolName: "write",
      get input(): never {
        throw failure;
      },
    };
    expect(await handler!(throwingEvent)).toEqual({
      block: true,
      reason: "Unexpected error in status-write gate: injected gate failure",
    });
    expect(
      await handler!({ toolName: "write", input: { path: "/tmp/ordinary-document.md", content: "ok" } }),
    ).toBeUndefined();
  });
});

describe("omp Gate-1 authority path resolution (issue #442)", () => {
  test("refuses a chained symlink alias landing on the authority database", async () => {
    // Two hops: the outer link points at a link that points at the harness
    // store sidecar. The engine's chained resolver follows the whole chain;
    // the previous one-hop copy stopped at the middle link (a non-authority
    // name) and let the write through.
    const root = mkdtempSync(join(tmpdir(), "omp-gate-chain-"));
    try {
      const harness = join(root, ".mstar");
      mkdirSync(join(harness, "workflows"), { recursive: true });
      mkdirSync(join(harness, "projects"), { recursive: true });
      writeFileSync(join(harness, "status.json"), VALID_STATUS);
      symlinkSync(join(harness, "store.db-wal"), join(root, "chain-inner"));
      symlinkSync("chain-inner", join(root, "chain-outer"));

      let handler: ((event: unknown) => Promise<unknown>) | undefined;
      mstarGates({
        on: (_event: string, fn: (event: unknown) => Promise<unknown>) => {
          handler = fn;
        },
        logger: { warn: () => undefined, error: () => undefined },
      } as never);
      expect(handler).toBeDefined();

      const res = (await handler!({
        toolName: "write",
        input: { path: join(root, "chain-outer"), content: "unauthorized" },
      })) as { block: boolean; reason: string } | undefined;
      expect(res?.block).toBe(true);
      expect(res?.reason).toContain("store.direct-write-refused");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
/** Fully valid writable Assignment in the front matter field contract. */
const VALID_WRITABLE = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: feature/omp-gate-test
task_budget: S — one focused implementer round
---

## Assignment

Do the thing, evidence-first.
`;

/** The retired body-label format of {@link VALID_WRITABLE} — same fields as
 * `**Label**` body lines (the format front matter replaced). */
const LEGACY_BODY_LABEL = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/omp-gate-test
**Task budget (implement / ops rounds)**: S — one focused implementer round

Do the thing, evidence-first.
`;

describe("omp Gate-2 — D14/D16 assignment source (pointer parity and legacy refusal)", () => {
  /** A soft-enforcement tree chdir'd for the suite: the root supplies the
   * control harness home the pointer resolver contains against. */
  let root = "";
  let harness = "";
  let previousCwd = "";
  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "omp-gate2-"));
    root = join(base, "gate2");
    mkdirSync(root, { recursive: true });
    harness = join(root, ".mstar");
    mkdirSync(join(harness, "workflows"), { recursive: true });
    mkdirSync(join(harness, "projects"), { recursive: true });
    writeFileSync(join(harness, "status.json"), VALID_STATUS);
    writeCompass(harness, "soft");
    gitInit(root);
    previousCwd = process.cwd();
    process.chdir(root);
  });
  afterAll(() => {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  });

  function gate2(): { handler: (event: unknown) => Promise<unknown>; warnings: string[] } {
    const warnings: string[] = [];
    let handler: ((event: unknown) => Promise<unknown>) | undefined;
    mstarGates({
      on: (_event: string, fn: (event: unknown) => Promise<unknown>) => {
        handler = fn;
      },
      logger: { warn: (m: string) => warnings.push(m), error: () => undefined },
    } as never);
    if (handler === undefined) throw new Error("handler was not registered");
    return { handler, warnings };
  }

  function dispatchEvent(task: string): unknown {
    return {
      toolName: "task",
      input: { name: "impl", agent: "fullstack-dev", task },
    };
  }

  test("a pointer under an accepted assignment home passes exactly like the inline form", async () => {
    const inline = gate2();
    expect(await inline.handler(dispatchEvent(VALID_WRITABLE))).toBeUndefined();

    mkdirSync(join(harness, "assignments"), { recursive: true });
    const file = join(harness, "assignments", "pointer-target.md");
    writeFileSync(file, VALID_WRITABLE);
    const pointer = gate2();
    expect(await pointer.handler(dispatchEvent(`Assignment file: ${file}`))).toBeUndefined();
  });

  test("a pointer to a violating assignment blocks exactly like the inline form under hard enforcement", async () => {
    const violating = `---
enforcement: hard
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
task_budget: XS — one implementer round
---

## Assignment

No branch form here.
`;
    const inline = gate2();
    const inlineResult = (await inline.handler(dispatchEvent(violating))) as { block: boolean; reason: string } | undefined;
    expect(inlineResult?.block).toBe(true);
    expect(inlineResult?.reason).toContain("assignment.field.branch-missing");

    mkdirSync(join(harness, "assignments"), { recursive: true });
    const file = join(harness, "assignments", "hard-pointer-target.md");
    writeFileSync(file, violating);
    const pointer = gate2();
    const pointerResult = (await pointer.handler(dispatchEvent(`Assignment file: ${file}`))) as { block: boolean; reason: string } | undefined;
    expect(pointerResult?.block).toBe(true);
    expect(pointerResult?.reason).toContain("assignment.field.branch-missing");
  });

  test("an out-of-home pointer blocks fail-closed even under SOFT enforcement — tool body not reached", async () => {
    const gate = gate2();
    const outside = join(root, "outside-assignment.md");
    writeFileSync(outside, VALID_WRITABLE);
    const result = (await gate.handler(dispatchEvent(`Assignment file: ${outside}`))) as { block: boolean; reason: string } | undefined;
 // Critical source-resolution refusal: hard independent of document/repo
 // enforcement — the hook blocks even on the soft compass.
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("dispatch.assignment.path");
  });

  test("a null control harness root blocks fail-closed — tool body not reached", async () => {
 // A bare non-git directory: no checkout, no `.mstar` — the resolver cannot
 // answer a root, so the pointer can never be containment-checked.
    const bare = mkdtempSync(join(tmpdir(), "omp-null-root-"));
    writeFileSync(join(bare, "a.md"), VALID_WRITABLE);
    process.chdir(bare);
    try {
      const gate = gate2();
      const result = (await gate.handler(dispatchEvent(`Assignment file: ${join(bare, "a.md")}`))) as { block: boolean; reason: string } | undefined;
      expect(result?.block).toBe(true);
      expect(result?.reason).toContain("dispatch.assignment.path");
    } finally {
      process.chdir(root);
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("a body-label prompt refuses dispatch.assignment.legacy-format with both recoveries", async () => {
    const gate = gate2();
    const result = (await gate.handler(dispatchEvent(LEGACY_BODY_LABEL))) as { block: boolean } | undefined;
    expect(result).toBeUndefined();
    const joined = gate.warnings.join("\n");
    expect(joined).toContain("dispatch.assignment.legacy-format");
    expect(joined).toContain("front-matter document");
    expect(joined).toContain("Assignment file:");
    expect(joined).not.toContain("document.frontmatter.absent");
  });

  test("the legacy refusal blocks under the document-own hard enforcement tree", async () => {
    // Hard compass in the chdir'd tree: the same legacy document must block.
    writeCompass(harness, "hard");
    try {
      const gate = gate2();
      const result = (await gate.handler(dispatchEvent(LEGACY_BODY_LABEL))) as { block: boolean; reason: string } | undefined;
      expect(result?.block).toBe(true);
      expect(result?.reason).toContain("dispatch.assignment.legacy-format");
    } finally {
      writeCompass(harness, "soft");
    }
  });
});

