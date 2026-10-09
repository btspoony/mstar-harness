/**
 * CLI `mstar persist` / `persist get` — ArtifactStore persist port.
 *
 * Each case spawns the real CLI entry as a subprocess. The default FsStore
 * is pinned to a temp harness via `MSTAR_HARNESS_DIR` (the store resolves
 * the harness dir from env ahead of cwd probing — the same resolution the
 * writers use, so the round-trip asserts real file placement). The
 * `--store` / `MSTAR_STORE_MODULE` path loads a self-contained temp module
 * (no engine import — the loader accepts a plain factory).
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { synthesizeReview } from "@mstar-harness/engine";
import { expectUsageDiagnostic } from "./support/cli-assertions";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

type CommandEnvelope = {
  command: string;
  status: "ok" | "refused" | "usage";
  code: string;
  exitCode: number;
  message?: string;
  data?: unknown;
};

function envelope(result: RunResult): CommandEnvelope {
  return JSON.parse(result.stdout) as CommandEnvelope;
}

function message(result: RunResult): string {
  return envelope(result).message ?? "";
}

function persistedPayload(result: RunResult): unknown {
  const data = envelope(result).data;
  if (data === null || typeof data !== "object" || !("payload" in data)) {
    throw new Error("expected persist response with a payload");
  }
  return data.payload;
}

/** Spawn env with ambient harness env vars pinned out:
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
/** Register-shaped payload: what the retired `residuals` kind used to accept. */
const REGISTER_PAYLOAD = { entries: {} };
/** Minimal valid `mstar.review/v1` envelope (shape; tally consistent
 * — {1 should-fix, 1 nit} ⇒ 100-15-3=82, needs fixes). */
const REVIEW_PAYLOAD = {
  schema: "mstar.review/v1",
  verdict: "needs fixes",
  summary_md: "2 findings: 1 should-fix, 1 nit.",
  findings: [
    {
      mergeClass: "should-fix",
      title: "Unhandled null deref",
      body: "foo() can return null before the call site dereferences it.",
    },
    { mergeClass: "nit", title: "Typo in comment", body: "s/recieve/receive/" },
  ],
  tally: {
    verdict: "needs fixes",
    scorePct: 82,
    tally: { mustFix: 0, shouldFix: 1, nit: 1, unverified: 0 },
    chatHeader: "needs fixes \u00b7 82%\nmust-fix=0 should-fix=1 nit=1 unverified=0",
  },
};

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

/** Self-contained recording store module: writes {kind, key, payload} so a
 * test can assert the kind that reached the store's put. */
function recordingStoreModuleSource(envVar: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    `const file = process.env.${envVar};`,
    `if (!file) throw new Error("${envVar} is required");`,
    "export function createArtifactStore() {",
    "  return {",
    "    async put(doc) { writeFileSync(file, JSON.stringify({ kind: doc.kind, key: doc.key, payload: doc.payload })); },",
    "    async get() { return undefined; },",
    "  };",
    "}",
  ].join("\n");
}

/**
 * `persist write` validates documents before replacing them. Snapshot writes
 * remain coordinator-session protected; status writes use ordinary replacement.
 */
describe("mstar persist — FsStore round-trip in a temp harness dir (MSTAR_HARNESS_DIR)", () => {
  test("a protected snapshot write requires a coordinator session and writes nothing without one", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "payload.json", SNAPSHOT_PAYLOAD);
      const put = runCli(["persist", "write", "snapshot", "--key", "wf-1", "--file", payloadFile], { env: harnessEnv(dir) });
      expect(put.exitCode).toBe(2);
      expect(existsSync(join(dir, "workflows", "wf-1", "snapshot.json"))).toBe(false);
      expect(envelope(put)).toMatchObject({ command: "persist.write", status: "usage", code: "command.invalid-input" });

      const get = runCli(["persist", "get", "snapshot", "--key", "wf-1"], { env: harnessEnv(dir) });
      expect(get.exitCode).toBe(1);
      expect(message(get)).toContain("no stored document");
    });
  });

  test("a status write creates the validated status document without a byte token", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "payload.json", STATUS_PAYLOAD);
      const put = runCli(["persist", "write", "status", "--key", "root", "--file", payloadFile], { env: harnessEnv(dir) });
      expect(put.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, "status.json"), "utf8"))).toEqual(STATUS_PAYLOAD);
    });
  });

  test("issue authority: the retired residuals kind refuses with the migration path and writes no register", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "payload.json", REGISTER_PAYLOAD);
      const put = runCli(["persist", "write", "residuals", "--key", "proj-1", "--file", payloadFile], {
        env: harnessEnv(dir),
      });
      expect(put.exitCode).toBe(1);
      expect(message(put)).toContain("residuals is retired");
      expect(message(put)).toContain("issue store is the only findings authority");
      expect(existsSync(join(dir, "projects", "proj-1", "residuals.json"))).toBe(false);
      expect(existsSync(join(dir, "projects"))).toBe(false);

      // The read/delete faces refuse the same way — the kind has no authority.
      const get = runCli(["persist", "get", "residuals", "--key", "proj-1"], { env: harnessEnv(dir) });
      expect(get.exitCode).toBe(1);
      expect(message(get)).toContain("residuals is retired");
    });
  });

  test("issue authority: a json alias to a project register is refused and no register file appears", () => {
    withTempDir((dir) => {
      const registerPath = join(dir, "projects", "proj-1", "residuals.json");
      mkdirSync(join(dir, "projects", "proj-1"), { recursive: true });
      const payloadFile = writePayload(dir, "payload.json", REGISTER_PAYLOAD);
      const put = runCli(["persist", "write", "json", "--key", registerPath, "--file", payloadFile], {
        env: harnessEnv(dir),
      });
      expect(put.exitCode).toBe(1);
      expect(message(put)).toContain("project registers are retired migration history");
      expect(existsSync(registerPath)).toBe(false);

      // The alias is not a read path either, and a same-named file outside the
      // resolved project dir is not a register (the guard is boundary-scoped).
      const get = runCli(["persist", "get", "json", "--key", registerPath], { env: harnessEnv(dir) });
      expect(get.exitCode).toBe(1);
      const outside = join(dir, "elsewhere", "residuals.json");
      const allowed = runCli(["persist", "write", "json", "--key", outside, "--file", payloadFile], {
        env: harnessEnv(dir),
      });
      expect(allowed.exitCode).toBe(0);
      expect(existsSync(outside)).toBe(true);
    });
  });

  test("review round-trips for a plan-shaped key (sdd/<key>/review/report.json) and an other key (sdd/_reviews/)", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "review.json", REVIEW_PAYLOAD);
      const planShaped = runCli(["persist", "write", "review", "--key", "20260827-artifact-store", "--file", payloadFile], { env: harnessEnv(dir) },);
      expect(planShaped.exitCode).toBe(0);
      expect(existsSync(join(dir, "sdd", "20260827-artifact-store", "review", "report.json"))).toBe(true);

      const otherKey = runCli(["persist", "write", "review", "--key", "review-abc", "--file", payloadFile], {
        env: harnessEnv(dir),
      });
      expect(otherKey.exitCode).toBe(0);
      expect(existsSync(join(dir, "sdd", "_reviews", "review-abc.json"))).toBe(true);

      const get = runCli(["persist", "get", "review", "--key", "20260827-artifact-store"], { env: harnessEnv(dir) });
      expect(get.exitCode).toBe(0);
      expect(persistedPayload(get)).toEqual(REVIEW_PAYLOAD);
    });
  });

  test("json kind persists to the absolute key path", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "payload.json", { hello: "world" });
      const target = join(dir, "custom", "payload.json");
      const put = runCli(["persist", "write", "json", "--key", target, "--file", payloadFile], { env: harnessEnv(dir) });
      expect(put.exitCode).toBe(0);
      expect(existsSync(target)).toBe(true);

      const get = runCli(["persist", "get", "json", "--key", target], { env: harnessEnv(dir) });
      expect(get.exitCode).toBe(0);
      expect(persistedPayload(get)).toEqual({ hello: "world" });
    });
  });

  test("json kind with a non-absolute key is rejected", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "payload.json", { hello: "world" });
      const r = runCli(["persist", "write", "json", "--key", "relative/path.json", "--file", payloadFile], {
        env: harnessEnv(dir),
      });
      expect(r.exitCode).toBe(1);
      expect(message(r)).toContain("absolute path");
    });
  });
});

describe("mstar persist — validators run before put", () => {
  test("status validator rejects a v1 document (exit 1, no write)", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "v1.json", { version: 1, plans: [] });
      const r = runCli(["persist", "write", "status", "--key", "root", "--file", payloadFile], { env: harnessEnv(dir) },);
      expect(r.exitCode).toBe(1);
      expect(message(r)).toContain("refusing to persist invalid status document");
      expect(existsSync(join(dir, "status.json"))).toBe(false);
    });
  });

  test("snapshot validator rejects a doc missing schema_version (exit 1, no write)", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "bad-snapshot.json", { id: "wf-1", plans: [] });
      const r = runCli(["persist", "write", "snapshot", "--key",
      "wf-1",
      "--file",
      payloadFile,
      "--session",
      join(dir, "coordinator.json"),], { env: harnessEnv(dir) },);
      expect(r.exitCode).toBe(1);
      expect(message(r)).toContain("refusing to persist invalid snapshot document");
      expect(existsSync(join(dir, "workflows", "wf-1", "snapshot.json"))).toBe(false);
    });
  });

  test("issue authority: the retired residuals kind is refused before any payload is read (exit 1)", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "bad-residuals.json", { nope: 1 });
      const r = runCli(["persist", "write", "residuals", "--key", "proj-1", "--file", payloadFile], { env: harnessEnv(dir) },);
      expect(r.exitCode).toBe(1);
      expect(message(r)).toContain("residuals is retired");
      expect(existsSync(join(dir, "projects", "proj-1", "residuals.json"))).toBe(false);
      // Retirement precedes the payload read: a missing file changes nothing.
      const missing = runCli(["persist", "write", "residuals", "--key", "proj-1", "--file", join(dir, "absent.json")], {
        env: harnessEnv(dir),
      });
      expect(missing.exitCode).toBe(1);
      expect(message(missing)).toContain("residuals is retired");
      expect(message(missing)).not.toContain("payload file not found");
    });
  });

  test("invalid JSON payload is rejected (exit 1)", () => {
    withTempDir((dir) => {
      const payloadFile = join(dir, "bad.json");
      writeFileSync(payloadFile, "{ not json", "utf8");
      const r = runCli(["persist", "write", "json", "--key", join(dir, "out.json"), "--file", payloadFile], {
        env: harnessEnv(dir),
      });
      expect(r.exitCode).toBe(1);
      expect(message(r)).toContain("not valid JSON");
    });
  });
});

describe("mstar persist review — validateMstarReviewV1 before put", () => {
  test("rejects an inspector M1 vocab envelope (exit 1, no write)", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "m1-review.json", { verdict: "approve" });
      const r = runCli(["persist", "write", "review", "--key", "20260827-review-json", "--file", payloadFile], {
        env: harnessEnv(dir),
      });
      expect(r.exitCode).toBe(1);
      expect(message(r)).toContain("refusing to persist invalid review document");
      expect(message(r)).toContain("review.inspector-vocab");
      expect(existsSync(join(dir, "sdd", "20260827-review-json", "review", "report.json"))).toBe(false);
    });
  });

  test("rejects a missing-schema envelope (exit 1, no write)", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "no-schema.json", {
        verdict: "needs fixes",
        summary_md: "summary",
        findings: [],
      });
      const r = runCli(["persist", "write", "review", "--key", "review-abc", "--file", payloadFile], { env: harnessEnv(dir) });
      expect(r.exitCode).toBe(1);
      expect(message(r)).toContain("refusing to persist invalid review document");
      expect(message(r)).toContain("review.missing-schema");
      expect(existsSync(join(dir, "sdd", "_reviews", "review-abc.json"))).toBe(false);
    });
  });

  test("rejects a verdict/tally mismatch (exit 1, no write)", () => {
    withTempDir((dir) => {
      const mismatched = { ...REVIEW_PAYLOAD, verdict: "ship it" };
      const payloadFile = writePayload(dir, "mismatch.json", mismatched);
      const r = runCli(["persist", "write", "review", "--key", "pr-42", "--file", payloadFile], { env: harnessEnv(dir) });
      expect(r.exitCode).toBe(1);
      expect(message(r)).toContain("refusing to persist invalid review document");
      expect(message(r)).toContain("review.verdict-tally-mismatch");
      expect(existsSync(join(dir, "sdd", "_reviews", "pr-42.json"))).toBe(false);
    });
  });

  test("rejects a hand-authored tally missing fields (exit 1, no write)", () => {
    withTempDir((dir) => {
      const doctored = {
        ...REVIEW_PAYLOAD,
        tally: { verdict: "needs fixes" }, // no scorePct / counts / chatHeader
      };
      const payloadFile = writePayload(dir, "doctored-tally.json", doctored);
      const r = runCli(["persist", "write", "review", "--key", "pr-42", "--file", payloadFile], { env: harnessEnv(dir) });
      expect(r.exitCode).toBe(1);
      expect(message(r)).toContain("refusing to persist invalid review document");
      expect(message(r)).toContain("review.tally-malformed");
      expect(existsSync(join(dir, "sdd", "_reviews", "pr-42.json"))).toBe(false);
    });
  });

  test("persists a genuine synthesizeReview product end-to-end (exit 0)", () => {
    withTempDir((dir) => {
      const synthesized = synthesizeReview({
        findings: [
          {
            mergeClass: "should-fix",
            title: "Unhandled null deref",
            body: "foo() can return null before the call site dereferences it.",
          },
          { mergeClass: "nit", title: "Typo in comment", body: "s/recieve/receive/" },
        ],
      });
      const payloadFile = writePayload(dir, "synthesized-review.json", synthesized);
      const r = runCli(["persist", "write", "review", "--key", "pr-7", "--file", payloadFile], { env: harnessEnv(dir) });
      expect(r.exitCode).toBe(0);
      expect(envelope(r)).toMatchObject({ command: "persist.write", status: "ok", data: { kind: "review", key: "pr-7" } });
      expect(existsSync(join(dir, "sdd", "_reviews", "pr-7.json"))).toBe(true);
    });
  });

  test("recording store receives kind: review for a valid envelope", () => {
    withTempDir((dir) => {
      const moduleFile = join(dir, "recording-store.ts");
      writeFileSync(moduleFile, recordingStoreModuleSource("RECORDING_STORE_FILE"), "utf8");
      const outFile = join(dir, "recorded.json");
      const payloadFile = writePayload(dir, "review.json", REVIEW_PAYLOAD);

      const put = runCli(["persist", "write", "review", "--key", "pr-134", "--file", payloadFile, "--store", moduleFile], {
        env: { RECORDING_STORE_FILE: outFile },
      });
      expect(put.exitCode).toBe(0);
      const recorded = JSON.parse(readFileSync(outFile, "utf8"));
      expect(recorded.kind).toBe("review");
      expect(recorded.key).toBe("pr-134");
      expect(recorded.payload).toEqual(REVIEW_PAYLOAD);
    });
  });
});

describe("mstar persist — usage errors", () => {
  test("unknown kind → usage, exit 2", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "payload.json", { a: 1 });
      const put = runCli(["persist", "write", "bogus", "--key", "k", "--file", payloadFile], { env: harnessEnv(dir) });
      expect(put.exitCode).toBe(2);
      expect(message(put)).toContain("kind must be status, snapshot, review, or json");

      const get = runCli(["persist", "get", "bogus", "--key", "k"], { env: harnessEnv(dir) });
      expect(get.exitCode).toBe(2);
      expect(message(get)).toContain("kind must be status, snapshot, review, or json");
    });
  });

  test("--file and --input together → usage, exit 2", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "payload.json", { a: 1 });
      const r = runCli([
        "persist", "write", "snapshot", "--key", "k", "--file", payloadFile,
        "--input", JSON.stringify({ alternate: true }),
        "--session", join(dir, "coordinator.json"),
      ], { env: harnessEnv(dir) });
      expect(r.exitCode).toBe(2);
      expect(message(r)).toContain("mutually exclusive");
    });
  });

  test("missing payload file → exit 1", () => {
    withTempDir((dir) => {
      const r = runCli(["persist", "write", "snapshot", "--key",
      "k",
      "--file",
      join(dir, "no-such.json"),
      "--session",
      join(dir, "coordinator.json"),], { env: harnessEnv(dir) },);
      expect(r.exitCode).toBe(1);
      expect(message(r)).toContain("payload file not found");
    });
  });
});

describe("mstar persist get — absent document", () => {
  test("missing key → exit 1 with a message (no stored document)", () => {
    withTempDir((dir) => {
      const r = runCli(["persist", "get", "snapshot", "--key", "no-such-wf"], { env: harnessEnv(dir) });
      expect(r.exitCode).toBe(1);
      expect(message(r)).toContain("no stored document");
    });
  });
});

describe("mstar persist — inline JSON input", () => {
  test("--input supplies a validated coordinated replacement payload", () => {
    withTempDir((dir) => {
      const gate = ["--session", join(dir, "coordinator.json")];
      const put = runCli(["persist", "write", "snapshot", "--key", "wf-inline", "--input", JSON.stringify(SNAPSHOT_PAYLOAD), ...gate], {
        env: harnessEnv(dir),
      });
      expect(put.exitCode).toBe(1);
      expect(message(put)).not.toContain("not valid JSON");
      expect(existsSync(join(dir, "workflows", "wf-inline", "snapshot.json"))).toBe(false);

      const malformed = runCli(["persist", "write", "snapshot", "--key", "wf-inline", "--input", "{not json", ...gate], {
        env: harnessEnv(dir),
      });
      expect(malformed.exitCode).toBe(1);
      expect(message(malformed)).toContain("not valid JSON");
    });
  });

  test("--input writes an unprotected JSON payload to an absolute key", () => {
    withTempDir((dir) => {
      const target = join(dir, "loose.json");
      const put = runCli(["persist", "write", "json", "--key", target, "--input", JSON.stringify({ anything: ["goes", 1] })], {
        env: harnessEnv(dir),
      });
      expect(put.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ anything: ["goes", 1] });

      const get = runCli(["persist", "get", "json", "--key", target], { env: harnessEnv(dir) });
      expect(get.exitCode).toBe(0);
      expect(persistedPayload(get)).toEqual({ anything: ["goes", 1] });
    });
  });
});

describe("mstar persist — --store / MSTAR_STORE_MODULE module injection", () => {
  test("--store loads the module and routes the put through it", () => {
    withTempDir((dir) => {
      const moduleFile = join(dir, "store-mod.ts");
      writeFileSync(moduleFile, storeModuleSource("PERSIST_MODULE_FILE"), "utf8");
      const outFile = join(dir, "module-out.json");
      const payloadFile = writePayload(dir, "review.json", REVIEW_PAYLOAD);

      const put = runCli(["persist", "write", "review", "--key", "mod-1", "--file", payloadFile, "--store", moduleFile], {
        env: { PERSIST_MODULE_FILE: outFile },
      });
      expect(put.exitCode).toBe(0);
      // The put went through the module (module-out.json), not the FsStore.
      expect(existsSync(outFile)).toBe(true);
      expect(JSON.parse(readFileSync(outFile, "utf8"))).toEqual({ key: "mod-1", payload: REVIEW_PAYLOAD });

      const get = runCli(["persist", "get", "review", "--key", "mod-1", "--store", moduleFile], {
        env: { PERSIST_MODULE_FILE: outFile },
      });
      expect(get.exitCode).toBe(0);
      expect(persistedPayload(get)).toEqual(REVIEW_PAYLOAD);
    });
  });


  test("--store with a URI scheme is rejected before any import", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "review.json", REVIEW_PAYLOAD);
      const r = runCli(["persist", "write", "review", "--key", "k", "--file", payloadFile, "--store", "http://example.com/s.mjs"], {
        env: harnessEnv(dir),
      });
      expect(r.exitCode).toBe(1);
      expect(message(r)).toContain("only filesystem paths are allowed");
    });
  });
});

describe("mstar persist — --schema under the D3 fail-loud store contract", () => {
  test("--schema + default FsStore is a store refusal: exit 1 with the canonical message", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "review.json", REVIEW_PAYLOAD);
      const r = runCli(["persist", "write", "review", "--key", "20260827-artifact-store", "--file", payloadFile, "--schema", "mstar.review/v1"], { env: harnessEnv(dir) },);
      expect(r.exitCode).toBe(1);
      expect(message(r)).toContain("FsStore does not persist schema ids");
      expect(existsSync(join(dir, "sdd", "20260827-artifact-store", "review", "report.json"))).toBe(false);
    });
  });

  test("--schema lands through an injected store module that persists it", () => {
    withTempDir((dir) => {
      const module = join(dir, "schema-store.ts");
      writeFileSync(
        module,
        [
          'import { writeFileSync, readFileSync, existsSync } from "node:fs";',
          "const file = process.env.PERSIST_SCHEMA_FILE;",
          'if (!file) throw new Error("PERSIST_SCHEMA_FILE is required");',
          "export function createArtifactStore() {",
          "  return {",
          "    async put(doc) {",
          "      writeFileSync(file, JSON.stringify({ key: doc.key, schema: doc.schema, payload: doc.payload }));",
          "    },",
          "    async get(ref) {",
          "      if (!existsSync(file)) return undefined;",
          '      const stored = JSON.parse(readFileSync(file, "utf8"));',
          "      return stored.key === ref.key ? stored.payload : undefined;",
          "    },",
          "  };",
          "}",
        ].join("\n"),
        "utf8",
      );
      const payloadFile = writePayload(dir, "review.json", REVIEW_PAYLOAD);
      const out = join(dir, "schema-store.json");
      const r = runCli(["persist", "write", "review", "--key",
      "20260827-artifact-store",
      "--file",
      payloadFile,
      "--schema",
      "mstar.review/v1",
      "--store",
      module,], { env: { ...harnessEnv(dir), PERSIST_SCHEMA_FILE: out } },);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8")).schema).toBe("mstar.review/v1");
    });
  });
});

describe("mstar persist list — D4/D5 enumeration face", () => {
  test("snapshot keys print one per line ascending, no header (D5)", () => {
    withTempDir((dir) => {
      // Existing bytes are the fixture: enumeration is the subject here, not
      // the protected write face.
      for (const key of ["wf-2", "wf-10", "wf-1"]) {
        mkdirSync(join(dir, "workflows", key), { recursive: true });
        writeFileSync(join(dir, "workflows", key, "snapshot.json"), JSON.stringify(SNAPSHOT_PAYLOAD), "utf8");
      }
      const list = runCli(["persist", "list", "snapshot"], { env: harnessEnv(dir) });
      expect(list.exitCode).toBe(0);
      expect(envelope(list).data).toEqual(["wf-1", "wf-10", "wf-2"]);
    });
  });

  test("review union: plan-shaped dir keys + _reviews flat keys (D4)", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "review.json", REVIEW_PAYLOAD);
      const planShaped = runCli(["persist", "write", "review", "--key", "20260828-store-cli-faces", "--file", payloadFile], { env: harnessEnv(dir) },);
      expect(planShaped.exitCode).toBe(0);
      const flat = runCli(["persist", "write", "review", "--key", "review-abc", "--file", payloadFile], {
        env: harnessEnv(dir),
      });
      expect(flat.exitCode).toBe(0);
      const list = runCli(["persist", "list", "review"], { env: harnessEnv(dir) });
      expect(list.exitCode).toBe(0);
      expect(envelope(list).data).toEqual(["20260828-store-cli-faces", "review-abc"]);
    });
  });

  test("status lists root only when status.json exists; empty stdout + exit 0 when absent (D4 exists-conditional)", () => {
    withTempDir((dir) => {
      const missing = runCli(["persist", "list", "status"], { env: harnessEnv(dir) });
      expect(missing.exitCode).toBe(0);
      expect(envelope(missing).data).toEqual([]);

      writePayload(dir, "status.json", STATUS_PAYLOAD);
      const list = runCli(["persist", "list", "status"], { env: harnessEnv(dir) });
      expect(list.exitCode).toBe(0);
      expect(envelope(list).data).toEqual(["root"]);
    });
  });

  test("empty kind → empty stdout, exit 0 (D5)", () => {
    withTempDir((dir) => {
      const list = runCli(["persist", "list", "snapshot"], { env: harnessEnv(dir) });
      expect(list.exitCode).toBe(0);
      expect(envelope(list).data).toEqual([]);
    });
  });

  test("json kind → usage error exit 2 before calling list (D5)", () => {
    withTempDir((dir) => {
      const list = runCli(["persist", "list", "json"], { env: harnessEnv(dir) });
      expect(list.exitCode).toBe(2);
      expect(message(list)).toContain("json keys are absolute paths and cannot be listed");
      expect(envelope(list)).toMatchObject({ command: "persist.list", status: "usage", code: "command.invalid-input" });
    });
  });

  test("unknown kind → usage, exit 2", () => {
    withTempDir((dir) => {
      const list = runCli(["persist", "list", "bogus"], { env: harnessEnv(dir) });
      expect(list.exitCode).toBe(2);
      expect(message(list)).toContain("kind must be status, snapshot, review, or json");
    });
  });

  test("injected store without list → usage error exit 2, not TypeError exit 1 (D4 probe)", () => {
    withTempDir((dir) => {
      const moduleFile = join(dir, "store-mod.ts");
      writeFileSync(moduleFile, storeModuleSource("PERSIST_MODULE_FILE"), "utf8");
      const list = runCli(["persist", "list", "snapshot", "--store", moduleFile], {
        env: { ...harnessEnv(dir), PERSIST_MODULE_FILE: join(dir, "recording.json") },
      });
      expect(list.exitCode).toBe(2);
      expect(message(list)).toContain("store does not support list");
    });
  });
});

/** Self-contained store module WITH delete: records the deleted ref so a
 * test can assert the ref that reached the store's delete (D2 routing). */
function deletingStoreModuleSource(envVar: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    `const file = process.env.${envVar};`,
    `if (!file) throw new Error("${envVar} is required");`,
    "export function createArtifactStore() {",
    "  return {",
    "    async put() {},",
    "    async get() { return undefined; },",
    "    async delete(ref) { writeFileSync(file, JSON.stringify({ kind: ref.kind, key: ref.key })); },",
    "  };",
    "}",
  ].join("\n");
}

describe("mstar persist get --validate + persist delete — D1/D2 faces", () => {
  test("valid status doc + --validate → exit 0; stdout is payload JSON only; stderr note validation: ok (D1)", () => {
    withTempDir((dir) => {
      writePayload(dir, "status.json", STATUS_PAYLOAD);
      const get = runCli(["persist", "get", "status", "--key", "root", "--validate"], {
        env: harnessEnv(dir),
      });
      expect(get.exitCode).toBe(0);
      expect(persistedPayload(get)).toEqual(STATUS_PAYLOAD);
      expect((envelope(get).data as { validation: string }).validation).toBe("ok");
    });
  });

  test("invalid stored status doc + --validate → exit 1; stdout empty; stderr carries the put-gate violations (D1)", () => {
    withTempDir((dir) => {
      // Bypass the put gate by writing the backing file directly.
      writePayload(dir, "status.json", { version: 1, plans: [] });
      const get = runCli(["persist", "get", "status", "--key", "root", "--validate"], {
        env: harnessEnv(dir),
      });
      expect(get.exitCode).toBe(1);
      expect(envelope(get)).toMatchObject({ command: "persist.get", status: "refused" });
      expect(message(get)).toContain("refusing to persist invalid status document");
    });
  });

  test("without --validate an invalid stored doc still prints raw, exit 0 (D1 read-stays-raw)", () => {
    withTempDir((dir) => {
      const invalid = { version: 1, plans: [] };
      writePayload(dir, "status.json", invalid);
      const get = runCli(["persist", "get", "status", "--key", "root"], { env: harnessEnv(dir) });
      expect(get.exitCode).toBe(0);
      expect(persistedPayload(get)).toEqual(invalid);
      expect(message(get)).not.toContain("validation");
    });
  });

  test("json kind + --validate is a parse-only no-op → exit 0, stderr note json: parse-only (D1)", () => {
    withTempDir((dir) => {
      const loose = { anything: ["goes", 1] };
      const looseFile = writePayload(dir, "loose.json", loose);
      const get = runCli(["persist", "get", "json", "--key", looseFile, "--validate"], {
        env: harnessEnv(dir),
      });
      expect(get.exitCode).toBe(0);
      expect(persistedPayload(get)).toEqual(loose);
      expect((envelope(get).data as { validation: string }).validation).toBe("parse-only");
    });
  });

  test("miss + --validate → exit 1 with the existing miss string; validation never runs (D1)", () => {
    withTempDir((dir) => {
      const get = runCli(["persist", "get", "snapshot", "--key", "no-such-wf", "--validate"], {
        env: harnessEnv(dir),
      });
      expect(get.exitCode).toBe(1);
      expect(envelope(get)).toMatchObject({ command: "persist.get", status: "refused" });
      expect(message(get)).toContain("persist get snapshot/no-such-wf: no stored document");
      expect(message(get)).not.toContain("validation: ok");
    });
  });

  test("delete of a protected kind refuses and leaves the bytes untouched (lifecycle close is not deletion)", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "workflows", "wf-1"), { recursive: true });
      const snapshotPath = join(dir, "workflows", "wf-1", "snapshot.json");
      writeFileSync(snapshotPath, JSON.stringify(SNAPSHOT_PAYLOAD), "utf8");

      const del = runCli(["persist", "delete", "snapshot", "--key", "wf-1"], { env: harnessEnv(dir) });
      expect(del.exitCode).toBe(1);
      expect(message(del)).toContain("Raw writes are refused for protected coordination documents.");
      expect(message(del)).toContain("refused");
      expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toEqual(SNAPSHOT_PAYLOAD);
    });
  });

  test("delete of an absent protected key refuses too — the refusal is kind-scoped, not existence-scoped", () => {
    withTempDir((dir) => {
      const del = runCli(["persist", "delete", "snapshot", "--key", "never-existed"], {
        env: harnessEnv(dir),
      });
      expect(del.exitCode).toBe(1);
      expect(message(del)).toContain("Raw writes are refused for protected coordination documents.");
    });
  });

  test("status kind delete refuses and keeps {HARNESS_DIR}/status.json (lifecycle close is not deletion)", () => {
    withTempDir((dir) => {
      writePayload(dir, "status.json", STATUS_PAYLOAD);
      const del = runCli(["persist", "delete", "status", "--key", "root"], { env: harnessEnv(dir) });
      expect(del.exitCode).toBe(1);
      expect(message(del)).toContain("Raw writes are refused for protected coordination documents.");
      expect(JSON.parse(readFileSync(join(dir, "status.json"), "utf8"))).toEqual(STATUS_PAYLOAD);
    });
  });

  test("delete of an unprotected kind still deletes (review keeps its existing behavior)", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "review.json", REVIEW_PAYLOAD);
      const put = runCli(["persist", "write", "review", "--key", "review-abc", "--file", payloadFile], {
        env: harnessEnv(dir),
      });
      expect(put.exitCode).toBe(0);
      const target = join(dir, "sdd", "_reviews", "review-abc.json");
      expect(existsSync(target)).toBe(true);

      const del = runCli(["persist", "delete", "review", "--key", "review-abc"], { env: harnessEnv(dir) });
      expect(del.exitCode).toBe(0);
      expect(envelope(del)).toMatchObject({ command: "persist.delete", status: "ok", data: { deleted: true, kind: "review", key: "review-abc" } });
      expect(existsSync(target)).toBe(false);

      // Idempotent for an unprotected kind: an already-absent key is a no-op.
      const again = runCli(["persist", "delete", "review", "--key", "review-abc"], { env: harnessEnv(dir) });
      expect(again.exitCode).toBe(0);
      expect(envelope(again)).toMatchObject({ command: "persist.delete", status: "ok", data: { deleted: true, kind: "review", key: "review-abc" } });
    });
  });

  test("delete without --key → usage error exit 2 (D5)", () => {
    withTempDir((dir) => {
      const del = runCli(["persist", "delete", "snapshot"], { env: harnessEnv(dir) });
      expect(del.exitCode).toBe(2);
      expectUsageDiagnostic(del, "key");
    });
  });

  test("delete with an unknown kind → usage error exit 2 (D5)", () => {
    withTempDir((dir) => {
      const del = runCli(["persist", "delete", "bogus", "--key", "x"], { env: harnessEnv(dir) });
      expect(del.exitCode).toBe(2);
      expect(message(del)).toContain("kind must be status, snapshot, review, or json");
    });
  });

  test("injected store without delete → usage error exit 2, not TypeError exit 1 (D2 probe)", () => {
    withTempDir((dir) => {
      const moduleFile = join(dir, "store-mod.ts");
      writeFileSync(moduleFile, storeModuleSource("PERSIST_MODULE_FILE"), "utf8");
      const del = runCli(["persist", "delete", "snapshot", "--key", "wf-1", "--store", moduleFile], {
        env: { ...harnessEnv(dir), PERSIST_MODULE_FILE: join(dir, "recording.json") },
      });
      expect(del.exitCode).toBe(2);
      expect(message(del)).toContain("store does not support delete");
    });
  });

  test("injected store with delete → delete routes through the module with the resolved ref (D2)", () => {
    withTempDir((dir) => {
      const moduleFile = join(dir, "store-mod.ts");
      writeFileSync(moduleFile, deletingStoreModuleSource("PERSIST_MODULE_FILE"), "utf8");
      const recording = join(dir, "recording.json");
      const del = runCli(["persist", "delete", "status", "--key", "root", "--store", moduleFile], {
        env: { ...harnessEnv(dir), PERSIST_MODULE_FILE: recording },
      });
      expect(del.exitCode).toBe(0);
      expect(envelope(del)).toMatchObject({ command: "persist.delete", status: "ok", data: { deleted: true, kind: "status", key: "root" } });
      expect(JSON.parse(readFileSync(recording, "utf8"))).toEqual({ kind: "status", key: "root" });
    });
  });
});

describe("mstar persist coordinated-writer — identity and path boundaries", () => {

  test("an existing status document can be replaced without a byte token", () => {
    withTempDir((dir) => {
      const original = JSON.stringify({ ...STATUS_PAYLOAD, updated_at: "2026-01-01" });
      writeFileSync(join(dir, "status.json"), original, "utf8");
      const payloadFile = writePayload(dir, "payload.json", STATUS_PAYLOAD);

      const replaced = runCli(["persist", "write", "status", "--key", "root", "--file", payloadFile], { env: harnessEnv(dir) });
      expect(replaced.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, "status.json"), "utf8"))).toEqual(STATUS_PAYLOAD);
      expect(STATUS_PAYLOAD).not.toEqual(JSON.parse(original));
    });
  });

  test("a json alias of a protected target is refused by canonical path, not by kind name", () => {
    withTempDir((dir) => {
      const payloadFile = writePayload(dir, "payload.json", STATUS_PAYLOAD);
      const put = runCli(["persist", "write", "json", "--key", join(dir, "status.json"), "--file", payloadFile], { env: harnessEnv(dir) },);
      expect(put.exitCode).toBe(1);
      expect(message(put)).toContain("Raw writes are refused for protected coordination documents.");
      expect(existsSync(join(dir, "status.json"))).toBe(false);
    });
  });


  test("--versioned reports the absent token for a missing document (the first-create precondition)", () => {
    withTempDir((dir) => {
      const read = runCli(["persist", "get", "snapshot", "--key", "wf-none", "--versioned"], {
        env: harnessEnv(dir),
      });
      expect(read.exitCode).toBe(0);
      expect(envelope(read).data).toEqual({ payload: null, version: "absent" });
    });
  });

  test("--versioned refuses a pluggable store module (no same-host CAS on a remote module)", () => {
    withTempDir((dir) => {
      const moduleFile = join(dir, "store-mod.ts");
      writeFileSync(moduleFile, storeModuleSource("PERSIST_MODULE_FILE"), "utf8");
      const read = runCli(["persist", "get", "snapshot", "--key", "wf-1", "--versioned", "--store", moduleFile], {
        env: { ...harnessEnv(dir), PERSIST_MODULE_FILE: join(dir, "recording.json") },
      });
      expect(read.exitCode).toBe(1);
      expect(envelope(read).code).toBe("coordination.local-store-required");
    });
  });
});
