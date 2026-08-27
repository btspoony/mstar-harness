/**
 * Engine artifact store — type-only persist port (HostAdapter pattern,
 * spec: iter-20260827-cli-artifact-store SP2). JSON coordination docs
 * (status / snapshot / residuals / review) round-trip through an
 * `ArtifactStore`; the default `FsStore` keeps today's `.mstar/` paths
 * and atomic write semantics. No concrete non-FS adapter lives in this
 * package (roadmap §8.4 discipline).
 */
import { existsSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readJson, writeJson } from "./core.js";
import {
  assertSafePathComponent,
  resolveHarnessDir,
  resolveProjectDir,
  resolveWorkflowDir,
} from "./path.js";

/** JSON coordination-doc kinds the store persists (spec SP2). */
export type ArtifactKind = "status" | "snapshot" | "residuals" | "review" | "json";

/** Stable key inside the kind. Workflow id, project id, or review id;
 * `kind: "status"` always uses key `"root"`. */
export type ArtifactRef = {
  kind: ArtifactKind;
  key: string;
};

/** A store document: the ref plus the payload and an optional schema id. */
export type ArtifactDoc<T = unknown> = ArtifactRef & {
  payload: T;
  /** Optional content-type / schema id (e.g. mstar.review/v1). */
  schema?: string;
};

/** Type-only persist contract (HostAdapter pattern). `put` / `get` /
 * `delete` are async-only — a network-backed store never needs a sync
 * facade (architect-locked 2026-08-27: no `putSync` anywhere). */
export interface ArtifactStore {
  put(doc: ArtifactDoc): Promise<void>;
  get<T = unknown>(ref: ArtifactRef): Promise<T | undefined>;
  delete?(ref: ArtifactRef): Promise<void>;
}

/** Plan-shaped review key detector (architect-locked 2026-08-27): full
 * match of the single-segment key against the existing `plan_id` shape,
 * evaluated after the key passes `assertSafePathComponent`. */
const PLAN_SHAPED_KEY_RE = /^[0-9]{8}-[a-z0-9-]+$/;

/** Map an artifact ref to its file path under `harnessRoot` (spec SP2
 * FsStore path table — the single kind→path mapping, shared with SP3;
 * SP3 never re-implements or extends it). */
function resolveArtifactPath(harnessRoot: string, ref: ArtifactRef): string {
  const { kind, key } = ref;
  if (kind === "json") {
    // Escape hatch: caller-supplied absolute path. Not a user-facing AC.
    if (!isAbsolute(key)) {
      throw new Error(`ArtifactStore json key must be an absolute path \u2014 got ${JSON.stringify(key)}`);
    }
    if (key.split(/[\\/]+/).includes("..")) {
      throw new Error(`ArtifactStore json key must not contain ".." segments \u2014 got ${JSON.stringify(key)}`);
    }
    return key;
  }
  assertSafePathComponent(key, "ArtifactStore key");
  if (kind === "status") {
    if (key !== "root") {
      throw new Error(`ArtifactStore status key must be "root" \u2014 got ${JSON.stringify(key)}`);
    }
    return join(harnessRoot, "status.json");
  }
  if (kind === "snapshot") {
    return join(resolveWorkflowDir(harnessRoot, { harnessDir: harnessRoot }), key, "snapshot.json");
  }
  if (kind === "residuals") {
    return join(resolveProjectDir(harnessRoot, { harnessDir: harnessRoot }), key, "residuals.json");
  }
  // kind === "review" — product-locked table (shared with SP3): plan-shaped
  // key → {HARNESS_DIR}/sdd/<key>/review/report.json; other keys →
  // {HARNESS_DIR}/sdd/_reviews/<key>.json. Never a key-less
  // {SDD_DIR}/review/report.json (that would clobber every review).
  if (PLAN_SHAPED_KEY_RE.test(key)) {
    return join(harnessRoot, "sdd", key, "review", "report.json");
  }
  return join(harnessRoot, "sdd", "_reviews", `${key}.json`);
}

/** Default local adapter: maps kinds to the existing `.mstar/` paths.
 * `put` uses the sync `writeJson` (atomic temp+rename unchanged) and
 * returns a resolved Promise; locks stay with callers (architect-locked
 * 2026-08-27). `get` mirrors `readJson`: missing file → `undefined`,
 * malformed JSON → throw with the path in the message. */
export function createFsStore(harnessRoot: string): ArtifactStore {
  const root = resolve(harnessRoot);
  return {
    async put(doc: ArtifactDoc): Promise<void> {
      writeJson(resolveArtifactPath(root, doc), doc.payload);
    },
    async get<T = unknown>(ref: ArtifactRef): Promise<T | undefined> {
      const filePath = resolveArtifactPath(root, ref);
      if (!existsSync(filePath)) return undefined;
      return readJson(filePath) as unknown as T;
    },
    async delete(ref: ArtifactRef): Promise<void> {
      const filePath = resolveArtifactPath(root, ref);
      if (existsSync(filePath)) unlinkSync(filePath);
    },
  };
}

/** In-process injected store (Inspector / tests); `undefined` resets to
 * the default FsStore. */
let injectedStore: ArtifactStore | undefined;

export function setArtifactStore(store: ArtifactStore | undefined): void {
  injectedStore = store;
}

/** The active store: the injected one when set, otherwise a lazily
 * created `FsStore` from `resolveHarnessDir(process.cwd())`. A `null`
 * resolution throws the same fail-loud "harness dir not found" style as
 * `resolveHarnessSubdir` — never a silent cwd fallback. */
export function getArtifactStore(): ArtifactStore {
  if (injectedStore !== undefined) return injectedStore;
  const root = resolveHarnessDir(process.cwd());
  if (root === null) {
    throw new Error(
      `harness dir not found from ${resolve(process.cwd())} \u2014 cannot create the default FsStore (run \`mstar harness scaffold\`, pass opts.harnessDir, or set MSTAR_HARNESS_DIR)`,
    );
  }
  return createFsStore(root);
}
