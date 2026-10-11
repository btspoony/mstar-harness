/**
 * scripts/build-zcode-hooks.ts — build + bundle smoke (cross-host hooks
 * contract D2, knowledge doc
 * bun-bundle-ascii-literals two-layer guard). Pins:
 * - the committed `hooks/mstar-write-gate.mjs` rebuilds BYTE-IDENTICALLY
 *   (the CI freshness gate diffs the working tree; determinism is
 *   load-bearing);
 * - the artifact carries the `@generated` banner and INLINES the engine:
 *   no bare `@mstar-harness/engine` import survives (omp bundle-smoke
 *   precedent) and engine symbols are present;
 * - RENDERED assertion of the BUILT artifact under node: a hard-mode block
 *   whose violation message carries a multibyte engine literal renders the
 *   character intact (em-dash present, no latin-1 mojibake `a-tilde`),
 *   exit 2, stdout empty — and pass paths stay fully silent. The hook
 *   executes under node (safe per the isolation matrix), so this is
 *   belt-and-braces for the bun-bundle misdecode bug class plus protection
 *   for any future host that runs the bundle under bun.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENERATED_BANNER, HOOK_ENTRIES, buildZcodeHooks } from "./build-zcode-hooks.ts";

const OUTFILE = join(import.meta.dir, "..", HOOK_ENTRIES[0].outfile);
const SESSION_CONTEXT_OUTFILE = join(import.meta.dir, "..", HOOK_ENTRIES[1].outfile);
const SKILL_POINTER = "(skill: mstar-artifacts/references/status-and-residuals.md)";

const BAD_JSON = "{ not json";
const VALID_STATUS = JSON.stringify({ version: 2, updated_at: "2026-09-08", workflows: [] });

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface Fixture {
  root: string;
  harness: string;
}

function buildHarness(id: string, mstarc?: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${id}-`));
  const harness = join(root, ".mstar");
  mkdirSync(join(harness, "workflows"), { recursive: true });
  mkdirSync(join(harness, "projects"), { recursive: true });
  writeFileSync(join(harness, "status.json"), VALID_STATUS);
  if (mstarc) writeFileSync(join(root, ".mstarc"), mstarc);
  return { root, harness };
}

const fixtures: Fixture[] = [];

function hardRepo(): Fixture {
  const fixture = buildHarness("bgate-hard-", "[config]\nenforcement=hard\n");
  fixtures.push(fixture);
  return fixture;
}

function plainRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "bgate-plain-"));
  fixtures.push({ root, harness: join(root, ".mstar") });
  return root;
}

/** Run the BUILT artifact under node (the host's hook command) with a
 * synthetic stdin envelope; scrub harness-affecting env vars. */
function nodeRunGate(payload: unknown, env: Record<string, string> = {}): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const merged = { ...process.env };
  delete merged.MSTAR_WRITE_GATE;
  delete merged.MSTAR_HARNESS_DIR;
  Object.assign(merged, env);
  const proc = spawnSync("node", [OUTFILE], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: merged,
    encoding: "utf8",
  });
  return { exitCode: proc.status ?? -1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

let firstHashes: string[] = [];

beforeAll(async () => {
  await buildZcodeHooks();
  firstHashes = [OUTFILE, SESSION_CONTEXT_OUTFILE].map(sha256);
});

describe("build-zcode-hooks — committed artifacts", () => {
  test("rebuild is byte-identical for both artifacts", async () => {
    await buildZcodeHooks();
    expect([OUTFILE, SESSION_CONTEXT_OUTFILE].map(sha256)).toEqual(firstHashes);
  });

  test("artifacts carry generated banners naming their sources", () => {
    for (const { entry, outfile } of HOOK_ENTRIES) {
      const bundle = readFileSync(join(import.meta.dir, "..", outfile), "utf8");
      expect(bundle.startsWith(GENERATED_BANNER(entry))).toBe(true);
      expect(bundle).toContain(entry);
    }
  });

  test("session-context bundles the engine without a bare import", () => {
    const bundle = readFileSync(SESSION_CONTEXT_OUTFILE, "utf8");
    expect(bundle).not.toMatch(/from\s*["']@mstar-harness\/engine["']/);
    expect(bundle).not.toMatch(/require\(["']@mstar-harness\/engine["']\)/);
    expect(bundle).not.toMatch(/import\(["']@mstar-harness\/engine["']\)/);
    expect(bundle).toContain("readExecutionAuthority");
  });

  test("engine is inlined: no bare @mstar-harness/engine import survives (omp precedent)", () => {
    const bundle = readFileSync(OUTFILE, "utf8");
    expect(bundle).not.toMatch(/from\s*["']@mstar-harness\/engine["']/);
    expect(bundle).not.toMatch(/require\(["']@mstar-harness\/engine["']\)/);
    expect(bundle).not.toMatch(/import\(["']@mstar-harness\/engine["']\)/);
    expect(bundle).toContain("harnessDocKindOfTarget");
    expect(bundle).toContain("status.invalid-json");
  });
});

describe("build-zcode-hooks — node-run rendered smoke of the BUILT artifact", () => {
  test("hard-mode block: exit 2, stdout empty, contract stderr shape, multibyte literal intact", () => {
    const { root } = hardRepo();
    // `version` on a snapshot trips workflow.snapshot.reserved-version whose
    // engine message literal carries an em-dash (\u2014 in engine src,
    // re-normalized to raw UTF-8 bytes by bun build) — the rendered
    // assertion that actually exercises the bundle misdecode class.
    const run = nodeRunGate({
      tool_name: "Write",
      tool_input: {
        file_path: join(root, ".mstar", "workflows", "wf-x", "snapshot.json"),
        content: JSON.stringify({ schema_version: 1, id: "wf-x", type: "plan", status: "running", started_at: "2026-09-08", updated_at: "2026-09-08", plans: [], version: 2 }),
      },
    });
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    const lines = run.stderr.trimEnd().split("\n");
    expect(lines[0]).toBe("[Morning Star write gate] blocked Write to workflows/wf-x/snapshot.json");
    expect(lines.some((line) => line.startsWith("[medium] workflow.snapshot.reserved-version: ") && line.endsWith(SKILL_POINTER))).toBe(true);
    expect(run.stderr).toContain("\u2014");
    expect(run.stderr).not.toContain("\u00e2"); // latin-1 mojibake marker
  });

  test("invalid-JSON status write blocks through the built bundle", () => {
    const { root } = hardRepo();
    const run = nodeRunGate({
      tool_name: "Write",
      tool_input: { file_path: join(root, ".mstar", "status.json"), content: BAD_JSON },
    });
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    const lines = run.stderr.trimEnd().split("\n");
    expect(lines[0]).toBe("[Morning Star write gate] blocked Write to status.json");
    expect(lines[1]!.startsWith("[high] status.invalid-json: ")).toBe(true);
  });

  test("non-harness write passes silently (exit 0, both streams empty)", () => {
    const root = plainRepo();
    const run = nodeRunGate({
      tool_name: "Write",
      tool_input: { file_path: join(root, ".mstar", "status.json"), content: BAD_JSON },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("MSTAR_WRITE_GATE=off passes a would-block hard write through the built bundle", () => {
    const { root } = hardRepo();
    const run = nodeRunGate(
      { tool_name: "Write", tool_input: { file_path: join(root, ".mstar", "status.json"), content: BAD_JSON } },
      { MSTAR_WRITE_GATE: "off" },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });
});

describe("build-zcode-hooks — fixture hygiene", () => {
  test("tmp fixtures are removed", () => {
    for (const fixture of fixtures) rmSync(fixture.root, { recursive: true, force: true });
    expect(fixtures.length).toBeGreaterThan(0);
  });
});
