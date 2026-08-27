/**
 * CLI `mstar persist` / `persist get` — ArtifactStore persist port (plan
 * 20260827-artifact-store Task 4 Part A; iteration spec `artifact-store`
 * SP2-AC4..AC8).
 *
 * Each case spawns the real CLI entry as a subprocess. The default FsStore
 * is pinned to a temp harness via `MSTAR_HARNESS_DIR` (the store resolves
 * the harness dir from env ahead of cwd probing — the same resolution the
 * writers use, so the round-trip asserts real file placement). The
 * `--store` / `MSTAR_STORE_MODULE` path loads a self-contained temp module
 * (no engine import — the loader accepts a plain factory).
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn env with ambient harness env vars pinned out (qc3 F-4 convention):
 * dir resolution must never leak into fixtures. MSTAR_STORE_MODULE is
 * pinned too so an ambient module cannot redirect a fixture. */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key === "MSTAR_HARNESS_DIR" ||
      key === "MSTAR_CONTROL_ROOT" ||
      key === "SDD_DIR" ||
      key === "MSTAR_STORE_MODULE"
    ) {
      continue;
    }
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Run the real CLI entry as a subprocess; cwd + env overrides. */
function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: opts.cwd ?? CLI_ROOT,
    env: { ...cliEnv(), ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** Run the real CLI entry with piped stdin (Bun.spawnSync `input` does not
 * reach the child's fd 0 — use node's execFileSync, which does). */
function runCliWithInput(args: string[], opts: { env?: Record<string, string>; input: string }): RunResult {
  try {
    const stdout = execFileSync(process.execPath, ["run", SRC_ENTRY, ...args], {
      cwd: CLI_ROOT,
      env: { ...cliEnv(), ...opts.env },
      input: opts.input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      exitCode: err.status ?? 1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? ""),
    };
  }
}

/** Temp dir per test, cleaned up after. */
function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mstar-persist-cli-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write `payload` as a JSON file under `dir` and return its path. */
function writePayload(dir: string, name: string, payload: unknown): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(payload), "utf8");
  return file;
}

/** Env pinning the default FsStore to `dir`. */
function harnessEnv(dir: string): Record<string, string> {
  return { MSTAR_HARNESS_DIR: dir };
}

/** Valid payloads (each passes the kind's existing validator). */
const STATUS_PAYLOAD = { version: 2, updated_at: "2026-08-27", workflows: [] };
const SNAPSHOT_PAYLOAD = {
  schema_version: 1,
  id: "wf-1",
  type: "plan",
  status: "running",
  started_at: "2026-08-27T00:00:00.000Z",
  updated_at: "2026-08-27",
  plans: [],
};
const RESIDUALS_PAYLOAD = { entries: {} };
const REVIEW_PAYLOAD = { verdict: "approve" };

/** Self-contained store module (plain factory — no engine import): put/get
 * over a single JSON file whose path comes from `envVar`. */
function storeModuleSource(envVar: string): string {
  return [
    'import { writeFileSync, readFileSync, existsSync } from "node:fs";',
    `const file = process.env.${envVar};`,
    `if (!file) throw new Error("${envVar} is required");`,
    "export function createArtifactStore() {",
    "  return {",
    "    async put(doc) { writeFileSync(file, JSON.stringify({ key: doc.key, payload: doc.payload })); },",
    "    async get(ref) {",
    "      if (!existsSync(file)) return undefined;",
    '      const stored = JSON.parse(readFileSync(file, "utf8"));',
    "      return stored.key === ref.key ? stored.payload : undefined;",
    "    },",
    "  };",
    "}",
  ].join("\n");
}

describe("mstar persist — FsStore round-trip in a temp harness dir (MSTAR_HARNESS_DIR)", () => {
  test("snapshot put then get round-trips (SP2-AC4)", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "snapshot.json", SNAPSHOT_PAYLOAD);
      const put = runCli(["persist", "snapshot", "--key", "wf-1", "--file", payloadFile], { env: harnessEnv(dir) });
      expect(put.exitCode).toBe(0);
      expect(put.stdout).toContain("persist snapshot/wf-1: OK");
      expect(existsSync(join(dir, "workflows", "wf-1", "snapshot.json"))).toBe(true);

      const get = runCli(["persist", "get", "snapshot", "--key", "wf-1"], { env: harnessEnv(dir) });
      expect(get.exitCode).toBe(0);
      expect(JSON.parse(get.stdout)).toEqual(SNAPSHOT_PAYLOAD);
    });
  });

  test("status put then get round-trips at {HARNESS_DIR}/status.json (key root)", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "status.json", STATUS_PAYLOAD);
      const put = runCli(["persist", "status", "--key", "root", "--file", payloadFile], { env: harnessEnv(dir) });
      expect(put.exitCode).toBe(0);
      expect(existsSync(join(dir, "status.json"))).toBe(true);

      const get = runCli(["persist", "get", "status", "--key", "root"], { env: harnessEnv(dir) });
      expect(get.exitCode).toBe(0);
      expect(JSON.parse(get.stdout)).toEqual(STATUS_PAYLOAD);
    });
  });

  test("residuals put then get round-trips at {PROJECT_DIR}/<key>/residuals.json", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "residuals.json", RESIDUALS_PAYLOAD);
      const put = runCli(["persist", "residuals", "--key", "proj-1", "--file", payloadFile], { env: harnessEnv(dir) });
      expect(put.exitCode).toBe(0);
      expect(existsSync(join(dir, "projects", "proj-1", "residuals.json"))).toBe(true);

      const get = runCli(["persist", "get", "residuals", "--key", "proj-1"], { env: harnessEnv(dir) });
      expect(get.exitCode).toBe(0);
      expect(JSON.parse(get.stdout)).toEqual(RESIDUALS_PAYLOAD);
    });
  });

  test("review round-trips for a plan-shaped key (sdd/<key>/review/report.json) and an other key (sdd/_reviews/)", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "review.json", REVIEW_PAYLOAD);
      const planShaped = runCli(
        ["persist", "review", "--key", "20260827-artifact-store", "--file", payloadFile],
        { env: harnessEnv(dir) },
      );
      expect(planShaped.exitCode).toBe(0);
      expect(existsSync(join(dir, "sdd", "20260827-artifact-store", "review", "report.json"))).toBe(true);

      const otherKey = runCli(["persist", "review", "--key", "review-abc", "--file", payloadFile], {
        env: harnessEnv(dir),
      });
      expect(otherKey.exitCode).toBe(0);
      expect(existsSync(join(dir, "sdd", "_reviews", "review-abc.json"))).toBe(true);

      const get = runCli(["persist", "get", "review", "--key", "20260827-artifact-store"], { env: harnessEnv(dir) });
      expect(get.exitCode).toBe(0);
      expect(JSON.parse(get.stdout)).toEqual(REVIEW_PAYLOAD);
    });
  });

  test("json kind persists to the absolute key path (SP2-AC8 positive)", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "payload.json", { hello: "world" });
      const target = join(dir, "custom", "payload.json");
      const put = runCli(["persist", "json", "--key", target, "--file", payloadFile], { env: harnessEnv(dir) });
      expect(put.exitCode).toBe(0);
      expect(existsSync(target)).toBe(true);

      const get = runCli(["persist", "get", "json", "--key", target], { env: harnessEnv(dir) });
      expect(get.exitCode).toBe(0);
      expect(JSON.parse(get.stdout)).toEqual({ hello: "world" });
    });
  });

  test("json kind with a non-absolute key is rejected (SP2-AC8)", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "payload.json", { hello: "world" });
      const r = runCli(["persist", "json", "--key", "relative/path.json", "--file", payloadFile], {
        env: harnessEnv(dir),
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("absolute path");
    });
  });
});

describe("mstar persist — validators run before put (SP2-AC5)", () => {
  test("status validator rejects a v1 document (exit 1, no write)", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "v1.json", { version: 1, plans: [] });
      const r = runCli(["persist", "status", "--key", "root", "--file", payloadFile], { env: harnessEnv(dir) });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("refusing to persist invalid status document");
      expect(existsSync(join(dir, "status.json"))).toBe(false);
    });
  });

  test("snapshot validator rejects a doc missing schema_version (exit 1, no write)", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "bad-snapshot.json", { id: "wf-1", plans: [] });
      const r = runCli(["persist", "snapshot", "--key", "wf-1", "--file", payloadFile], { env: harnessEnv(dir) });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("refusing to persist invalid snapshot document");
      expect(existsSync(join(dir, "workflows", "wf-1", "snapshot.json"))).toBe(false);
    });
  });

  test("residuals validator rejects a non-register document (exit 1, no write)", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "bad-residuals.json", { nope: 1 });
      const r = runCli(["persist", "residuals", "--key", "proj-1", "--file", payloadFile], { env: harnessEnv(dir) });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("refusing to persist invalid residuals document");
      expect(existsSync(join(dir, "projects", "proj-1", "residuals.json"))).toBe(false);
    });
  });

  test("invalid JSON payload is rejected (exit 1)", () => {
    withTempDir((dir) => {
      const payloadFile = join(dir, "bad.json");
      writeFileSync(payloadFile, "{ not json", "utf8");
      const r = runCli(["persist", "json", "--key", join(dir, "out.json"), "--file", payloadFile], {
        env: harnessEnv(dir),
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("not valid JSON");
    });
  });
});

describe("mstar persist — usage errors", () => {
  test("unknown kind → usage, exit 2", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "payload.json", { a: 1 });
      const put = runCli(["persist", "bogus", "--key", "k", "--file", payloadFile], { env: harnessEnv(dir) });
      expect(put.exitCode).toBe(2);
      expect(put.stderr).toContain("unknown kind \"bogus\"");
      expect(put.stderr).toContain("status | snapshot | residuals | review | json");

      const get = runCli(["persist", "get", "bogus", "--key", "k"], { env: harnessEnv(dir) });
      expect(get.exitCode).toBe(2);
      expect(get.stderr).toContain("unknown kind \"bogus\"");
    });
  });

  test("--file and --stdin together → usage, exit 2", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "payload.json", { a: 1 });
      const r = runCli(["persist", "snapshot", "--key", "k", "--file", payloadFile, "--stdin"], {
        env: harnessEnv(dir),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("mutually exclusive");
    });
  });

  test("missing payload file → exit 1", () => {
    withTempDir((dir) => {
      const r = runCli(["persist", "snapshot", "--key", "k", "--file", join(dir, "no-such.json")], {
        env: harnessEnv(dir),
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("payload file not found");
    });
  });
});

describe("mstar persist get — absent document", () => {
  test("missing key → exit 1 with a message (no stored document)", () => {
    withTempDir((dir) => {
      const r = runCli(["persist", "get", "snapshot", "--key", "no-such-wf"], { env: harnessEnv(dir) });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("no stored document");
    });
  });
});

describe("mstar persist — --stdin and default-stdin payloads", () => {
  test("--stdin reads the payload from stdin", () => {
    withTempDir((dir) => {
      const put = runCliWithInput(["persist", "snapshot", "--key", "wf-stdin", "--stdin"], {
        env: harnessEnv(dir),
        input: JSON.stringify(SNAPSHOT_PAYLOAD),
      });
      expect(put.exitCode).toBe(0);
      expect(existsSync(join(dir, "workflows", "wf-stdin", "snapshot.json"))).toBe(true);

      const get = runCli(["persist", "get", "snapshot", "--key", "wf-stdin"], { env: harnessEnv(dir) });
      expect(get.exitCode).toBe(0);
      expect(JSON.parse(get.stdout)).toEqual(SNAPSHOT_PAYLOAD);
    });
  });

  test("no --file / --stdin flag defaults to stdin", () => {
    withTempDir((dir) => {
      const put = runCliWithInput(["persist", "snapshot", "--key", "wf-default"], {
        env: harnessEnv(dir),
        input: JSON.stringify(SNAPSHOT_PAYLOAD),
      });
      expect(put.exitCode).toBe(0);
      expect(existsSync(join(dir, "workflows", "wf-default", "snapshot.json"))).toBe(true);
    });
  });
});

describe("mstar persist — --store / MSTAR_STORE_MODULE module injection (SP2-AC6 / AC7)", () => {
  test("--store loads the module and routes the put through it", () => {
    withTempDir((dir) => {
      const moduleFile = join(dir, "store-mod.ts");
      writeFileSync(moduleFile, storeModuleSource("PERSIST_MODULE_FILE"), "utf8");
      const outFile = join(dir, "module-out.json");
      const payloadFile = writePayload(dir, "snapshot.json", SNAPSHOT_PAYLOAD);

      const put = runCli(["persist", "snapshot", "--key", "mod-1", "--file", payloadFile, "--store", moduleFile], {
        env: { PERSIST_MODULE_FILE: outFile },
      });
      expect(put.exitCode).toBe(0);
      // The put went through the module (module-out.json), not the FsStore.
      expect(existsSync(outFile)).toBe(true);
      expect(JSON.parse(readFileSync(outFile, "utf8"))).toEqual({ key: "mod-1", payload: SNAPSHOT_PAYLOAD });

      const get = runCli(["persist", "get", "snapshot", "--key", "mod-1", "--store", moduleFile], {
        env: { PERSIST_MODULE_FILE: outFile },
      });
      expect(get.exitCode).toBe(0);
      expect(JSON.parse(get.stdout)).toEqual(SNAPSHOT_PAYLOAD);
    });
  });

  test("MSTAR_STORE_MODULE env loads the module when --store is absent", () => {
    withTempDir((dir) => {
      const moduleFile = join(dir, "store-mod.ts");
      writeFileSync(moduleFile, storeModuleSource("PERSIST_MODULE_FILE"), "utf8");
      const outFile = join(dir, "module-out.json");
      const payloadFile = writePayload(dir, "snapshot.json", SNAPSHOT_PAYLOAD);

      const put = runCli(["persist", "snapshot", "--key", "mod-env", "--file", payloadFile], {
        env: { MSTAR_STORE_MODULE: moduleFile, PERSIST_MODULE_FILE: outFile },
      });
      expect(put.exitCode).toBe(0);
      expect(existsSync(outFile)).toBe(true);

      const get = runCli(["persist", "get", "snapshot", "--key", "mod-env"], {
        env: { MSTAR_STORE_MODULE: moduleFile, PERSIST_MODULE_FILE: outFile },
      });
      expect(get.exitCode).toBe(0);
      expect(JSON.parse(get.stdout)).toEqual(SNAPSHOT_PAYLOAD);
    });
  });

  test("--store overrides MSTAR_STORE_MODULE for that command", () => {
    withTempDir((dir) => {
      const moduleA = join(dir, "store-a.ts");
      const moduleB = join(dir, "store-b.ts");
      writeFileSync(moduleA, storeModuleSource("PERSIST_MODULE_FILE_A"), "utf8");
      writeFileSync(moduleB, storeModuleSource("PERSIST_MODULE_FILE_B"), "utf8");
      const outA = join(dir, "out-a.json");
      const outB = join(dir, "out-b.json");
      const payloadFile = writePayload(dir, "snapshot.json", SNAPSHOT_PAYLOAD);

      const r = runCli(["persist", "snapshot", "--key", "mod-2", "--file", payloadFile, "--store", moduleB], {
        env: { MSTAR_STORE_MODULE: moduleA, PERSIST_MODULE_FILE_A: outA, PERSIST_MODULE_FILE_B: outB },
      });
      expect(r.exitCode).toBe(0);
      expect(existsSync(outB)).toBe(true); // module B (--store) was used
      expect(existsSync(outA)).toBe(false); // module A (env) was not
    });
  });

  test("--store with a URI scheme is rejected before any import (SP2-AC7)", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "snapshot.json", SNAPSHOT_PAYLOAD);
      const r = runCli(["persist", "snapshot", "--key", "k", "--file", payloadFile, "--store", "http://example.com/s.mjs"], {
        env: harnessEnv(dir),
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("only filesystem paths are allowed");
    });
  });
});

describe("mstar persist — --schema is accepted as doc metadata", () => {
  test("--schema id is accepted and the put still lands", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "review.json", REVIEW_PAYLOAD);
      const r = runCli(
        ["persist", "review", "--key", "20260827-artifact-store", "--file", payloadFile, "--schema", "mstar.review/v1"],
        { env: harnessEnv(dir) },
      );
      expect(r.exitCode).toBe(0);
      expect(existsSync(join(dir, "sdd", "20260827-artifact-store", "review", "report.json"))).toBe(true);
    });
  });
});
