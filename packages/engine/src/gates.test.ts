/**
 * `gates` — host-neutral coordination-write gate core (cross-host hooks
 * contract D1). Each test cites the moved behavior it
 * pins (the omp glue this module was extracted from):
 * - `eventTargetPaths`: `input.path` + `input.paths[]`, non-string/blank
 *   entries dropped, non-object input -> `[]`.
 * - `harnessDocKindOfTarget` over tmp-dir fixture harness trees: default
 *   `.mstar` layout (marker probe never mistakes the nested `plans/` rung
 *   for the root), `.mstarc` custom `workflow_dir`/`project_dir` layout
 *   (Phase-5 F1 — declared names canonical, default names not), W-REV-3
 *   pathological double harness (probe root hit + non-canonical rel ->
 *   declared-root re-classification of the inner sparse harness), and the
 *   declared-root fallback (`.mstarc` `harness_dir`, unpopulated root).
 * - `validateStatusWriteDoc`: content-string parse -> per-kind validator
 *   dispatch -> `status.invalid-json` parity codes (parse failure,
 *   non-object JSON, on-disk unparseable snapshot/register) -> 2 MB size
 *   guards on BOTH paths -> fresh-scaffold silent pass -> never throws.
 * - `violationLine` / `formatStatusWriteBlockReason`: exact block-reason
 *   shape incl. the host skill pointer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_STATUS_CONTENT_LENGTH,
  eventTargetPaths,
  formatStatusWriteBlockReason,
  harnessDocKindOfTarget,
  validateStatusWriteDoc,
  violationLine,
} from "./gates.js";

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

function gitInit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
}

/** Target parent dirs exist (never the target file): the declared-root
 * fallback's git-probe needs an existing cwd, and canonical paths must
 * classify while the file stays absent. */
function mkdirParents(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
}

interface Tree {
  root: string;
  harness: string;
  status: string;
  snapshot: string;
  register: string;
}

function buildDefaultTree(base: string, id: string): Tree {
  const root = mkdtempSync(join(tmpdir(), `${id}-`));
  const harness = join(root, ".mstar");
  mkdirSync(join(harness, "workflows"), { recursive: true });
  mkdirSync(join(harness, "projects"), { recursive: true });
  mkdirSync(join(harness, "plans"), { recursive: true }); // nested rung — must NOT be probed as the root
  writeFileSync(join(harness, "status.json"), VALID_STATUS);
  gitInit(root);
  const tree: Tree = {
    root,
    harness,
    status: join(harness, "status.json"),
    snapshot: join(harness, "workflows", "wf-g", "snapshot.json"),
    register: join(harness, "projects", "_g", "residuals.json"),
  };
  mkdirParents(tree.snapshot);
  mkdirParents(tree.register);
  return tree;
}

function buildCustomTree(base: string): Tree {
  const root = mkdtempSync(join(tmpdir(), "gates-custom-"));
  const harness = join(root, ".mstar");
  mkdirSync(join(harness, "cw-wf"), { recursive: true });
  mkdirSync(join(harness, "cw-pj"), { recursive: true });
  writeFileSync(join(harness, "status.json"), VALID_STATUS);
  writeFileSync(join(harness, ".mstarc"), "[config]\nworkflow_dir=cw-wf\nproject_dir=cw-pj\n");
  gitInit(root);
  const tree: Tree = {
    root,
    harness,
    status: join(harness, "status.json"),
    snapshot: join(harness, "cw-wf", "wf-g", "snapshot.json"),
    register: join(harness, "cw-pj", "_g", "residuals.json"),
  };
  mkdirParents(tree.snapshot);
  mkdirParents(tree.register);
  return tree;
}

function buildDoubleTree(base: string): Tree {
  // Outer FULL-marker root; inner SPARSE harness (no status.json) holding
  // the coordination docs — the probe returns the outer root, the W-REV-3
  // retry must re-classify against the inner declared-root resolution.
  const root = mkdtempSync(join(tmpdir(), "gates-double-"));
  mkdirSync(join(root, "workflows"), { recursive: true });
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(join(root, "status.json"), VALID_STATUS);
  const inner = join(root, "inner", ".mstar");
  mkdirSync(join(inner, "workflows", "wf-g"), { recursive: true });
  mkdirSync(join(inner, "projects", "_g"), { recursive: true });
  gitInit(root);
  return {
    root,
    harness: inner,
    status: join(inner, "status.json"),
    snapshot: join(inner, "workflows", "wf-g", "snapshot.json"),
    register: join(inner, "projects", "_g", "residuals.json"),
  };
}

function buildDeclaredTree(base: string): Tree {
  // `.mstarc` harness_dir at the repo root; harness dir NOT populated with
  // markers — classification only via the resolveHarnessDir fallback.
  const root = mkdtempSync(join(tmpdir(), "gates-declared-"));
  writeFileSync(join(root, ".mstarc"), "[config]\nharness_dir=.harness\n");
  const harness = join(root, ".harness");
  mkdirSync(harness, { recursive: true });
  gitInit(root);
  const tree: Tree = {
    root,
    harness,
    status: join(harness, "status.json"),
    snapshot: join(harness, "workflows", "wf-g", "snapshot.json"),
    register: join(harness, "projects", "_g", "residuals.json"),
  };
  mkdirParents(tree.snapshot);
  mkdirParents(tree.register);
  return tree;
}

const trees: Array<{ name: string; tree: Tree }> = [];

beforeAll(() => {
  trees.push(
    { name: "default", tree: buildDefaultTree(tmpdir(), "gates-default") },
    { name: "custom", tree: buildCustomTree(tmpdir()) },
    { name: "double", tree: buildDoubleTree(tmpdir()) },
    { name: "declared", tree: buildDeclaredTree(tmpdir()) },
  );
});

afterAll(() => {
  for (const { tree } of trees) rmSync(tree.root, { recursive: true, force: true });
});

describe("gates.eventTargetPaths", () => {
  test("collects input.path plus input.paths[], dropping non-string/blank entries", () => {
    expect(eventTargetPaths({ path: "a/b", paths: ["c/d", 5, "   ", null] })).toEqual(["a/b", "c/d"]);
  });

  test("non-object input and missing fields -> []", () => {
    expect(eventTargetPaths(null)).toEqual([]);
    expect(eventTargetPaths("nope")).toEqual([]);
    expect(eventTargetPaths({})).toEqual([]);
    expect(eventTargetPaths({ path: "  " })).toEqual([]);
  });
});

describe("gates.harnessDocKindOfTarget", () => {
  test("MAX_STATUS_CONTENT_LENGTH is the 2 MB guard", () => {
    expect(MAX_STATUS_CONTENT_LENGTH).toBe(2 * 1024 * 1024);
  });

  test("default layout: all three coordination docs classify at the .mstar root", () => {
    const { tree } = trees[0]!;
    expect(harnessDocKindOfTarget(tree.status)).toEqual({ harnessDir: tree.harness, kind: "status" });
    expect(harnessDocKindOfTarget(tree.snapshot)).toEqual({ harnessDir: tree.harness, kind: "snapshot" });
    expect(harnessDocKindOfTarget(tree.register)).toEqual({ harnessDir: tree.harness, kind: "register" });
  });

  test("default layout: marker probe wins over the nested plans/ rung; plans/ holds no snapshot/register docs", () => {
    const { tree } = trees[0]!;
    // Inside .mstar/plans the rung-3 probe would resolve plans/ as the
    // harness — the marker probe must win for the root's own docs.
    expect(harnessDocKindOfTarget(tree.status)).toEqual({ harnessDir: tree.harness, kind: "status" });
    // plans/ holds no canonical snapshot/register docs (fail-open stays
    // bounded). A status.json directly inside plans/ classifies at the
    // plans rung via the W-REV-3 retry (verbatim pre-extraction behavior:
    // the declared-root fallback can return the plans rung; pathological,
    // and soft-governed in practice — plans/ carries no compass). Pinned
    // as-is so the moved code stays byte-faithful.
    expect(harnessDocKindOfTarget(join(tree.harness, "plans", "workflows", "wf-x", "snapshot.json"))).toBeNull();
    const inPlans = harnessDocKindOfTarget(join(tree.harness, "plans", "status.json"));
    expect(inPlans).toEqual({ harnessDir: join(tree.harness, "plans"), kind: "status" });
  });

  test("non-canonical rel shapes stay ungated (never over-gate)", () => {
    const { tree } = trees[0]!;
    expect(harnessDocKindOfTarget(join(tree.harness, "workflows", "snapshot.json"))).toBeNull();
    expect(harnessDocKindOfTarget(join(tree.root, "status.json"))).toBeNull();
    expect(harnessDocKindOfTarget("unrelated.md")).toBeNull();
  });

  test("custom .mstarc layout: declared dirs classify, default names do not (Phase-5 F1)", () => {
    const { tree } = trees[1]!;
    expect(harnessDocKindOfTarget(tree.status)).toEqual({ harnessDir: tree.harness, kind: "status" });
    expect(harnessDocKindOfTarget(tree.snapshot)).toEqual({ harnessDir: tree.harness, kind: "snapshot" });
    expect(harnessDocKindOfTarget(tree.register)).toEqual({ harnessDir: tree.harness, kind: "register" });
    expect(harnessDocKindOfTarget(join(tree.harness, "workflows", "wf-g", "snapshot.json"))).toBeNull();
    expect(harnessDocKindOfTarget(join(tree.harness, "projects", "_g", "residuals.json"))).toBeNull();
  });

  test("W-REV-3 double harness: inner sparse-harness docs re-classify to the inner root", () => {
    const { tree } = trees[2]!;
    expect(harnessDocKindOfTarget(tree.status)).toEqual({ harnessDir: tree.harness, kind: "status" });
    expect(harnessDocKindOfTarget(tree.snapshot)).toEqual({ harnessDir: tree.harness, kind: "snapshot" });
    expect(harnessDocKindOfTarget(tree.register)).toEqual({ harnessDir: tree.harness, kind: "register" });
  });

  test("declared root (.mstarc harness_dir) classifies via the fallback", () => {
    const { tree } = trees[3]!;
    expect(harnessDocKindOfTarget(tree.status)).toEqual({ harnessDir: tree.harness, kind: "status" });
    expect(harnessDocKindOfTarget(tree.snapshot)).toEqual({ harnessDir: tree.harness, kind: "snapshot" });
    expect(harnessDocKindOfTarget(tree.register)).toEqual({ harnessDir: tree.harness, kind: "register" });
  });

  test("blank/empty target is never gated", () => {
    expect(harnessDocKindOfTarget("")).toBeNull();
    expect(harnessDocKindOfTarget("   ")).toBeNull();
  });
});

describe("gates.validateStatusWriteDoc", () => {
  test("valid per-kind content -> no violations", () => {
    const { tree } = trees[0]!;
    expect(validateStatusWriteDoc(VALID_STATUS, tree.status, "status")).toEqual([]);
    expect(validateStatusWriteDoc(VALID_SNAPSHOT, tree.snapshot, "snapshot")).toEqual([]);
    expect(validateStatusWriteDoc(VALID_REGISTER, tree.register, "register")).toEqual([]);
  });


  test("kind dispatch routes each kind to its own validator", () => {
    const { tree } = trees[0]!;
    // A register doc validated as snapshot must surface snapshot codes.
    const asSnapshot = validateStatusWriteDoc(VALID_REGISTER, tree.snapshot, "snapshot");
    expect(asSnapshot.length).toBeGreaterThan(0);
    for (const v of asSnapshot) expect(v.code.startsWith("workflow.snapshot.")).toBe(true);
    // A snapshot doc validated as register must surface register codes.
    const asRegister = validateStatusWriteDoc(VALID_SNAPSHOT, tree.register, "register");
    expect(asRegister.length).toBeGreaterThan(0);
    for (const v of asRegister) expect(v.code.startsWith("project.register.")).toBe(true);
  });

  test("v1-shaped status content -> status.migration-required (hard cutover)", () => {
    const { tree } = trees[0]!;
    const violations = validateStatusWriteDoc(JSON.stringify({ version: 1, plans: [] }), tree.status, "status");
    expect(violations.map((v) => v.code)).toEqual(["status.migration-required"]);
  });

  test("unparseable content string -> status.invalid-json with the parse message", () => {
    const { tree } = trees[0]!;
    const violations = validateStatusWriteDoc("{ not json", tree.snapshot, "snapshot");
    expect(violations).toHaveLength(1);
    expect(violations[0]!.severity).toBe("high");
    expect(violations[0]!.code).toBe("status.invalid-json");
    expect(violations[0]!.message).toContain("JSON Parse error");
  });

  test("parsed non-object content -> status.invalid-json naming the basename", () => {
    const { tree } = trees[0]!;
    for (const content of ["null", "[1,2]", '"str"']) {
      const violations = validateStatusWriteDoc(content, tree.status, "status");
      expect(violations).toHaveLength(1);
      expect(violations[0]!.code).toBe("status.invalid-json");
      expect(violations[0]!.message).toBe("status.json content must be a JSON object");
    }
  });

  test("oversized content string is skipped without parsing (write-path size guard)", () => {
    const { tree } = trees[0]!;
    expect(validateStatusWriteDoc("x".repeat(MAX_STATUS_CONTENT_LENGTH + 1), tree.status, "status")).toEqual([]);
  });

  test("default options keep BOTH oversized paths a silent pass (omp-parity regression)", () => {
    const { tree } = trees[0]!;
    const big = "x".repeat(MAX_STATUS_CONTENT_LENGTH + 1);
    expect(validateStatusWriteDoc(big, tree.status, "status", { oversized: "pass" })).toEqual([]);
    const onDisk = join(tree.harness, "workflows", "wf-big-pass", "snapshot.json");
    mkdirSync(join(onDisk, ".."), { recursive: true });
    writeFileSync(onDisk, big);
    try {
      expect(validateStatusWriteDoc(undefined, onDisk, "snapshot", { oversized: "pass" })).toEqual([]);
      expect(validateStatusWriteDoc(undefined, onDisk, "snapshot")).toEqual([]);
    } finally {
      rmSync(join(onDisk, ".."), { recursive: true, force: true });
    }
  });

  test("oversized: 'violate' yields status.oversized on both paths, O(1) before any parse", () => {
    const { tree } = trees[0]!;
    const big = "x".repeat(MAX_STATUS_CONTENT_LENGTH + 1);
    const contentViolations = validateStatusWriteDoc(big, tree.status, "status", { oversized: "violate" });
    expect(contentViolations).toHaveLength(1);
    expect(contentViolations[0]!.ok).toBe(false);
    expect(contentViolations[0]!.severity).toBe("high");
    expect(contentViolations[0]!.code).toBe("status.oversized");
    expect(contentViolations[0]!.message).toContain(String(MAX_STATUS_CONTENT_LENGTH));
    expect(contentViolations[0]!.message).toContain("MSTAR_WRITE_GATE=off");
    const onDisk = join(tree.harness, "workflows", "wf-big-violate", "snapshot.json");
    mkdirSync(join(onDisk, ".."), { recursive: true });
    writeFileSync(onDisk, big);
    try {
      const editViolations = validateStatusWriteDoc(undefined, onDisk, "snapshot", { oversized: "violate" });
      expect(editViolations).toHaveLength(1);
      expect(editViolations[0]!.code).toBe("status.oversized");
      expect(editViolations[0]!.message).toContain("MSTAR_WRITE_GATE=off");
    } finally {
      rmSync(join(onDisk, ".."), { recursive: true, force: true });
    }
  });

  test("edit path: valid on-disk doc -> no violations; nonexistent target -> fresh-scaffold pass", () => {
    const { tree } = trees[0]!;
    expect(validateStatusWriteDoc(undefined, tree.status, "status")).toEqual([]);
    expect(validateStatusWriteDoc(undefined, join(tree.harness, "workflows", "wf-absent", "snapshot.json"), "snapshot")).toEqual([]);
  });

  test("edit path: unparseable on-disk snapshot -> status.invalid-json with the readJson message", () => {
    const { tree } = trees[0]!;
    const bad = join(tree.harness, "workflows", "wf-bad", "snapshot.json");
    mkdirSync(join(bad, ".."), { recursive: true });
    writeFileSync(bad, "{ not json");
    try {
      const violations = validateStatusWriteDoc(undefined, bad, "snapshot");
      expect(violations).toHaveLength(1);
      expect(violations[0]!.code).toBe("status.invalid-json");
      expect(violations[0]!.message).toContain("Invalid JSON in");
    } finally {
      rmSync(join(bad, "..", ".."), { recursive: true, force: true });
    }
  });

  test("edit path: oversized on-disk gated doc is skipped (edit-path size guard)", () => {
    const { tree } = trees[0]!;
    const big = join(tree.harness, "workflows", "wf-big", "snapshot.json");
    mkdirSync(join(big, ".."), { recursive: true });
    writeFileSync(big, "x".repeat(MAX_STATUS_CONTENT_LENGTH + 1));
    try {
      expect(validateStatusWriteDoc(undefined, big, "snapshot")).toEqual([]);
    } finally {
      rmSync(join(big, ".."), { recursive: true, force: true });
    }
  });
});

describe("gates.violationLine / formatStatusWriteBlockReason", () => {
  const v1 = { ok: false as const, severity: "high" as const, code: "status.invalid-json", message: "JSON Parse error: Expected '}'" };
  const v2 = {
    ok: false as const,
    severity: "medium" as const,
    code: "workflow.snapshot.reserved-version",
    message: "reserved",
    fix: "remove the version key from the snapshot",
  };

  test("violationLine renders severity/code/message with optional fix", () => {
    expect(violationLine(v1)).toBe("[high] status.invalid-json: JSON Parse error: Expected '}'");
    expect(violationLine(v2)).toBe("[medium] workflow.snapshot.reserved-version: reserved (fix: remove the version key from the snapshot)");
  });

  test("formatStatusWriteBlockReason joins lines with the host skill pointer", () => {
    expect(formatStatusWriteBlockReason([v1, v2], "skill: mstar-artifacts/references/status-and-residuals.md")).toBe(
      [
        "[high] status.invalid-json: JSON Parse error: Expected '}' (skill: mstar-artifacts/references/status-and-residuals.md)",
        "[medium] workflow.snapshot.reserved-version: reserved (fix: remove the version key from the snapshot) (skill: mstar-artifacts/references/status-and-residuals.md)",
      ].join("\n"),
    );
  });
});
