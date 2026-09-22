/**
 * Engine artifact store — ArtifactStore contract + FsStore + injection.
 *
 * Spec sources (each test cites the section it enforces; roadmap §8.5 C2
 * — engine unit tests cover each contract area):
 * - Contract + FsStore path table + key discipline + async-only store
 * (async-only, locks stay with callers, single path table, key
 * discipline, default store resolution).
 * - Review path table (plan-shaped → `{HARNESS_DIR}/sdd/<key>/review/
 * report.json`, other keys → `{HARNESS_DIR}/sdd/_reviews/<key>.json`) —
 * product-locked.
 * - `json` escape hatch (absolute path only; reject `..` / non-absolute)
 * — not a user-facing acceptance criterion.
 * - Default store resolution (`setArtifactStore(undefined)` resets; a
 * `null` harness-dir resolution throws fail-loud, never a silent cwd
 * fallback).
 * - Module loader (`loadStoreModule` — named export / default factory /
 * default object; URI-scheme rejection before import; missing file and
 * non-store shape throw).
 * - `put` schema guard (throw on `doc.schema !== undefined`, canonical
 * message; `payload.schema` unaffected).
 * - Protected-write authorization seam (§C4): every FsStore write below runs
 * inside `withProtectedWrite`, the private context the locked coordination
 * writers open, so the read/write/delete and path-guard coverage stays
 * truthful against the authorization the boundary now requires.
 * - Injected-store canonical control-target guard (retained-body contract): an
 * injected non-FsStore refuses the protected control targets (root register,
 * workflow snapshot, and a `json` alias of either) while the CANONICAL control
 * authority is active — before its own method runs, judged against a root the
 * injector's `root` claim cannot establish — and it refuses the retired
 * project register unconditionally (the stale runtime kind, and a `json` alias
 * of the register). The wrapper exposes no `root` at all: a custom adapter's
 * claim is not the FsStore capability the path-agreement check and the direct
 * CAS/versioned consumers verify against. Body refs still round-trip, optional
 * members stay absent when declined, and the pre-activation route is
 * unchanged.
 * - `list?` interface + FsStore enumeration (exists-conditional status,
 * snapshot dir scans through the single path table, review
 * union with the one PLAN_SHAPED_KEY_RE detector, json non-enumerable,
 * `[]` on missing backing, sorted ascending, listed keys round-trip
 * through `get`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  type ArtifactKind,
  type ArtifactRef,
  type ArtifactStore,
} from "../src/store.js";
import { withProtectedWrite } from "../src/coordination-write.js";
import { initializeExecutionAuthority } from "../src/execution-store.js";
import { initializeStore } from "../src/store-db.js";

const ENV_KEY = "MSTAR_HARNESS_DIR";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Run `fn` with `MSTAR_HARNESS_DIR` set to `value` (undefined deletes it),
 * restoring the previous env in all paths. Caller rule : `fn`
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

/** Recording store for the injection tests (recording-store pattern). */
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

/** Recording store for the injected-store guard cases: every data port is
 * recorded, and an arbitrary `root` claim can be attached (a custom store names
 * its own root — the guard must not read it as authority). */
function probeStore(
  rootClaim?: string,
): ArtifactStore & { root?: string; puts: ArtifactDoc[]; gets: ArtifactRef[]; deletes: ArtifactRef[] } {
  const puts: ArtifactDoc[] = [];
  const gets: ArtifactRef[] = [];
  const deletes: ArtifactRef[] = [];
  const store: ArtifactStore & {
    root?: string;
    puts: ArtifactDoc[];
    gets: ArtifactRef[];
    deletes: ArtifactRef[];
  } = {
    puts,
    gets,
    deletes,
    async put(doc: ArtifactDoc): Promise<void> {
      puts.push(doc);
    },
    async get(ref: ArtifactRef): Promise<undefined> {
      gets.push(ref);
      return undefined;
    },
    async delete(ref: ArtifactRef): Promise<void> {
      deletes.push(ref);
    },
  };
  if (rootClaim !== undefined) store.root = rootClaim;
  return store;
}

/** Map-backed injected store: a body store that really round-trips. */
function memoryStore(): ArtifactStore {
  const docs = new Map<string, unknown>();
  return {
    async put(doc: ArtifactDoc): Promise<void> {
      docs.set(`${doc.kind}:${doc.key}`, doc.payload);
    },
    async get<T = unknown>(ref: ArtifactRef): Promise<T | undefined> {
      return docs.get(`${ref.kind}:${ref.key}`) as T | undefined;
    },
    async list(kind: ArtifactKind): Promise<ArtifactRef[]> {
      return [...docs.keys()]
        .filter((entry) => entry.startsWith(`${kind}:`))
        .map((entry) => ({ kind, key: entry.slice(kind.length + 1) }));
    },
  };
}

/** A control root holding a store whose execution authority is still `legacy`
 * (its schema has the execution tables; nothing was activated). */
async function legacyControlRoot(label: string): Promise<string> {
  const root = tmpRoot(label);
  const handle = await initializeStore({ harnessDir: root });
  handle.close();
  return root;
}

/** A control root whose execution authority is ACTIVE — the authority an
 * injected store's protected targets must be judged against. */
async function activeControlRoot(label: string): Promise<string> {
  const root = await legacyControlRoot(label);
  await initializeExecutionAuthority({ harnessDir: root });
  return root;
}

/**
 * A writer view of the FsStore: every call runs inside the same private
 * authorization context the locked coordination writers open (spec §C4). A
 * protected document — `status.json` or a workflow `snapshot.json`, directly
 * or through a `json` alias — may only be written from that context, so a
 * bare `store.put`/`store.delete` is refused; the unprotected kinds
 * (`review`, unrelated `json`) are unaffected by it. The retired register
 * kind refuses everywhere (issue authority), inside or outside the context.
 * This
 * keeps the file's read/write/delete, alias-classification and path-guard
 * coverage intact against the authorization the boundary requires.
 */
function authorizedStore(store: ArtifactStore & { root: string }): ArtifactStore & { root: string } {
  return {
    root: store.root,
    async put(doc: ArtifactDoc): Promise<void> {
      await withProtectedWrite(resolveArtifactPath(store.root, doc), "put", () => store.put(doc));
    },
    get: (ref) => store.get(ref),
    async delete(ref: ArtifactRef): Promise<void> {
      await withProtectedWrite(resolveArtifactPath(store.root, ref), "delete", () => store.delete?.(ref) ?? Promise.resolve());
    },
    list: (kind) => store.list!(kind),
  };
}

/**
 * Narrow `delete` to its required form for the protected-kind probes:
 * `ArtifactStore.delete` is optional (read-only stores omit the port), the
 * FsStore under test implements it, and a missing port must fail the probe
 * loudly instead of being read as a refused write.
 */
function requiredDelete(store: ArtifactStore): (ref: ArtifactRef) => Promise<void> {
  const remove = store.delete;
  if (remove === undefined) throw new Error("the FsStore under test must implement delete");
  return (ref) => remove.call(store, ref);
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
// FsStore path mapping (single kind→path table)
// ---------------------------------------------------------------------------

describe("createFsStore path mapping", () => {
  test("status maps to {HARNESS_DIR}/status.json", async () => {
    const root = tmpRoot("store-status-");
    try {
      const store = authorizedStore(createFsStore(root));
      await store.put({ kind: "status", key: "root", payload: { version: 2, updated_at: "2026-08-27", workflows: [] } });
      expect(existsSync(join(root, "status.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("snapshot maps to {WORKFLOW_DIR}/<key>/snapshot.json", async () => {
    const root = tmpRoot("store-snapshot-");
    try {
      const store = authorizedStore(createFsStore(root));
      await store.put({ kind: "snapshot", key: "wf-1", payload: { id: "wf-1" } });
      expect(existsSync(join(root, "workflows", "wf-1", "snapshot.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("issue authority: the retired residuals kind is refused, never mapped", async () => {
    const root = tmpRoot("store-residuals-");
    try {
      const store = authorizedStore(createFsStore(root));
      expect(
        store.put({ kind: "residuals", key: "proj-1", payload: { entries: [] } } as never),
      ).rejects.toThrow(/no longer persists project registers/);
      expect(existsSync(join(root, "projects", "proj-1", "residuals.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("review plan-shaped key maps to {HARNESS_DIR}/sdd/<key>/review/report.json", async () => {
    const root = tmpRoot("store-review-plan-");
    try {
      const store = authorizedStore(createFsStore(root));
      await store.put({ kind: "review", key: "20260827-artifact-store", payload: { verdict: "approve" } });
      expect(existsSync(join(root, "sdd", "20260827-artifact-store", "review", "report.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("review non-plan-shaped key maps to {HARNESS_DIR}/sdd/_reviews/<key>.json", async () => {
    const root = tmpRoot("store-review-other-");
    try {
      const store = authorizedStore(createFsStore(root));
      await store.put({ kind: "review", key: "review-abc", payload: { verdict: "approve" } });
      expect(existsSync(join(root, "sdd", "_reviews", "review-abc.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("review key with date prefix but no plan suffix is not plan-shaped", async () => {
    const root = tmpRoot("store-review-date-");
    try {
      const store = authorizedStore(createFsStore(root));
      await store.put({ kind: "review", key: "20260827", payload: { verdict: "approve" } });
      expect(existsSync(join(root, "sdd", "_reviews", "20260827.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("snapshot honors .mstarc workflow_dir overrides", async () => {
    const root = tmpRoot("store-mstarc-");
    try {
      writeFileSync(join(root, ".mstarc"), "[config]\nworkflow_dir=wf-custom\nproject_dir=proj-custom\n");
      const store = authorizedStore(createFsStore(root));
      await store.put({ kind: "snapshot", key: "wf-1", payload: { id: "wf-1" } });
      expect(existsSync(join(root, "wf-custom", "wf-1", "snapshot.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Round-trip (put then get returns the payload; missing → undefined)
// ---------------------------------------------------------------------------

describe("FsStore round-trip", () => {
  test("status / snapshot / review put then get returns the payload", async () => {
    const root = tmpRoot("store-roundtrip-");
    try {
      const store = authorizedStore(createFsStore(root));
      const status = { version: 2, updated_at: "2026-08-27", workflows: [] };
      const snapshot = { id: "wf-1", status: "in_progress" };
      const review = { verdict: "approve" };
      await store.put({ kind: "status", key: "root", payload: status });
      await store.put({ kind: "snapshot", key: "wf-1", payload: snapshot });
      await store.put({ kind: "review", key: "20260827-artifact-store", payload: review });
 // Intermediate variables: a nested `expect(await store.get(...))` lets
 // TS infer the get<T> type parameter from the expect overload (never)
 // and narrows the actual to undefined — assign first, then assert.
      const gotStatus = await store.get({ kind: "status", key: "root" });
      const gotSnapshot = await store.get({ kind: "snapshot", key: "wf-1" });
      const gotReview = await store.get({ kind: "review", key: "20260827-artifact-store" });
      expect(gotStatus).toEqual(status);
      expect(gotSnapshot).toEqual(snapshot);
      expect(gotReview).toEqual(review);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("get on a missing artifact returns undefined", async () => {
    const root = tmpRoot("store-missing-");
    try {
      const store = authorizedStore(createFsStore(root));
      expect(await store.get({ kind: "status", key: "root" })).toBeUndefined();
      expect(await store.get({ kind: "snapshot", key: "wf-1" })).toBeUndefined();
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
      const store = authorizedStore(createFsStore(root));
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
      const store = authorizedStore(createFsStore(root));
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
      const store = authorizedStore(createFsStore(root));
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
      const store = authorizedStore(createFsStore(root));
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
      const store = authorizedStore(createFsStore(root));
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
      const store = authorizedStore(createFsStore(root));
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
      const store = authorizedStore(createFsStore(root));
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

  test("issue authority: list refuses the retired residuals kind", async () => {
    const root = tmpRoot("store-list-residuals-");
    try {
      const store = authorizedStore(createFsStore(root));
      expect(() => store.list!("residuals" as never)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("review union lists _reviews flat keys + plan-shaped dirs with report.json, ascending; non-qualifying entries excluded", async () => {
    const root = tmpRoot("store-list-review-");
    try {
      const store = authorizedStore(createFsStore(root));
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
      const store = authorizedStore(createFsStore(root));
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

  test("snapshot: a stray unsafe dir name is skipped without throwing, never advertised", async () => {
    const root = tmpRoot("store-list-unsafe-dir-");
    try {
      const store = authorizedStore(createFsStore(root));
      await store.put({ kind: "snapshot", key: "wf-1", payload: { id: "wf-1" } });
 // Unsafe name (space) WITH a backing snapshot.json: skipped for the
 // name itself — a get on such a key would throw, so list must not
 // advertise it (and must not throw either).
      mkdirSync(join(root, "workflows", "bad name"), { recursive: true });
      writeFileSync(join(root, "workflows", "bad name", "snapshot.json"), "{}", "utf8");
      expect(await store.list!("snapshot")).toEqual([{ kind: "snapshot", key: "wf-1" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("review: an unsafe _reviews filename is skipped without throwing, never advertised", async () => {
    const root = tmpRoot("store-list-unsafe-review-");
    try {
      const store = authorizedStore(createFsStore(root));
      await store.put({ kind: "review", key: "review-inline", payload: { verdict: "approve" } });
 // Garbage flat filename: advertised pre-fix, then get threw.
      writeFileSync(join(root, "sdd", "_reviews", "bad name.json"), "{}", "utf8");
      expect(await store.list!("review")).toEqual([{ kind: "review", key: "review-inline" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every listed key across kinds round-trips through get (D4 uniform rule)", async () => {
    const root = tmpRoot("store-list-roundtrip-");
    try {
      const store = authorizedStore(createFsStore(root));
      const payloads: Record<string, unknown> = {
        status: { version: 2, updated_at: "2026-08-28", workflows: [] },
        snapshot: { id: "wf-1" },
        review: { verdict: "approve" },
      };
      await store.put({ kind: "status", key: "root", payload: payloads.status });
      await store.put({ kind: "snapshot", key: "wf-1", payload: payloads.snapshot });
      await store.put({ kind: "review", key: "20260828-store-engine", payload: payloads.review });
      await store.put({ kind: "review", key: "review-inline", payload: payloads.review });
      for (const kind of ["status", "snapshot", "review"] as const) {
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
      const store = authorizedStore(createFsStore(root));
      await expect(store.list!("json")).rejects.toThrow(LIST_JSON_MESSAGE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a readdir ENOENT/ENOTDIR 'path gone' race maps to [], never throws out of list (greptile P1)", async () => {
    const root = tmpRoot("store-list-race-");
    try {
      const store = authorizedStore(createFsStore(root));
 // Deterministic stand-in for the existsSync→readdirSync race: a
 // regular file where the backing dir is expected makes readdirSync
 // throw ENOTDIR — the same "path gone" class as ENOENT when the dir
 // vanishes between check and read. Pre-fix list threw; post-fix [].
      writeFileSync(join(root, "workflows"), "not a dir", "utf8");
      expect(await store.list!("snapshot")).toEqual([]);
 // Same for the review union: sdd/_reviews as a file.
      mkdirSync(join(root, "sdd"), { recursive: true });
      writeFileSync(join(root, "sdd", "_reviews"), "not a dir", "utf8");
      expect(await store.list!("review")).toEqual([]);
 // ENOENT proper: the whole backing tree removed after store
 // creation — readdirSync throws ENOENT with no existsSync pre-check.
      rmSync(root, { recursive: true, force: true });
      expect(await store.list!("snapshot")).toEqual([]);
      expect(await store.list!("review")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("optional-member absence: a store with only put/get stays a valid ArtifactStore (D1-adapter class declines)", async () => {
    const store = recordingStore();
    setArtifactStore(store);
    const active = getArtifactStore();
    // The guard wraps the data ports; the optional members the injected store
    // declines are not invented, and the body document is still that store's to
    // persist (a review body is not a control target).
    expect(active.delete).toBeUndefined();
    expect(active.list).toBeUndefined();
    await active.put({ kind: "review", key: "review-declining", payload: { verdict: "approve" } });
    expect(store.puts.map((doc) => doc.key)).toEqual(["review-declining"]);
  });
});

// ---------------------------------------------------------------------------
// Key discipline
// ---------------------------------------------------------------------------

describe("FsStore key discipline", () => {
  test("status key must be \"root\"", async () => {
    const root = tmpRoot("store-status-key-");
    try {
      const store = authorizedStore(createFsStore(root));
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
      const store = authorizedStore(createFsStore(root));
      for (const key of ["../evil", "a/b", "", ".", ".."]) {
        await expect(store.put({ kind: "snapshot", key, payload: {} })).rejects.toThrow(/single safe path component/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// json escape hatch (absolute path; reject .. / non-absolute)
// ---------------------------------------------------------------------------

describe("FsStore json escape hatch", () => {
  test("absolute key round-trips to the caller-supplied path", async () => {
    const root = tmpRoot("store-json-ok-");
    try {
      const store = authorizedStore(createFsStore(root));
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
      const store = authorizedStore(createFsStore(root));
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
      const store = authorizedStore(createFsStore(root));
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
// Injection
// ---------------------------------------------------------------------------

describe("setArtifactStore / getArtifactStore", () => {
  test("the active store serves the injected store's body port while set", async () => {
    const store = recordingStore();
    setArtifactStore(store);
    // The injected instance is what the accessor serves — not the default
    // FsStore. Its protected targets are guarded (see the injected-store guard
    // cases), and a body document is still its document to persist.
    await getArtifactStore().put({ kind: "review", key: "review-served", payload: { verdict: "approve" } });
    expect(store.puts.map((doc) => doc.key)).toEqual(["review-served"]);
  });

  test("setArtifactStore(undefined) resets to the default FsStore", async () => {
    const root = tmpRoot("store-default-");
    try {
      setArtifactStore(recordingStore());
      setArtifactStore(undefined);
      await withEnv(root, async () => {
        const store = authorizedStore(getArtifactStore() as ArtifactStore & { root: string });
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
        const store = authorizedStore(getArtifactStore() as ArtifactStore & { root: string });
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
// Injected store — canonical control-target guard (retained-body contract)
// ---------------------------------------------------------------------------

/**
 * Every call below runs inside `withEnv(<control root>)` so the guard resolves
 * a fixture authority instead of whatever harness the test runner's cwd happens
 * to sit in. The guard runs in the call's SYNCHRONOUS prologue — the env window
 * therefore covers the call expression itself, and the returned promise is
 * awaited outside it.
 *
 * The cases encode the boundary: an injected store is a body store. While the
 * CANONICAL CONTROL root's execution authority is ACTIVE, the protected control
 * documents (root register, workflow snapshot, and a `json` alias of either)
 * refuse before the injected method runs; the injector's own `root` claim can
 * neither establish that authority nor a refusal; body refs still round-trip.
 */
describe("injected ArtifactStore \u2014 canonical control-target guard", () => {
  test("an injected store cannot reach a protected target while the canonical authority is active", async () => {
    const root = await activeControlRoot("injected-guard-protected-");
    try {
      const store = probeStore();
      setArtifactStore(store);
      const active = getArtifactStore();

      const putStatus = withEnv(root, () =>
        active.put({ kind: "status", key: "root", payload: { version: 2, updated_at: "2026-09-22", workflows: [] } }),
      );
      await expect(putStatus).rejects.toMatchObject({ code: "execution.direct-write-refused" });
      const getStatus = withEnv(root, () => active.get({ kind: "status", key: "root" }));
      await expect(getStatus).rejects.toMatchObject({ code: "execution.consumer-not-ready" });
      const deleteStatus = withEnv(root, () => active.delete!({ kind: "status", key: "root" }));
      await expect(deleteStatus).rejects.toMatchObject({ code: "execution.direct-write-refused" });

      const putSnapshot = withEnv(root, () => active.put({ kind: "snapshot", key: "wf-1", payload: { id: "wf-1" } }));
      await expect(putSnapshot).rejects.toMatchObject({ code: "execution.direct-write-refused" });

      // A `json` alias of a protected file is the same class: the alias's
      // canonical target decides, not the name the caller used.
      mkdirSync(join(root, "workflows", "wf-1"), { recursive: true });
      writeFileSync(join(root, "workflows", "wf-1", "snapshot.json"), "{}\n", "utf8");
      const alias = join(root, "snapshot-alias.json");
      symlinkSync(join(root, "workflows", "wf-1", "snapshot.json"), alias);
      const putAlias = withEnv(root, () => active.put({ kind: "json", key: alias, payload: { probe: true } }));
      await expect(putAlias).rejects.toMatchObject({ code: "execution.direct-write-refused" });

      // Refuse BEFORE the injected callback: not one data port ran, and the
      // protected target's bytes are untouched by the refused alias write.
      expect(store.puts).toEqual([]);
      expect(store.gets).toEqual([]);
      expect(store.deletes).toEqual([]);
      expect(readFileSync(join(root, "workflows", "wf-1", "snapshot.json"), "utf8")).toEqual("{}\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an injected store's root claim cannot establish authority, in either direction", async () => {
    const root = await activeControlRoot("injected-guard-claim-");
    const noStore = tmpRoot("injected-guard-claim-nostore-");
    const foreign = await legacyControlRoot("injected-guard-claim-foreign-");
    try {
      // Every claim — none, a root with no authority, a FOREIGN harness root —
      // is judged against the canonical control authority, which is active.
      for (const store of [probeStore(), probeStore(noStore), probeStore(foreign)]) {
        setArtifactStore(store);
        const active = getArtifactStore();
        const attempt = withEnv(root, () =>
          active.put({ kind: "status", key: "root", payload: { version: 2, updated_at: "2026-09-22", workflows: [] } }),
        );
        await expect(attempt).rejects.toMatchObject({ code: "execution.direct-write-refused" });
        expect(store.puts).toEqual([]);
      }

      // The claim invents no refusal either: a store claiming an ACTIVE root
      // elsewhere leaves the declared route intact while the canonical control
      // authority is inactive.
      const claiming = probeStore(root);
      setArtifactStore(claiming);
      const claimedActive = getArtifactStore();
      const legacy = await legacyControlRoot("injected-guard-claim-legacy-");
      const allowed = withEnv(legacy, () =>
        claimedActive.put({ kind: "status", key: "root", payload: { version: 2, updated_at: "2026-09-22", workflows: [] } }),
      );
      await expect(allowed).resolves.toBeUndefined();
      expect(claiming.puts.map((doc) => doc.kind)).toEqual(["status"]);
      expect(existsSync(join(root, "status.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(noStore, { recursive: true, force: true });
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  test("body refs still round-trip through the injected store while the authority is active", async () => {
    const root = await activeControlRoot("injected-guard-bodies-");
    try {
      const store = memoryStore();
      setArtifactStore(store);
      const active = getArtifactStore();
      const review = { verdict: "approve", findings: [] };

      const putReview = withEnv(root, () =>
        active.put({ kind: "review", key: "20260922-injected-body", payload: review }),
      );
      await expect(putReview).resolves.toBeUndefined();
      const getReview = withEnv(root, () => active.get({ kind: "review", key: "20260922-injected-body" }));
      await expect(getReview).resolves.toEqual(review);
      const listReview = withEnv(root, () => active.list!("review"));
      await expect(listReview).resolves.toEqual([{ kind: "review", key: "20260922-injected-body" }]);

      // A document body outside the protected classes is an ordinary target.
      const body = join(root, "bodies", "doc.json");
      const putBody = withEnv(root, () => active.put({ kind: "json", key: body, payload: { note: "body" } }));
      await expect(putBody).resolves.toBeUndefined();
      const getBody = withEnv(root, () => active.get({ kind: "json", key: body }));
      await expect(getBody).resolves.toEqual({ note: "body" });

      // Nothing the injected store was asked to hold landed as a control file.
      expect(existsSync(join(root, "status.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an injected store keeps its declared route while the canonical authority is not active", async () => {
    const legacy = await legacyControlRoot("injected-guard-legacy-");
    const bare = tmpRoot("injected-guard-bare-");
    try {
      // `legacy` holds a store whose execution authority is not active; `bare`
      // holds no store file at all. Both keep the legacy route.
      for (const root of [legacy, bare]) {
        const store = probeStore();
        setArtifactStore(store);
        const active = getArtifactStore();
        const put = withEnv(root, () =>
          active.put({ kind: "status", key: "root", payload: { version: 2, updated_at: "2026-09-22", workflows: [] } }),
        );
        await expect(put).resolves.toBeUndefined();
        const get = withEnv(root, () => active.get({ kind: "snapshot", key: "wf-1" }));
        await expect(get).resolves.toBeUndefined();
        expect(store.puts.map((doc) => doc.kind)).toEqual(["status"]);
        expect(store.gets.map((ref) => ref.kind)).toEqual(["snapshot"]);
      }
    } finally {
      rmSync(legacy, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("an injected store cannot recreate, read or delete the retired project register", async () => {
    const root = await legacyControlRoot("injected-guard-register-");
    try {
      const store = probeStore();
      setArtifactStore(store);
      const active = getArtifactStore();

      // The stale runtime kind: refused on every data port, and — unlike the
      // protected control documents — refused whatever the execution state.
      const putKind = withEnv(root, () =>
        active.put({ kind: "residuals", key: "proj-1", payload: { entries: [] } } as never),
      );
      await expect(putKind).rejects.toThrow(/no longer persists project registers/);
      const getKind = withEnv(root, () => active.get({ kind: "residuals", key: "proj-1" } as never));
      await expect(getKind).rejects.toThrow(/no longer persists project registers/);
      const deleteKind = withEnv(root, () => active.delete!({ kind: "residuals", key: "proj-1" } as never));
      await expect(deleteKind).rejects.toThrow(/no longer persists project registers/);

      // A `json` alias is classified by its CANONICAL target: the register path
      // the project layer would use, the same path before it exists (a missing
      // leaf must not create one), and a symlink onto it.
      const register = join(root, "projects", "proj-1", "residuals.json");
      const missingLeaf = withEnv(root, () => active.put({ kind: "json", key: register, payload: { entries: [] } }));
      await expect(missingLeaf).rejects.toThrow(/project registers are retired migration history/);

      mkdirSync(join(root, "projects", "proj-1"), { recursive: true });
      writeFileSync(register, `${JSON.stringify({ entries: [] })}\n`, "utf8");
      const alias = join(root, "register-alias.json");
      symlinkSync(register, alias);
      const aliasRead = withEnv(root, () => active.get({ kind: "json", key: alias }));
      await expect(aliasRead).rejects.toThrow(/project registers are retired migration history/);
      const aliasDelete = withEnv(root, () => active.delete!({ kind: "json", key: alias }));
      await expect(aliasDelete).rejects.toThrow(/project registers are retired migration history/);

      // Refuse before the injected callback, and the planted register is intact.
      expect(store.puts).toEqual([]);
      expect(store.gets).toEqual([]);
      expect(store.deletes).toEqual([]);
      expect(existsSync(register)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an injected store's root claim is not exposed as an FsStore capability", async () => {
    const root = tmpRoot("injected-guard-rootcap-");
    const elsewhere = tmpRoot("injected-guard-rootcap-other-");
    try {
      const store = probeStore(root);
      setArtifactStore(store);
      const injected = getArtifactStore();
      // A custom adapter's `root` is a claim about a directory it may write
      // somewhere else entirely, so the active store exposes NO root: the
      // path-agreement check skips it (the adapter owns its own mapping) and the
      // direct byte/CAS and `--versioned` consumers find no FsStore capability.
      expect("root" in injected).toBe(false);
      expect(() => assertFsStorePath(injected, { kind: "status", key: "root" }, join(root, "status.json"))).not.toThrow();

      // The engine's own FsStore keeps the capability it is verified by: the
      // same diverging target is refused for it.
      setArtifactStore(createFsStore(elsewhere));
      expect("root" in getArtifactStore()).toBe(true);
      expect(() =>
        assertFsStorePath(getArtifactStore(), { kind: "status", key: "root" }, join(root, "status.json")),
      ).toThrow(/routed writer path mismatch/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// assertFsStorePath — fail-loud path agreement 
// ---------------------------------------------------------------------------

describe("assertFsStorePath - fail-loud path agreement ", () => {
  test("FsStore with the store-resolved path equal to the expected path passes", () => {
    const root = tmpRoot("store-assert-ok-");
    try {
      const store = authorizedStore(createFsStore(root));
      expect(() => assertFsStorePath(store, { kind: "status", key: "root" }, join(root, "status.json"))).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("FsStore with a diverging expected path throws naming both paths", () => {
    const root = tmpRoot("store-assert-mismatch-");
    const other = tmpRoot("store-assert-other-");
    try {
      const store = authorizedStore(createFsStore(root));
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
// loadStoreModule (trust boundary)
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
      await store.put({ kind: "review", key: "review-1", payload });
      const got = await store.get({ kind: "review", key: "review-1" });
      expect(got).toEqual(payload);
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

// ---------------------------------------------------------------------------
// coordinated-writer — the protected-write boundary (spec C4)
// ---------------------------------------------------------------------------

describe("coordinated-writer \u2014 protected FsStore boundary", () => {
  test("refuses a raw put/delete on every protected kind and leaves the bytes unchanged", async () => {
    const root = tmpRoot("coordinated-writer-store-");
    try {
      const store = createFsStore(root);
      const remove = requiredDelete(store);
      const statusPath = join(root, "status.json");
      const payload = { version: 2, updated_at: "2026-09-15", workflows: [] };
      await authorizedStore(store).put({ kind: "status", key: "root", payload });
      const before = readFileSync(statusPath);

      await expect(
        store.put({ kind: "status", key: "root", payload: { ...payload, updated_at: "2000-01-01" } }),
      ).rejects.toMatchObject({ code: "coordination.direct-write-refused" });
      await expect(remove({ kind: "status", key: "root" })).rejects.toMatchObject({
        code: "coordination.direct-write-refused",
      });
      expect(readFileSync(statusPath)).toEqual(before);

      // A snapshot direct write is refused too, and a retired register write
      // is refused outright (issue authority) — neither creates anything.
      await expect(store.put({ kind: "snapshot", key: "wf-1", payload: { probe: true } })).rejects.toMatchObject({
        code: "coordination.direct-write-refused",
      });
      await expect(remove({ kind: "snapshot", key: "wf-1" })).rejects.toMatchObject({
        code: "coordination.direct-write-refused",
      });
      await expect(store.put({ kind: "residuals", key: "p1", payload: { probe: true } } as never)).rejects.toThrow();
      expect(existsSync(join(root, "workflows", "wf-1", "snapshot.json"))).toBe(false);
      expect(existsSync(join(root, "projects", "p1", "residuals.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts the same write from inside the authorized context", async () => {
    const root = tmpRoot("coordinated-writer-store-authorized-");
    try {
      const store = createFsStore(root);
      await withProtectedWrite(join(root, "status.json"), "put", () =>
        store.put({ kind: "status", key: "root", payload: { version: 2, updated_at: "2026-09-15", workflows: [] } }),
      );
      expect(existsSync(join(root, "status.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
