/**
 * Engine artifact store — ArtifactStore contract + FsStore + injection.
 *
 * Spec sources (each test cites the section it enforces; roadmap §8.5 C2
 * — engine unit tests cite the source section as spec):
 * - Contract + FsStore path table + key discipline + async-only store:
 *   `iter-20260827-cli-artifact-store` SP2 (primary spec
 *   `.mstar/iterations/iter-20260827-cli-artifact-store/specs/artifact-store.md`)
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
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFsStore,
  getArtifactStore,
  setArtifactStore,
  type ArtifactDoc,
  type ArtifactStore,
} from "../src/store.js";

const ENV_KEY = "MSTAR_HARNESS_DIR";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

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
