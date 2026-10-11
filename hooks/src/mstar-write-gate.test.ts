/**
 * hooks/src/mstar-write-gate.ts — synthetic stdin fixture matrix
 * (contract D3/D4/D5). Each case spawns the hook
 * ENTRY SOURCE with a synthetic PreToolUse envelope and pins the process
 * contract: exit 0 + EMPTY STDOUT on every pass path; exit 2 + stderr-only
 * reason on a hard-mode block. tmp-dir harness fixtures follow
 * packages/engine/src/gates.test.ts (default layout; `.mstarc`
 * `[config] enforcement=hard` for hard mode). The committed BUNDLE is
 * exercised under node separately (scripts/build-zcode-hooks.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "mstar-write-gate.ts");
const SKILL_POINTER = "(skill: mstar-artifacts/references/status-and-residuals.md)";
const ENFORCEMENT_LINE =
  "Enforcement: hard \u2014 this repo opts in via .mstarc/compass; disable for this session with MSTAR_WRITE_GATE=off.";

const VALID_STATUS = JSON.stringify({ version: 2, updated_at: "2026-09-08", workflows: [] });
const BAD_JSON = "{ not json";

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
  const fixture = buildHarness("wgate-hard-", "[config]\nenforcement=hard\n");
  fixtures.push(fixture);
  return fixture;
}

function softRepo(): Fixture {
  const fixture = buildHarness("wgate-soft-");
  fixtures.push(fixture);
  return fixture;
}

function plainRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "wgate-plain-"));
  fixtures.push({ root, harness: join(root, ".mstar") });
  return root;
}

interface RunOptions {
  env?: Record<string, string>;
}

function runGate(payload: unknown, options: RunOptions = {}): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const env = { ...process.env };
  delete env.MSTAR_WRITE_GATE;
  delete env.MSTAR_HARNESS_DIR;
  Object.assign(env, options.env);
  const proc = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env,
    encoding: "utf8",
  });
  return { exitCode: proc.status ?? -1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

function writeEvent(toolInput: Record<string, unknown>, cwd?: string): unknown {
  return cwd === undefined ? { tool_name: "Write", tool_input: toolInput } : { tool_name: "Write", tool_input: toolInput, cwd };
}

describe("write gate - hard-mode blocks (exit 2 + stderr, stdout empty)", () => {
  test("Write with file_path + invalid JSON content blocks with the contract stderr shape", () => {
    const { root } = hardRepo();
    const run = runGate(writeEvent({ file_path: join(root, ".mstar", "status.json"), content: BAD_JSON }));
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    const lines = run.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("[Morning Star write gate] blocked Write to status.json");
    expect(lines[1]!.startsWith("[high] status.invalid-json: ")).toBe(true);
    expect(lines[1]!.endsWith(SKILL_POINTER)).toBe(true);
    expect(lines[2]).toBe(ENFORCEMENT_LINE);
  });

  test("Edit via the path key validates the on-disk file (edit path) and blocks", () => {
    const { harness } = hardRepo();
    const bad = join(harness, "workflows", "wf-bad", "snapshot.json");
    mkdirSync(join(bad, ".."), { recursive: true });
    writeFileSync(bad, BAD_JSON);
    const run = runGate({ tool_name: "Edit", tool_input: { path: bad } });
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    const lines = run.stderr.trimEnd().split("\n");
    expect(lines[0]).toBe("[Morning Star write gate] blocked Edit to workflows/wf-bad/snapshot.json");
    expect(lines[1]!.startsWith("[high] status.invalid-json: ")).toBe(true);
  });

  test("paths[] union: the gated entry blocks even next to non-gated ones", () => {
    const { root } = hardRepo();
    const run = runGate(
      writeEvent({
        paths: [join(root, "README.md"), join(root, ".mstar", "status.json")],
        content: BAD_JSON,
      }),
    );
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("blocked Write to status.json");
  });

  test("relative file_path resolves against input.cwd and blocks", () => {
    const { root } = hardRepo();
    const run = runGate(writeEvent({ file_path: ".mstar/status.json", content: BAD_JSON }, root));
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("blocked Write to status.json");
  });

  test("engine violation literals with multibyte characters render intact (no mojibake)", () => {
    const { root } = hardRepo();
    // `version` on a snapshot trips workflow.snapshot.reserved-version whose
    // engine message literal carries an em-dash (\u2014 in engine src).
    const run = runGate(
      writeEvent({
        file_path: join(root, ".mstar", "workflows", "wf-x", "snapshot.json"),
        content: JSON.stringify({ schema_version: 1, id: "wf-x", type: "plan", status: "running", started_at: "2026-09-08", updated_at: "2026-09-08", plans: [], version: 2 }),
      }),
    );
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("\u2014");
    expect(run.stderr).not.toContain("\u00e2"); // latin-1 mojibake marker
  });

  test("a chained symlink alias landing on the authority database blocks (issue #442)", () => {
    const { root } = hardRepo();
    const inner = join(root, "chain-inner");
    const outer = join(root, "chain-outer");
    symlinkSync(join(root, ".mstar", "store.db-wal"), inner);
    symlinkSync("chain-inner", outer);
    const run = runGate(writeEvent({ file_path: outer, content: "x" }));
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("[high] store.direct-write-refused:");
  });

  test("a cyclic symlink target refuses fail-closed instead of passing", () => {
    const { root } = hardRepo();
    symlinkSync("cycle-b", join(root, "cycle-a"));
    symlinkSync("cycle-a", join(root, "cycle-b"));
    const run = runGate(writeEvent({ file_path: join(root, "cycle-a"), content: "x" }));
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("[high] write.symlink-resolution-refused:");
  });
});

describe("write gate - silent passes (exit 0, no output)", () => {
  test("MSTAR_WRITE_GATE=off is checked FIRST: a would-block hard write passes", () => {
    const { root } = hardRepo();
    const run = runGate(writeEvent({ file_path: join(root, ".mstar", "status.json"), content: BAD_JSON }), {
      env: { MSTAR_WRITE_GATE: "off" },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("soft-mode violation is a silent pass (omp Gate-1 parity)", () => {
    const { root } = softRepo();
    const run = runGate(writeEvent({ file_path: join(root, ".mstar", "status.json"), content: BAD_JSON }));
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("non-harness repo: never blocks", () => {
    const root = plainRepo();
    const run = runGate(writeEvent({ file_path: join(root, ".mstar", "status.json"), content: BAD_JSON }));
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("relative file_path without cwd resolves against the hook process cwd (ungated here)", () => {
    hardRepo(); // fixture existence must not matter — cwd points at the worktree, not the fixture
    const run = runGate(writeEvent({ file_path: ".mstar/status.json", content: BAD_JSON }));
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("missing tool_input", () => {
    hardRepo();
    const run = runGate({ tool_name: "Write" });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("non-object tool_input", () => {
    hardRepo();
    const run = runGate({ tool_name: "Write", tool_input: "str" });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("non-JSON stdin", () => {
    hardRepo();
    const run = runGate("not json at all {{{");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("unknown tool_name", () => {
    const { root } = hardRepo();
    const run = runGate({ tool_name: "Note", tool_input: { file_path: join(root, ".mstar", "status.json"), content: BAD_JSON } });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("path values that are empty or non-string never manufacture targets", () => {
    const { root } = hardRepo();
    const run = runGate(
      writeEvent({
        file_path: "",
        path: 42,
        paths: ["   ", null, join(root, ".mstar", "status.json"), 7],
        content: BAD_JSON,
      }),
    );
    // The one real path in the union is gated and blocks — proving the
    // junk entries were tolerated without disabling the gate.
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
  });

  test("fresh-scaffold write (no content key, nonexistent target) passes", () => {
    const { root } = hardRepo();
    const run = runGate(writeEvent({ file_path: join(root, ".mstar", "status.json") }));
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("valid coordination-doc content passes", () => {
    const { root } = hardRepo();
    const run = runGate(writeEvent({ file_path: join(root, ".mstar", "status.json"), content: VALID_STATUS }));
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });
});

describe("write gate - deterministic edit reconstruction (post-edit validation)", () => {
  test("deterministic edit validates the RECONSTRUCTED result (pre-edit invalid -> pass)", () => {
    const { root, harness } = hardRepo();
    writeFileSync(join(harness, "status.json"), "not json at all"); // pre-edit invalid
    const run = runGate({
      tool_name: "Edit",
      tool_input: {
        file_path: join(root, ".mstar", "status.json"),
        old_string: "not json at all",
        new_string: VALID_STATUS, // unique match; reconstruction is valid
      },
    });
    expect(run.exitCode).toBe(0); // pass PROVES post-edit validation (pre-edit fallback would block)
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("replace_all reconstruction validates the joined result (pre-edit invalid -> pass)", () => {
    const { root, harness } = hardRepo();
    writeFileSync(join(harness, "status.json"), `//${VALID_STATUS}//`); // pre-edit invalid; `//` occurs twice
    const run = runGate({
      tool_name: "Edit",
      tool_input: {
        file_path: join(root, ".mstar", "status.json"),
        old_string: "//",
        new_string: " ", // whitespace-padded JSON parses fine
        replace_all: true,
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("deterministic-but-invalid reconstruction blocks under hard (exit 2)", () => {
    const { root } = hardRepo();
    const run = runGate({
      tool_name: "Edit",
      tool_input: {
        file_path: join(root, ".mstar", "status.json"),
        old_string: '"workflows":[]', // unique match in the valid on-disk doc
        new_string: '"workflows"', // reconstruction is broken JSON
      },
    });
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("[high] status.invalid-json:");
  });

  test("ambiguous match without replace_all falls back to the PRE-edit state (valid -> pass)", () => {
    const { root } = hardRepo();
    // `"` occurs 8 times in the valid doc; a (wrongly) validated
    // reconstruction would be broken JSON and block — the pass proves the
    // pre-edit fallback ran.
    const run = runGate({
      tool_name: "Edit",
      tool_input: { file_path: join(root, ".mstar", "status.json"), old_string: '"', new_string: "x" },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("ambiguous match on an already-invalid doc blocks via the pre-edit fallback", () => {
    const { root, harness } = hardRepo();
    writeFileSync(join(harness, "status.json"), "{ not json"); // pre-edit invalid
    const run = runGate({
      tool_name: "Edit",
      tool_input: { file_path: join(root, ".mstar", "status.json"), old_string: "not", new_string: "fixed" },
    });
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("[high] status.invalid-json:");
  });

  test("reconstruction error (nonexistent target) falls back to the fresh-scaffold pass", () => {
    const { root } = hardRepo();
    const run = runGate({
      tool_name: "Edit",
      tool_input: {
        file_path: join(root, ".mstar", "status.json"),
        old_string: "anything",
        new_string: "else",
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });
});

describe("write gate - oversized violation (ZCode-host divergence, Amendment B)", () => {
  const OVERSIZED = "x".repeat(2 * 1024 * 1024 + 1);

  test("oversized content in a hard repo blocks with status.oversized naming the escape hatch", () => {
    const { root } = hardRepo();
    const run = runGate(writeEvent({ file_path: join(root, ".mstar", "status.json"), content: OVERSIZED }));
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    const lines = run.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]!.startsWith("[high] status.oversized: ")).toBe(true);
    expect(lines[1]).toContain("MSTAR_WRITE_GATE=off");
    expect(lines[2]).toBe(ENFORCEMENT_LINE);
  });

  test("oversized content in a soft repo stays a silent pass", () => {
    const { root } = softRepo();
    const run = runGate(writeEvent({ file_path: join(root, ".mstar", "status.json"), content: OVERSIZED }));
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("oversized on-disk gated target (edit path) violates", () => {
    const { root, harness } = hardRepo();
    writeFileSync(join(harness, "status.json"), OVERSIZED);
    const run = runGate({ tool_name: "Edit", tool_input: { path: join(root, ".mstar", "status.json") } });
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("[high] status.oversized:");
    expect(run.stderr).toContain("MSTAR_WRITE_GATE=off");
  });

  test("oversized on-disk target skips reconstruction (bounded fallback) and still violates", () => {
    const { root, harness } = hardRepo();
    writeFileSync(join(harness, "status.json"), OVERSIZED);
    const run = runGate({
      tool_name: "Edit",
      tool_input: {
        file_path: join(root, ".mstar", "status.json"),
        old_string: "xxx",
        new_string: "yyy",
        replace_all: true, // deterministic shape, but the stat guard bounds the read first
      },
    });
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("[high] status.oversized:");
  });
});

describe("write gate - hardening (header injection + target cap)", () => {
  test("control characters in the target path cannot break the stderr header; block still fires", () => {
    const { harness } = hardRepo();
    // The engine's canonical `[^/]+` rel patterns admit control chars — a
    // workflow dir literally named with a newline plus a forged violation
    //-looking line must render hex-escaped on a single header line.
    const forged = join(harness, "workflows", "wf\n[high] forged: ok", "snapshot.json");
    mkdirSync(join(forged, ".."), { recursive: true });
    writeFileSync(forged, BAD_JSON);
    const run = runGate(writeEvent({ file_path: forged, content: BAD_JSON }));
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    const lines = run.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(3); // header stays ONE line
    expect(lines[0]).toBe("[Morning Star write gate] blocked Write to workflows/wf\\x0a[high] forged: ok/snapshot.json");
    expect(lines[1]!.startsWith("[high] status.invalid-json: ")).toBe(true);
    expect(lines[2]).toBe(ENFORCEMENT_LINE);
  });

  test("gated target in the last in-cap slot still blocks (cap boundary)", () => {
    const { root } = hardRepo();
    const paths: string[] = [];
    for (let i = 0; i < 31; i++) paths.push(join(root, "ungated", `f${i}.txt`));
    paths.push(join(root, ".mstar", "status.json")); // index 31 — within the 32 cap
    const run = runGate(writeEvent({ paths, content: BAD_JSON }));
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
  });

  test("gated target beyond the 32-target cap skips gating silently (fail-open)", () => {
    const { root } = hardRepo();
    const paths: string[] = [];
    for (let i = 0; i < 32; i++) paths.push(join(root, "ungated", `f${i}.txt`));
    paths.push(join(root, ".mstar", "status.json")); // index 32 — first beyond the cap
    const run = runGate(writeEvent({ paths, content: BAD_JSON }));
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });
});

describe("write gate - fixture hygiene", () => {
  test("tmp fixtures are removed", () => {
    for (const fixture of fixtures) rmSync(fixture.root, { recursive: true, force: true });
    expect(fixtures.length).toBeGreaterThan(0);
  });
});
