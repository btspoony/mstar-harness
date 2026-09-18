/**
 * CLI `mstar issue` — subprocess tests against the built bundle (plan C4).
 *
 * Exercises Bun shebang launch and explicit Node invocation. Does not test
 * field forwarding or source strings.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { initializeStore } from "@mstar-harness/engine";

const CLI_ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(CLI_ROOT, "dist/mstar-harness.js");
const NODE_BIN = process.env.NODE_BIN ?? "node";
const NODE_VERSION = spawnSync(NODE_BIN, ["--version"], { encoding: "utf8" }).stdout.trim();
const BUN_VERSION = spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout.trim();


interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  argv: string[];
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runBundle(launcher: "bun-shebang" | "node", args: string[], cwd: string, extra: { nodeArgs?: string[] } = {}): RunResult {
  const argv = launcher === "node" ? [NODE_BIN, ...(extra.nodeArgs ?? []), BUNDLE, ...args] : [BUNDLE, ...args];
  const proc = spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    env: cliEnv(),
    encoding: "utf8",
  });
  return { exitCode: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", argv };
}

function jsonOf(result: RunResult): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`expected JSON stdout, got ${JSON.stringify(result.stdout)} (stderr: ${result.stderr})`);
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function capturePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: "proj-a",
    title: "Unscoped finding",
    kind: "bug",
    severity: "high",
    impact: "users see a failure",
    acceptance: "failure no longer reproduces",
    sourceIdentity: "qc/review.md",
    rootCauseKey: "missing-null-check",
    acceptanceKey: "null-guard-present",
    occurrenceKey: "run-1",
    sourceKind: "qc",
    location: "packages/engine/src/store-db.ts:10",
    observedBehavior: "throws on empty path",
    evidence: ["stack: TypeError"],
    discoveredAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

async function makeHarness(): Promise<{ root: string; harness: string }> {
  const root = mkdtempSync(join(tmpdir(), "mstar-issue-cli-"));
  roots.push(root);
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  await initializeStore({ harnessDir: harness }).then((h) => h.close());
  return { root, harness };
}

describe("mstar issue CLI bundle", () => {
  test("records Node 24.18.0 and Bun 1.4.0 for this suite", () => {
    // Evidence: subprocess launchers used below. Print so the report names them.
    console.log(`issue.test runtimes NODE_BIN=${NODE_BIN} node=${NODE_VERSION} bun=${BUN_VERSION}`);
    expect(NODE_VERSION).toBe("v24.18.0");
    expect(BUN_VERSION).toBe("1.4.0");
  });

  test("built bundle exists with bun shebang", () => {
    expect(existsSync(BUNDLE)).toBe(true);
    chmodSync(BUNDLE, 0o755);
    expect(readFileSync(BUNDLE, "utf8").startsWith("#!/usr/bin/env bun")).toBe(true);
  });

  test("unscoped capture with no plan, both launchers", async () => {
    for (const launcher of ["bun-shebang", "node"] as const) {
      const { root, harness } = await makeHarness();
      const file = join(root, "capture.json");
      writeJson(file, capturePayload());
      const result = runBundle(
        launcher,
        [
          "issue",
          "add",
          "--file",
          file,
          "--operation-id",
          "cap-1",
          "--actor",
          "project-manager",
          "--harness",
          harness,
          "--json",
        ],
        root,
      );
      const launched = result.argv[0];
      expect(launched === BUNDLE || launched === NODE_BIN || (typeof launched === "string" && launched.endsWith("node"))).toBe(true);
      expect(result.argv.join(" ")).not.toMatch(/sqlite-transport|bun:sqlite/i);
      expect(result.exitCode).toBe(0);
      const body = jsonOf(result);
      expect(body.ok).toBe(true);
      expect(typeof body.storeRevision).toBe("number");
      expect(body.data !== null && typeof body.data === "object" && "created" in body.data && body.data.created === true).toBe(true);
      expect(body.data !== null && typeof body.data === "object" && "issueId" in body.data && body.data.issueId === "I-000001").toBe(true);
    }
  });

  test("repeat occurrence appends on a distinct observation", async () => {
    const { root, harness } = await makeHarness();
    const first = join(root, "cap.json");
    writeJson(first, capturePayload());
    const add = runBundle("bun-shebang", [
      "issue",
      "add",
      "--file",
      first,
      "--operation-id",
      "cap-1",
      "--actor",
      "project-manager",
      "--harness",
      harness,
      "--json",
    ], root);
    expect(add.exitCode).toBe(0);
    const issueId = (jsonOf(add).data as { issueId: string }).issueId;
    const occ = join(root, "occ.json");
    writeJson(
      occ,
      capturePayload({
        occurrenceKey: "run-2",
        discoveredAt: "2026-09-18T11:00:00.000Z",
        observedBehavior: "still throws on empty path",
      }),
    );
    const second = runBundle("node", [
      "issue",
      "occurrence",
      issueId,
      "--file",
      occ,
      "--operation-id",
      "occ-2",
      "--actor",
      "project-manager",
      "--harness",
      harness,
      "--json",
    ], root);
    expect(second.exitCode).toBe(0);
    const shown = runBundle("bun-shebang", ["issue", "show", issueId, "--harness", harness, "--json"], root);
    expect(shown.exitCode).toBe(0);
    const detail = jsonOf(shown).data as { occurrences: unknown[] };
    expect(detail.occurrences).toHaveLength(2);
  });

  test("closure authorization and refusal", async () => {
    const { root, harness } = await makeHarness();
    const file = join(root, "cap.json");
    writeJson(file, capturePayload());
    const add = runBundle("node", [
      "issue",
      "add",
      "--file",
      file,
      "--operation-id",
      "cap-1",
      "--actor",
      "project-manager",
      "--harness",
      harness,
      "--json",
    ], root);
    const created = jsonOf(add).data as { issueId: string; revision: number };
    const evidence = join(root, "close.json");
    writeJson(evidence, { reason: "acceptance met", references: ["qa/run.md"] });
    const refused = runBundle("bun-shebang", [
      "issue",
      "close",
      created.issueId,
      "--file",
      evidence,
      "--expect",
      String(created.revision),
      "--operation-id",
      "close-leaf",
      "--actor",
      "fullstack-dev",
      "--harness",
      harness,
      "--json",
    ], root);
    expect(refused.exitCode).toBe(1);
    const refusal = jsonOf(refused);
    expect(refusal.ok).toBe(false);
    expect(refusal.code).toBe("issue.scope-refused");
    const ok = runBundle("node", [
      "issue",
      "close",
      created.issueId,
      "--file",
      evidence,
      "--expect",
      String(created.revision),
      "--operation-id",
      "close-pm",
      "--actor",
      "project-manager",
      "--harness",
      harness,
      "--json",
    ], root);
    expect(ok.exitCode).toBe(0);
    expect(jsonOf(ok).ok).toBe(true);
  });

  test("JSON exit behavior: success 0, domain 1, usage 2", async () => {
    const { root, harness } = await makeHarness();
    const missing = runBundle("bun-shebang", ["issue", "show", "I-999999", "--harness", harness, "--json"], root);
    expect(missing.exitCode).toBe(1);
    expect(jsonOf(missing).ok).toBe(false);
    const usage = runBundle("node", ["issue", "add", "--json", "--unknown-flag"], root);
    expect(usage.exitCode).toBe(2);
    expect(jsonOf(usage).ok).toBe(false);
    expect(jsonOf(usage).code).toBe("usage");
  });

  test("invalid enum and argument handling", async () => {
    const { root, harness } = await makeHarness();
    const listed = runBundle("bun-shebang", ["issue", "list", "--kind", "not-a-kind", "--harness", harness, "--json"], root);
    expect(listed.exitCode).toBe(2);
    expect(jsonOf(listed).code).toBe("usage");
    const add = runBundle("node", ["issue", "add", "--harness", harness, "--json", "--actor", "project-manager", "--operation-id", "x"], root);
    expect(add.exitCode).toBe(2);
    expect(jsonOf(add).code).toBe("usage");
  });

  test("below-floor Node refuses with actionable upgrade guidance", async () => {
    const { root, harness } = await makeHarness();
    const preload = join(root, "below-floor.mjs");
    writeFileSync(
      preload,
      `Object.defineProperty(process, "versions", { value: { ...process.versions, node: "18.20.0" } });\n`,
    );
    const result = runBundle(
      "node",
      ["issue", "list", "--harness", harness, "--json"],
      root,
      { nodeArgs: ["--import", `file://${preload}`] },
    );
    expect(result.exitCode).toBe(1);
    const body = jsonOf(result);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("store.runtime-unsupported");
    expect(String(body.message)).toMatch(/24\.18\.0/);
    expect(String(body.message)).toMatch(/nodejs\.org|upgrade/i);
  });

  test("malformed numeric list filters refuse as usage before store access", () => {
    const root = mkdtempSync(join(tmpdir(), "mstar-issue-limit-"));
    roots.push(root);
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    for (const args of [
      ["--limit", "1x"],
      ["--offset", "1x"],
      ["--limit", "0"],
    ] as const) {
      const result = runBundle("node", ["issue", "list", ...args, "--harness", harness, "--json"], root);
      expect(result.exitCode).toBe(2);
      expect(jsonOf(result).ok).toBe(false);
      expect(jsonOf(result).code).toBe("usage");
      expect(existsSync(join(harness, "store.db"))).toBe(false);
    }
  });

  test("wrong-typed optional triage field refuses usage and mutates nothing", async () => {
    const { root, harness } = await makeHarness();
    const file = join(root, "cap.json");
    writeJson(file, capturePayload());
    const add = runBundle("node", [
      "issue",
      "add",
      "--file",
      file,
      "--operation-id",
      "cap-1",
      "--actor",
      "project-manager",
      "--harness",
      harness,
      "--json",
    ], root);
    expect(add.exitCode).toBe(0);
    const created = jsonOf(add).data as { issueId: string; revision: number };
    const triageFile = join(root, "triage.json");
    writeJson(triageFile, { reason: "tighten severity", severity: 123 });
    const result = runBundle("node", [
      "issue",
      "triage",
      created.issueId,
      "--file",
      triageFile,
      "--expect",
      String(created.revision),
      "--operation-id",
      "triage-bad",
      "--actor",
      "project-manager",
      "--harness",
      harness,
      "--json",
    ], root);
    expect(result.exitCode).toBe(2);
    expect(jsonOf(result).code).toBe("usage");
    const shown = runBundle("node", ["issue", "show", created.issueId, "--harness", harness, "--json"], root);
    expect(shown.exitCode).toBe(0);
    expect((jsonOf(shown).data as { revision: number }).revision).toBe(created.revision);
  });

  test("missing native sqlite capability refuses with actionable guidance", async () => {
    const { root, harness } = await makeHarness();
    const preload = join(root, "no-sqlite.mjs");
    writeFileSync(
      preload,
      `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:sqlite") {
      return { shortCircuit: true, url: "data:text/javascript,export const DatabaseSync = undefined;" };
    }
    return nextResolve(specifier, context);
  },
});
`,
    );
    const result = runBundle(
      "node",
      ["issue", "list", "--harness", harness, "--json"],
      root,
      { nodeArgs: ["--import", `file://${preload}`] },
    );
    expect(result.exitCode).toBe(1);
    const body = jsonOf(result);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("store.runtime-unsupported");
    expect(String(body.message)).toMatch(/node:sqlite/);
    expect(String(body.message)).toMatch(/nodejs\.org|bun\.sh|upgrade/i);
  });


  test("unrelated --help does not open SQLite", () => {
    const root = mkdtempSync(join(tmpdir(), "mstar-issue-help-"));
    roots.push(root);
    for (const launcher of ["bun-shebang", "node"] as const) {
      const result = runBundle(launcher, ["path", "resolve", "--help"], root);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(root, "store.db"))).toBe(false);
      expect(existsSync(join(root, ".mstar", "store.db"))).toBe(false);
      expect(result.stdout + result.stderr).not.toMatch(/node:sqlite/);
    }
  });

  test("issue --help lists the frozen verb family without opening a store", () => {
    const root = mkdtempSync(join(tmpdir(), "mstar-issue-family-help-"));
    roots.push(root);
    const result = runBundle("bun-shebang", ["issue", "--help"], root);
    expect(result.exitCode).toBe(0);
    for (const verb of ["add", "list", "show", "occurrence", "triage", "close", "waive", "duplicate", "supersede", "link", "export"]) {
      expect(result.stdout).toContain(verb);
    }
    expect(existsSync(join(root, "store.db"))).toBe(false);
  });
});
