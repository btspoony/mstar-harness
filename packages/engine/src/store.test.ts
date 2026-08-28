/**
 * Engine artifact store — ArtifactStore contract + FsStore + injection.
 *
 * Spec sources (each test cites the section it enforces; roadmap §8.5 C2
 * — engine unit tests cite the source section as spec):
 * - Contract + FsStore path table + key discipline + async-only store:
 *   `iter-20260827-cli-artifact-store` SP2 (iteration spec `artifact-store`)
 *   § Default FsStore (local IDE adapter) + § Architecture decisions
 *   1–5 (async-only, locks stay with callers, single path table, key
 *   discipline, default store resolution).
 * - Review path table (plan-shaped → `{HARNESS_DIR}/sdd/<key>/review/
 *   report.json`, other keys → `{HARNESS_DIR}/sdd/_reviews/<key>.json`):
 *   SP2 § Default FsStore — product-locked, shared with SP3.
 * - `json` escape hatch (absolute path only; reject `..` / non-absolute):
 *   SP2 § Default FsStore — not a user-facing AC.
 * - Default store resolution (`setArtifactStore(undefined)` resets; a
 *   `null` harness-dir resolution throws fail-loud, never a silent cwd
 *   fallback): SP2 § Architecture decisions 5.
 * - Module loader (`loadStoreModule` — named export / default factory /
 *   default object; URI-scheme rejection before import; missing file and
 *   non-store shape throw): SP2 § Injection 2–3 + SP2-AC6 / SP2-AC7.
 * - `put` schema guard (throw on `doc.schema !== undefined`, canonical
 *   message; `payload.schema` unaffected): `iter-20260828-store-completeness`
 *   spec `store-contract-completion` § D3.
 * - `list?` interface + FsStore enumeration (exists-conditional status,
 *   snapshot/residuals dir scans through the single path table, review
 *   union with the one PLAN_SHAPED_KEY_RE detector, json non-enumerable,
 *   `[]` on missing backing, sorted ascending, listed keys round-trip
 *   through `get`): `iter-20260828-store-completeness` spec
 *   `store-contract-completion` § D4 + § Architecture lock 4.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertFsStorePath,
  createFsStore,
  getArtifactStore,
  loadStoreModule,
  resolveArtifactPath,
  setArtifactStore,
  type ArtifactDoc,
  type ArtifactStore,
} from "../src/store.js";

const ENV_KEY = "MSTAR_HARNESS_DIR";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Run `fn` with `MSTAR_HARNESS_DIR` set to `value` (undefined deletes it),
 * restoring the previous env in all paths. Caller rule (qc1 S-003): `fn`
 * must read `process.env` synchronously before its first `await` — the env
 * window closes as soon as `fn` returns, which for an async callback is
 * immediately.
 */
function withEnv<T>(value: string | undefined, fn: () => T): T {
	const previous = process.env[ENV_KEY];
	if (value === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = value;
	try {
		return fn();
	} finally {
		if (previous === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = previous;
	}
}

/** Recording store for the injection tests (SP2-AC3 pattern — no D1). */
function recordingStore(): ArtifactStore & { puts: ArtifactDoc[] } {
  const puts: ArtifactDoc[] = [];
  return {
    puts,
    async put(doc: ArtifactDoc): Promise<void> {
      puts.push(doc);
    },
    async get(): Promise<undefined> {
      return undefined;
    },
  };
}

beforeEach(() => {
  setArtifactStore(undefined);
  delete process.env[ENV_KEY];
});

afterEach(() => {
  setArtifactStore(undefined);
  delete process.env[ENV_KEY];
});

// ---------------------------------------------------------------------------
// FsStore path mapping — SP2 § Default FsStore (single kind→path table)
// ---------------------------------------------------------------------------

describe("createFsStore path mapping", () => {
  test("status maps to {HARNESS_DIR}/status.json", async () => {
    const root = tmpRoot("store-status-");
    try {
      const store = createFsStore(root);
      await store.put({ kind: "status", key: "root", payload: { version: 2, updated_at: "2026-08-27", workflows: [] } });
      expect(existsSync(join(root, "status.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("snapshot maps to {WORKFLOW_DIR}/<key>/snapshot.json", async () => {
    const root = tmpRoot("store-snapshot-");
    try {
      const store = createFsStore(root);
      await store.put({ kind: "snapshot", key: "wf-1", payload: { id: "wf-1" } });
      expect(existsSync(join(root, "workflows", "wf-1", "snapshot.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("residuals maps to {PROJECT_DIR}/<key>/residuals.json", async () => {
    const root = tmpRoot("store-residuals-");
    try {
      const store = createFsStore(root);
      await store.put({ kind: "residuals", key: "proj-1", payload: { entries: [] } });
      expect(existsSync(join(root, "projects", "proj-1", "residuals.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("review plan-shaped key maps to {HARNESS_DIR}/sdd/<key>/review/report.json", async () => {
    const root = tmpRoot("store-review-plan-");
    try {
      const store = createFsStore(root);
      await store.put({ kind: "review", key: "20260827-artifact-store", payload: { verdict: "approve" } });
      expect(existsSync(join(root, "sdd", "20260827-artifact-store", "review", "report.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("review non-plan-shaped key maps to {HARNESS_DIR}/sdd/_reviews/<key>.json", async () => {
    const root = tmpRoot("store-review-other-");
    try {
      const store = createFsStore(root);
      await store.put({ kind: "review", key: "review-abc", payload: { verdict: "approve" } });
      expect(existsSync(join(root, "sdd", "_reviews", "review-abc.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("review key with date prefix but no plan suffix is not plan-shaped", async () => {
    const root = tmpRoot("store-review-date-");
    try {
      const store = createFsStore(root);
      await store.put({ kind: "review", key: "20260827", payload: { verdict: "approve" } });
      expect(existsSync(join(root, "sdd", "_reviews", "20260827.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("snapshot/residuals honor .mstarc workflow_dir / project_dir overrides", async () => {
    const root = tmpRoot("store-mstarc-");
    try {
      writeFileSync(join(root, ".mstarc"), "[config]\nworkflow_dir=wf-custom\nproject_dir=proj-custom\n");
      const store = createFsStore(root);
      await store.put({ kind: "snapshot", key: "wf-1", payload: { id: "wf-1" } });
      await store.put({ kind: "residuals", key: "proj-1", payload: { entries: [] } });
      expect(existsSync(join(root, "wf-custom", "wf-1", "snapshot.json"))).toBe(true);
      expect(existsSync(join(root, "proj-custom", "proj-1", "residuals.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Round-trip — SP2-AC2 (put then get returns the payload; missing → undefined)
// ---------------------------------------------------------------------------

describe("FsStore round-trip", () => {
  test("status / snapshot / residuals / review put then get returns the payload", async () => {
    const root = tmpRoot("store-roundtrip-");
    try {
      const store = createFsStore(root);
      const status = { version: 2, updated_at: "2026-08-27", workflows: [] };
      const snapshot = { id: "wf-1", status: "in_progress" };
      const residuals = { entries: [{ id: "R1" }] };
      const review = { verdict: "approve" };
      await store.put({ kind: "status", key: "root", payload: status });
      await store.put({ kind: "snapshot", key: "wf-1", payload: snapshot });
      await store.put({ kind: "residuals", key: "proj-1", payload: residuals });
      await store.put({ kind: "review", key: "20260827-artifact-store", payload: review });
      // Intermediate variables: a nested `expect(await store.get(...))` lets
      // TS infer the get<T> type parameter from the expect overload (never)
      // and narrows the actual to undefined — assign first, then assert.
      const gotStatus = await store.get({ kind: "status", key: "root" });
      const gotSnapshot = await store.get({ kind: "snapshot", key: "wf-1" });
      const gotResiduals = await store.get({ kind: "residuals", key: "proj-1" });
      const gotReview = await store.get({ kind: "review", key: "20260827-artifact-store" });
      expect(gotStatus).toEqual(status);
      expect(gotSnapshot).toEqual(snapshot);
      expect(gotResiduals).toEqual(residuals);
      expect(gotReview).toEqual(review);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("get on a missing artifact returns undefined", async () => {
    const root = tmpRoot("store-missing-");
    try {
      const store = createFsStore(root);
      expect(await store.get({ kind: "status", key: "root" })).toBeUndefined();
      expect(await store.get({ kind: "snapshot", key: "wf-1" })).toBeUndefined();
      expect(await store.get({ kind: "residuals", key: "proj-1" })).toBeUndefined();
      expect(await store.get({ kind: "review", key: "20260827-artifact-store" })).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("get on malformed JSON throws with the file path (readJson contract)", async () => {
    const root = tmpRoot("store-malformed-");
    try {
      mkdirSync(join(root, "workflows", "wf-1"), { recursive: true });
      writeFileSync(join(root, "workflows", "wf-1", "snapshot.json"), "{ not json", "utf8");
      const store = createFsStore(root);
      await expect(store.get({ kind: "snapshot", key: "wf-1" })).rejects.toThrow(
        /Invalid JSON in .*workflows[\\/]wf-1[\\/]snapshot\.json/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("delete removes the artifact; get returns undefined afterwards", async () => {
    const root = tmpRoot("store-delete-");
    try {
      const store = createFsStore(root);
      await store.put({ kind: "status", key: "root", payload: { version: 2, updated_at: "2026-08-27", workflows: [] } });
      expect(await store.get({ kind: "status", key: "root" })).toBeDefined();
      await store.delete?.({ kind: "status", key: "root" });
      expect(await store.get({ kind: "status", key: "root" })).toBeUndefined();
      // deleting a missing artifact is a no-op
      await store.delete?.({ kind: "status", key: "root" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Schema guard — store-contract-completion D3 (fail-loud on doc.schema)
// ---------------------------------------------------------------------------

/** Canonical rejection message (single home: spec store-contract-completion
 * § D3 — do not reword). Source escapes the em-dash per lint:ascii-literals. */
const SCHEMA_GUARD_MESSAGE =
  "FsStore does not persist schema ids \u2014 omit --schema or inject a store module that persists it";

describe("FsStore schema guard (D3)", () => {
  test("doc carrying an envelope schema is rejected with the canonical message and no file is written", async () => {
    const root = tmpRoot("store-schema-guard-");
    try {
      const store = createFsStore(root);
      const doc: ArtifactDoc = {
        kind: "review",
        key: "r-1",
        payload: { verdict: "approve" },
        schema: "mstar.review/v1",
      };
      await expect(store.put(doc)).rejects.toThrow(SCHEMA_GUARD_MESSAGE);
      // Fail-loud means refuse-before-write: nothing may land on disk.
      expect(existsSync(resolveArtifactPath(root, doc))).toBe(false);
      expect(await store.get({ kind: "review", key: "r-1" })).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("doc without schema puts unchanged (payload written verbatim)", async () => {
    const root = tmpRoot("store-schema-absent-");
    try {
      const store = createFsStore(root);
      const payload = { version: 2, updated_at: "2026-08-28", workflows: [] };
      await store.put({ kind: "status", key: "root", payload });
      const got = await store.get({ kind: "status", key: "root" });
      expect(got).toEqual(payload);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("review payload with inner schema field still writes (payload.schema is data, not doc.schema)", async () => {
    const root = tmpRoot("store-payload-schema-");
    try {
      const store = createFsStore(root);
      const ref = { kind: "review", key: "20260828-store-engine-contract" } as const;
      const payload = { schema: "mstar.review/v1", verdict: "approve", findings: [] };
      await store.put({ ...ref, payload });
      const got = await store.get(ref);
      expect(got).toEqual(payload);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// list? enumeration — store-contract-completion D4 (FsStore per-kind table)
// ---------------------------------------------------------------------------

/** Canonical json non-enumerable message (single home: spec
 * store-contract-completion § D4 — do not reword). */
const LIST_JSON_MESSAGE = "ArtifactStore json keys are absolute paths and cannot be listed";

describe("FsStore list (D4)", () => {
  test("status lists [root] iff status.json exists; absent file \u2192 []", async () => {
    const root = tmpRoot("store-list-status-");
    try {
      const store = createFsStore(root);
      expect(await store.list!("status")).toEqual([]);
      const payload = { version: 2, updated_at: "2026-08-28", workflows: [] };
      await store.put({ kind: "status", key: "root", payload });
      expect(await store.list!("status")).toEqual([{ kind: "status", key: "root" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("snapshot lists workflow dirs with snapshot.json, ascending; stray dirs/files excluded; missing backing \u2192 []", async () => {
    const root = tmpRoot("store-list-snapshot-");
    try {
      const store = createFsStore(root);
      expect(await store.list!("snapshot")).toEqual([]);
      await store.put({ kind: "snapshot", key: "wf-2", payload: { id: "wf-2" } });
      await store.put({ kind: "snapshot", key: "wf-10", payload: { id: "wf-10" } });
      // Stray subdir without snapshot.json and a loose file: never listed.
      mkdirSync(join(root, "workflows", "wf-empty"));
      writeFileSync(join(root, "workflows", "stray.json"), "{}", "utf8");
      // Ascending means lexicographic by key (wf-10 < wf-2), never numeric.
      expect(await store.list!("snapshot")).toEqual([
        { kind: "snapshot", key: "wf-10" },
        { kind: "snapshot", key: "wf-2" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("residuals lists project dirs with residuals.json, ascending; stray dirs excluded; missing backing \u2192 []", async () => {
    const root = tmpRoot("store-list-residuals-");
    try {
      const store = createFsStore(root);
      expect(await store.list!("residuals")).toEqual([]);
      await store.put({ kind: "residuals", key: "proj-1", payload: { entries: [] } });
      await store.put({ kind: "residuals", key: "_default", payload: { entries: [] } });
      mkdirSync(join(root, "projects", "no-register"));
      expect(await store.list!("residuals")).toEqual([
        { kind: "residuals", key: "_default" },
        { kind: "residuals", key: "proj-1" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("review union lists _reviews flat keys + plan-shaped dirs with report.json, ascending; non-qualifying entries excluded", async () => {
    const root = tmpRoot("store-list-review-");
    try {
      const store = createFsStore(root);
      expect(await store.list!("review")).toEqual([]); // missing sdd backing
      await store.put({ kind: "review", key: "review-inline", payload: { verdict: "approve" } });
      await store.put({ kind: "review", key: "20260828-store-engine", payload: { verdict: "approve" } });
      // Plan-shaped dir without report.json: not listed (no backing).
      mkdirSync(join(root, "sdd", "20260828-empty-plan"), { recursive: true });
      // Non-plan-shaped dir directly under sdd: not part of the union.
      mkdirSync(join(root, "sdd", "scratch"));
      expect(await store.list!("review")).toEqual([
        { kind: "review", key: "20260828-store-engine" },
        { kind: "review", key: "review-inline" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("review: a plan-shaped _reviews file is not listed (get would route elsewhere) until the plan dir exists \u2014 then exactly once", async () => {
    const root = tmpRoot("store-list-review-guard-");
    try {
      const store = createFsStore(root);
      mkdirSync(join(root, "sdd", "_reviews"), { recursive: true });
      writeFileSync(join(root, "sdd", "_reviews", "20260828-orphan.json"), "{}", "utf8");
      // Empty case: existing but non-qualifying backing → [].
      expect(await store.list!("review")).toEqual([]);
      await store.put({ kind: "review", key: "20260828-orphan", payload: { verdict: "approve" } });
      expect(await store.list!("review")).toEqual([{ kind: "review", key: "20260828-orphan" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every listed key across kinds round-trips through get (D4 uniform rule)", async () => {
    const root = tmpRoot("store-list-roundtrip-");
    try {
      const store = createFsStore(root);
      const payloads: Record<string, unknown> = {
        status: { version: 2, updated_at: "2026-08-28", workflows: [] },
        snapshot: { id: "wf-1" },
        residuals: { entries: [] },
        review: { verdict: "approve" },
      };
      await store.put({ kind: "status", key: "root", payload: payloads.status });
      await store.put({ kind: "snapshot", key: "wf-1", payload: payloads.snapshot });
      await store.put({ kind: "residuals", key: "proj-1", payload: payloads.residuals });
      await store.put({ kind: "review", key: "20260828-store-engine", payload: payloads.review });
      await store.put({ kind: "review", key: "review-inline", payload: payloads.review });
      for (const kind of ["status", "snapshot", "residuals", "review"] as const) {
        for (const ref of await store.list!(kind)) {
          // Intermediate variable: a nested `expect(await store.get(...))` lets
          // TS infer the get<T> type parameter from the expect overload (never)
          // — assign first, then assert.
          const got = await store.get(ref);
          expect(got).toEqual(payloads[kind]);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("json kind throws the canonical usage error", async () => {
    const root = tmpRoot("store-list-json-");
    try {
      const store = createFsStore(root);
      await expect(store.list!("json")).rejects.toThrow(LIST_JSON_MESSAGE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("optional-member absence: a store with only put/get stays a valid ArtifactStore (D1-adapter class declines)", () => {
    const store = recordingStore();
    setArtifactStore(store);
    const active = getArtifactStore();
    expect(active).toBe(store);
    expect(active.delete).toBeUndefined();
    expect(active.list).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Key discipline — SP2 § Architecture decisions 4
// ---------------------------------------------------------------------------

describe("FsStore key discipline", () => {
  test("status key must be \"root\"", async () => {
    const root = tmpRoot("store-status-key-");
    try {
      const store = createFsStore(root);
      await expect(store.put({ kind: "status", key: "not-root", payload: {} })).rejects.toThrow(
        /status key must be "root"/,
      );
      await expect(store.get({ kind: "status", key: "not-root" })).rejects.toThrow(/status key must be "root"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unsafe keys are rejected by assertSafePathComponent before mapping", async () => {
    const root = tmpRoot("store-unsafe-key-");
    try {
      const store = createFsStore(root);
      for (const key of ["../evil", "a/b", "", ".", ".."]) {
        await expect(store.put({ kind: "snapshot", key, payload: {} })).rejects.toThrow(/single safe path component/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// json escape hatch — SP2 § Default FsStore (absolute path; reject .. / non-absolute)
// ---------------------------------------------------------------------------

describe("FsStore json escape hatch", () => {
  test("absolute key round-trips to the caller-supplied path", async () => {
    const root = tmpRoot("store-json-ok-");
    try {
      const store = createFsStore(root);
      const target = join(root, "out", "doc.json");
      await store.put({ kind: "json", key: target, payload: { note: "escape hatch" } });
      expect(existsSync(target)).toBe(true);
      const got = await store.get({ kind: "json", key: target });
      expect(got).toEqual({ note: "escape hatch" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-absolute key is rejected", async () => {
    const root = tmpRoot("store-json-rel-");
    try {
      const store = createFsStore(root);
      await expect(store.put({ kind: "json", key: "relative/path.json", payload: {} })).rejects.toThrow(
        /json key must be an absolute path/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("key with a \"..\" segment is rejected", async () => {
    const root = tmpRoot("store-json-dotdot-");
    try {
      const store = createFsStore(root);
      // join() would normalize the ".." away — build the key literally.
      await expect(store.put({ kind: "json", key: `${root}/../escape.json`, payload: {} })).rejects.toThrow(
        /must not contain "\.\." segments/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Injection — SP2 § Injection 1 + § Architecture decisions 5
// ---------------------------------------------------------------------------

describe("setArtifactStore / getArtifactStore", () => {
  test("getArtifactStore returns the injected store while set", () => {
    const store = recordingStore();
    setArtifactStore(store);
    expect(getArtifactStore()).toBe(store);
  });

  test("setArtifactStore(undefined) resets to the default FsStore", async () => {
    const root = tmpRoot("store-default-");
    try {
      setArtifactStore(recordingStore());
      setArtifactStore(undefined);
      await withEnv(root, async () => {
        const store = getArtifactStore();
        const payload = { version: 2, updated_at: "2026-08-27", workflows: [] };
        await store.put({ kind: "status", key: "root", payload });
        const got = await store.get({ kind: "status", key: "root" });
        expect(got).toEqual(payload);
        expect(existsSync(join(root, "status.json"))).toBe(true);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("default store resolves the harness root from MSTAR_HARNESS_DIR", async () => {
    const root = tmpRoot("store-default-env-");
    try {
      await withEnv(root, async () => {
        const store = getArtifactStore();
        const payload = { version: 2, updated_at: "2026-08-27", workflows: [] };
        await store.put({ kind: "status", key: "root", payload });
        expect(existsSync(join(root, "status.json"))).toBe(true);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("getArtifactStore throws fail-loud when no harness dir resolves", () => {
    const root = tmpRoot("store-no-harness-");
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      expect(() => getArtifactStore()).toThrow(/harness dir not found from .* cannot create the default FsStore/);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

// ---------------------------------------------------------------------------
// assertFsStorePath — fail-loud path agreement (qc3 F-201)
// ---------------------------------------------------------------------------

describe("assertFsStorePath - fail-loud path agreement (qc3 F-201)", () => {
  test("FsStore with the store-resolved path equal to the expected path passes", () => {
    const root = tmpRoot("store-assert-ok-");
    try {
      const store = createFsStore(root);
      expect(() => assertFsStorePath(store, { kind: "status", key: "root" }, join(root, "status.json"))).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("FsStore with a diverging expected path throws naming both paths", () => {
    const root = tmpRoot("store-assert-mismatch-");
    const other = tmpRoot("store-assert-other-");
    try {
      const store = createFsStore(root);
      const target = join(other, "status.json");
      let caught: Error | undefined;
      try {
        assertFsStorePath(store, { kind: "status", key: "root" }, target);
      } catch (error) {
        caught = error as Error;
      }
      expect(caught?.message).toMatch(/routed writer path mismatch: the active FsStore resolves status\/"root"/);
      expect(caught?.message).toContain(target);
      expect(caught?.message).toContain(join(root, "status.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("custom (non-FS) stores are skipped - the caller owns the mapping", () => {
    expect(() => assertFsStorePath(recordingStore(), { kind: "status", key: "root" }, "/anywhere/status.json")).not.toThrow();
  });
});
// loadStoreModule — SP2 § Injection 2–3 + SP2-AC6 / SP2-AC7 (trust boundary)
// ---------------------------------------------------------------------------

describe("loadStoreModule", () => {
  test("loads a module with a createArtifactStore named export", async () => {
    const dir = tmpRoot("store-module-named-");
    try {
      const filePath = join(dir, "store-mod.ts");
      writeFileSync(
        filePath,
        [
          "export function createArtifactStore() {",
          "  const docs = new Map();",
          "  return {",
          "    async put(doc) { docs.set(doc.key, doc.payload); },",
          "    async get(ref) { return docs.get(ref.key); },",
          "  };",
          "}",
        ].join("\n"),
        "utf8",
      );
      const store = await loadStoreModule(filePath);
      const payload = { version: 2, updated_at: "2026-08-27", workflows: [] };
      await store.put({ kind: "status", key: "root", payload });
      // Intermediate variable: a nested `expect(await store.get(...))` lets
      // TS infer get<T> from the expect overload (never) — assign first.
      const gotStatus = await store.get({ kind: "status", key: "root" });
      expect(gotStatus).toEqual(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads a module with a default-exported factory", async () => {
    const dir = tmpRoot("store-module-default-fn-");
    try {
      const filePath = join(dir, "store-mod.ts");
      writeFileSync(
        filePath,
        [
          "export default function createArtifactStore() {",
          "  const docs = new Map();",
          "  return {",
          "    async put(doc) { docs.set(doc.key, doc.payload); },",
          "    async get(ref) { return docs.get(ref.key); },",
          "  };",
          "}",
        ].join("\n"),
        "utf8",
      );
      const store = await loadStoreModule(filePath);
      const payload = { note: "default factory" };
      await store.put({ kind: "snapshot", key: "wf-1", payload });
      const gotSnapshot = await store.get({ kind: "snapshot", key: "wf-1" });
      expect(gotSnapshot).toEqual(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads a module with a default-exported store object", async () => {
    const dir = tmpRoot("store-module-default-obj-");
    try {
      const filePath = join(dir, "store-mod.ts");
      writeFileSync(
        filePath,
        [
          "const docs = new Map();",
          "export default {",
          "  async put(doc) { docs.set(doc.key, doc.payload); },",
          "  async get(ref) { return docs.get(ref.key); },",
          "};",
        ].join("\n"),
        "utf8",
      );
      const store = await loadStoreModule(filePath);
      const payload = { note: "default object" };
      await store.put({ kind: "residuals", key: "proj-1", payload });
      const gotResiduals = await store.get({ kind: "residuals", key: "proj-1" });
      expect(gotResiduals).toEqual(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads a CommonJS module via the default interop (module.exports)", async () => {
    const dir = tmpRoot("store-module-cjs-");
    try {
      const filePath = join(dir, "store-mod.cjs");
      writeFileSync(
        filePath,
        [
          "module.exports = {",
          "  async put(doc) {},",
          "  async get() { return undefined; },",
          "};",
        ].join("\n"),
        "utf8",
      );
      const store = await loadStoreModule(filePath);
      expect(typeof store.put).toBe("function");
      expect(typeof store.get).toBe("function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an empty module path", async () => {
    await expect(loadStoreModule("")).rejects.toThrow(/module path must not be empty/);
  });

  test("rejects URI schemes before import (http / https / file / data / node)", async () => {
    for (const modulePath of [
      "http://example.com/store.mjs",
      "https://example.com/store.mjs",
      "file:///tmp/store.mjs",
      "data:text/javascript,export default {}",
      "node:fs",
    ]) {
      await expect(loadStoreModule(modulePath)).rejects.toThrow(/only filesystem paths are allowed/);
    }
  });

  test("throws when the module file is missing", async () => {
    const dir = tmpRoot("store-module-missing-");
    try {
      const missing = join(dir, "does-not-exist.ts");
      await expect(loadStoreModule(missing)).rejects.toThrow(/module file not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws when the module has no store export", async () => {
    const dir = tmpRoot("store-module-noexport-");
    try {
      const filePath = join(dir, "store-mod.ts");
      writeFileSync(filePath, "export const unrelated = 42;\n", "utf8");
      await expect(loadStoreModule(filePath)).rejects.toThrow(/does not export an ArtifactStore/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws when the default export is not a store shape", async () => {
    const dir = tmpRoot("store-module-shape-");
    try {
      const filePath = join(dir, "store-mod.ts");
      writeFileSync(filePath, "export default { put: \"not a function\" };\n", "utf8");
      await expect(loadStoreModule(filePath)).rejects.toThrow(/does not export an ArtifactStore/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
