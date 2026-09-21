/**
 * Engine artifact store — type-only persist port (HostAdapter pattern).
 * JSON coordination docs
 * (status / snapshot / residuals / review) round-trip through an
 * `ArtifactStore`; the default `FsStore` keeps today's `.mstar/` paths
 * and atomic write semantics. No concrete non-FS adapter lives in this
 * package (roadmap §8.4 discipline).
 */
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { readJson, writeJson } from "./core.js";
import { assertProtectedWriteAuthorized, canonicalTarget, type ProtectedWriteKind } from "./coordination-write.js";
import {
  assertSafePathComponent,
  resolveHarnessDir,
  resolveProjectDir,
  resolveWorkflowDir,
} from "./path.js";
import { assertExecutionFileReadAllowed, assertExecutionFileWriteAllowed } from "./store-db.js";

/** JSON coordination-doc kinds the store persists. The former `residuals`
 * kind is retired (issue-governance cutover G2a): the issue store (`store.db`)
 * is the only findings authority, and a project `residuals.json` is migration
 * history that must never be (re)created through the runtime store. */
export type ArtifactKind = "status" | "snapshot" | "review" | "json";

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
 * facade (architect-locked 2026-08-27: no `putSync` anywhere). `list?`
 * is optional enumeration (D4): stores that cannot enumerate decline by
 * omitting the member — callers probe `typeof store.list === "function"`
 * (same pattern as `delete?`). */
export interface ArtifactStore {
  put(doc: ArtifactDoc): Promise<void>;
  get<T = unknown>(ref: ArtifactRef): Promise<T | undefined>;
  delete?(ref: ArtifactRef): Promise<void>;
  /** Enumerate refs of `kind`, sorted by key ascending (spec D4). Uniform
 * rule: report what exists — missing backing dir/file → `[]`; every
 * listed key round-trips through `get`. `json` is not enumerable. */
  list?(kind: ArtifactKind): Promise<ArtifactRef[]>;
}

/** Plan-shaped review key detector (architect-locked 2026-08-27): full
 * match of the single-segment key against the existing `plan_id` shape,
 * evaluated after the key passes `assertSafePathComponent`. */
const PLAN_SHAPED_KEY_RE = /^[0-9]{8}-[a-z0-9-]+$/;

/** Map an artifact ref to its file path under `harnessRoot` (the store contract — the single kind→path
 * mapping). Exported so host adapters import the contract instead of
 * re-deriving it textually. */
export function resolveArtifactPath(harnessRoot: string, ref: ArtifactRef): string {
  const { kind, key } = ref;
  // Retired kind guard (G2a): the type no longer admits `residuals`, but a
  // runtime caller (JS consumer, stale adapter) must also be refused rather
  // than silently resolving a legacy register path.
  if ((kind as string) === "residuals") {
    throw new Error(
      "ArtifactStore no longer persists project registers \u2014 the issue store (store.db) is the only findings authority; a residuals.json is migration history",
    );
  }
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
 // kind === "review" — product-locked table: plan-shaped
 // key → {HARNESS_DIR}/sdd/<key>/review/report.json; other keys →
 // {HARNESS_DIR}/sdd/_reviews/<key>.json. Never a key-less
 // {SDD_DIR}/review/report.json (that would clobber every review).
  if (PLAN_SHAPED_KEY_RE.test(key)) {
    return join(harnessRoot, "sdd", key, "review", "report.json");
  }
  return join(harnessRoot, "sdd", "_reviews", `${key}.json`);
}

/** Directory names directly under `dir` — `[]` when the backing dir is
 * missing (D4 uniform rule: enumerate what exists, never throw). */
function listDirNames(dir: string): string[] {
  return readDirEntries(dir)
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** Keys for the `*.json` files directly under `dir` (extension stripped) —
 * `[]` when the backing dir is missing. */
function listJsonKeys(dir: string): string[] {
  return readDirEntries(dir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -".json".length));
}

/** Read dir entries, or `[]` when the path is gone (ENOENT) or not a
 * directory (ENOTDIR). No `existsSync` pre-check: a dir removed between
 * check and readdir would throw ENOENT out of `list`, breaking the D4
 * "missing backing → `[]`" rule (greptile P1) — catch it instead. Other
 * errors (EACCES, …) still throw. */
function readDirEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

/** Refuse every retired register write target (G2a): the `residuals` kind is
 * gone, and a `json` alias (`--json <abs path>`, symlink) whose CANONICAL
 * target is a `residuals.json` under the resolved project dir must not
 * recreate the legacy authority either — it refuses, it never falls through
 * to an ordinary write. */
function assertNotRetiredRegisterTarget(root: string, ref: ArtifactRef, filePath: string): void {
  if ((ref.kind as string) === "residuals") {
    throw new Error(
      "ArtifactStore no longer persists project registers \u2014 the issue store (store.db) is the only findings authority; a residuals.json is migration history",
    );
  }
  if (ref.kind === "json") {
    const canonical = canonicalTarget(filePath);
    if (basename(canonical) !== "residuals.json") return;
    const projectDir = canonicalTarget(resolveProjectDir(root, { harnessDir: root }));
    if (canonical.startsWith(`${projectDir}${sep}`)) {
      throw new Error(
        `refusing to persist ${canonical} through a json alias \u2014 project registers are retired migration history; the issue store (store.db) is the only findings authority`,
      );
    }
  }
}

/** Protected document class of a resolved target (spec §C4): the coordination
 * documents the scoped writers own. Kinds map directly; a `json` alias
 * (`--json <abs path>`, symlink) is classified by its CANONICAL target
 * against the resolved protected roots, so no alias can dodge the boundary.
 * `review` and unrelated `json` keep current behavior. */
function protectedKindOf(root: string, ref: ArtifactRef, filePath: string): ProtectedWriteKind | null {
  if (ref.kind === "status") return "root";
  if (ref.kind === "snapshot") return "snapshot";
  if (ref.kind !== "json") return null;
  const canonical = canonicalTarget(filePath);
  if (canonical === canonicalTarget(resolveArtifactPath(root, { kind: "status", key: "root" }))) return "root";
  const workflowDir = canonicalTarget(resolveWorkflowDir(root, { harnessDir: root }));
  if (basename(canonical) === "snapshot.json" && canonical.startsWith(`${workflowDir}${sep}`)) return "snapshot";
  return null;
}

/** Resolve the get-path for `key` through the single path table, or
 * `undefined` when the name is outside the safe path-component charset.
 * Enumeration probes every discovered name through this guard: a stray unsafe
 * name is skipped — never thrown, never advertised —
 * so every listed key round-trips through `get`. */
function tryResolveGetPath(root: string, kind: ArtifactKind, key: string): string | undefined {
  try {
    return resolveArtifactPath(root, { kind, key });
  } catch {
    return undefined;
  }
}

/** Default local adapter: maps kinds to the existing `.mstar/` paths.
 * `put` uses the sync `writeJson` (atomic temp+rename unchanged) and
 * returns a resolved Promise; locks stay with callers (architect-locked
 * 2026-08-27). `get` mirrors `readJson`: missing file → `undefined`,
 * malformed JSON → throw with the path in the message. The returned store
 * also exposes its resolved `root` so the routed writers can fail loud
 * when a caller's explicit target path diverges from the store-resolved
 * path ; `root` is not part of the `ArtifactStore` contract.
 * `list` enumerates per the D4 table: report what exists — missing
 * backing dir/file → `[]`, `json` throws, keys sorted ascending. */
export function createFsStore(harnessRoot: string): ArtifactStore & { root: string } {
  const root = resolve(harnessRoot);
  return {
    root,
    async put(doc: ArtifactDoc): Promise<void> {
 // D3 schema fail-loud: FsStore writes only `doc.payload`, so it
 // cannot persist the envelope schema id honestly — refuse instead of
 // silently dropping it. `doc.schema` ≠ `payload.schema`: a review
 // envelope's inner "schema" is payload data and stays unaffected.
 // Canonical message (single home: spec store-contract-completion D3).
      if (doc.schema !== undefined) {
        throw new Error(
          "FsStore does not persist schema ids \u2014 omit --schema or inject a store module that persists it",
        );
      }
      const filePath = resolveArtifactPath(root, doc);
      assertNotRetiredRegisterTarget(root, doc, filePath);
 // Protected-write boundary (spec §C4): the coordination documents
 // (`status.json`, a workflow `snapshot.json`) accept writes only from
 // inside the private authorization context the locked writers open.
 // Everything else — including a `json`/symlink alias of a protected file —
 // refuses.
      const protectedKind = protectedKindOf(root, doc, filePath);
      if (protectedKind !== null) {
        // Canonical authority discrimination precedes the authorization check
        // and the write itself (spec §4.3): with an ACTIVE execution authority
        // in the control harness this file is not a persistence route, even
        // from inside the authorized protected-write context.
        assertExecutionFileWriteAllowed({ harnessDir: root });
        assertProtectedWriteAuthorized(filePath, "put", protectedKind);
      }
      writeJson(filePath, doc.payload);
    },
    async get<T = unknown>(ref: ArtifactRef): Promise<T | undefined> {
      const filePath = resolveArtifactPath(root, ref);
      // Read-surface symmetry (G2a): the same refusal as put/delete. A read
      // through a `json` alias is the same authority channel — the runtime
      // holds no register authority, so legacy register bytes never reach a
      // consumer that bypasses the findings gate.
      assertNotRetiredRegisterTarget(root, ref, filePath);
      // Canonical authority discrimination precedes the read itself (spec
      // §4.3/§5) and is the SAME canonical protected-kind classification the
      // writer path uses: while the execution authority is ACTIVE this seam is
      // not a way to observe root/snapshot JSON (a `json` alias included) that
      // the canonical readers refuse, and a store that exists but cannot be
      // read refuses here too instead of falling through to the bytes.
      if (protectedKindOf(root, ref, filePath) !== null) {
        assertExecutionFileReadAllowed({ harnessDir: root });
      }
      if (!existsSync(filePath)) return undefined;
      return readJson(filePath) as unknown as T;
    },
    async delete(ref: ArtifactRef): Promise<void> {
      const filePath = resolveArtifactPath(root, ref);
      assertNotRetiredRegisterTarget(root, ref, filePath);
      const protectedKind = protectedKindOf(root, ref, filePath);
      if (protectedKind !== null) {
        assertExecutionFileWriteAllowed({ harnessDir: root });
        assertProtectedWriteAuthorized(filePath, "delete", protectedKind);
      }
      if (existsSync(filePath)) unlinkSync(filePath);
    },
    async list(kind: ArtifactKind): Promise<ArtifactRef[]> {
 // json keys are caller-supplied absolute paths — nothing to
 // enumerate (canonical message, single home: spec D4).
      if (kind === "json") {
        throw new Error("ArtifactStore json keys are absolute paths and cannot be listed");
      }
      if ((kind as string) === "residuals") {
        throw new Error(
          "ArtifactStore no longer persists project registers \u2014 the issue store (store.db) is the only findings authority; a residuals.json is migration history",
        );
      }
      const keys: string[] = [];
      if (kind === "status") {
 // Exists-conditional (architect-amended D4): [root] iff the file
 // exists — never a key whose get would miss.
        if (existsSync(resolveArtifactPath(root, { kind, key: "root" }))) keys.push("root");
      } else if (kind === "snapshot") {
 // Same root resolution as the path table (.mstarc overrides apply).
        const baseDir = resolveWorkflowDir(root, { harnessDir: root });
        for (const name of listDirNames(baseDir)) {
 // Round-trip guard through the single path table: list the dir
 // only when its exact get-path (<dir>/<name>/<file>) exists.
          const getPath = tryResolveGetPath(root, kind, name);
          if (getPath !== undefined && existsSync(getPath)) keys.push(name);
        }
      } else {
 // kind === "review" — union enumeration (D4), single detector
 // (PLAN_SHAPED_KEY_RE), same sdd root as the path table.
        const sddDir = join(root, "sdd");
 // (a) flat keys from _reviews/<key>.json. Plan-shaped names are
 // excluded: get routes such a key to <key>/review/report.json, so
 // listing the _reviews file would advertise an unreachable key.
        for (const key of listJsonKeys(join(sddDir, "_reviews"))) {
          if (!PLAN_SHAPED_KEY_RE.test(key) && tryResolveGetPath(root, kind, key) !== undefined) {
            keys.push(key);
          }
        }
 // (b) plan-shaped dirs carrying <dir>/review/report.json.
        for (const name of listDirNames(sddDir)) {
          if (PLAN_SHAPED_KEY_RE.test(name)) {
 // PLAN_SHAPED_KEY_RE is a subset of the safe charset, so this
 // probe never throws — same uniform guard as the other arms.
            const getPath = tryResolveGetPath(root, kind, name);
            if (getPath !== undefined && existsSync(getPath)) keys.push(name);
          }
        }
      }
      return keys.sort().map((key) => ({ kind, key }));
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

/**
 * Fail-loud path-agreement guard for the routed writers : when
 * `store` is an FsStore, resolve the path the store would compute for
 * `ref` and require it to equal `expectedPath` (the caller's explicit
 * target). A divergence means the caller's path lives outside the active
 * store's root — the lockdir would serialize the parameter path while the
 * put lands at the store root (silent decoupling / split-brain window).
 * Custom (non-FS) stores own their mapping by design and are skipped.
 * Cheap: pure path resolution, no I/O.
 */
export function assertFsStorePath(store: ArtifactStore, ref: ArtifactRef, expectedPath: string): void {
  const root = (store as ArtifactStore & { root?: unknown }).root;
  if (typeof root !== "string") return; // custom store — the caller's contract
  const storePath = resolveArtifactPath(root, ref);
  const expected = resolve(expectedPath);
  if (storePath !== expected) {
    throw new Error(
      `routed writer path mismatch: the active FsStore resolves ${ref.kind}/${JSON.stringify(ref.key)} to ${JSON.stringify(storePath)} but the caller's target is ${JSON.stringify(expected)} \u2014 call setArtifactStore(createFsStore(<root>)) first when the write target differs from the active store's root`,
    );
  }
}

/** Trust boundary (architect-locked 2026-08-27): `loadStoreModule` accepts
 * filesystem paths only. Any URI scheme (`http:`, `https:`, `file:`,
 * `data:`, `node:`, ...) is rejected before `import()` — no remote loader. */
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Structural check: the loaded value must implement `put` + `get` as
 * functions (the store contract). */
function isArtifactStore(value: unknown): value is ArtifactStore {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ArtifactStore).put === "function" &&
    typeof (value as ArtifactStore).get === "function"
  );
}

/** Load a store module from a filesystem path (the store module-loading trust boundary). Resolves against cwd; rejects empty values and any
 * URI scheme before `import()`; throws when the file is missing. Accepts a
 * `createArtifactStore` named export, a default-exported factory, or a
 * default-exported object; the result is structurally verified (`put` +
 * `get` functions) before use.
 *
 * CJS interop: `import()` of a CommonJS module surfaces `module.exports`
 * as `default` (plus statically detected named exports on the namespace);
 * the `?? mod` fallback covers loaders that surface `module.exports`
 * directly as the namespace. No loader protocol beyond `import()`. */
export async function loadStoreModule(modulePath: string): Promise<ArtifactStore> {
  if (modulePath === "") {
    throw new Error("loadStoreModule: module path must not be empty");
  }
  if (URI_SCHEME_RE.test(modulePath)) {
    throw new Error(
      `loadStoreModule: only filesystem paths are allowed \u2014 got ${JSON.stringify(modulePath)} (URI schemes such as http:/https:/file: are rejected)`,
    );
  }
  const resolved = resolve(modulePath);
  if (!existsSync(resolved)) {
    throw new Error(`loadStoreModule: module file not found \u2014 ${JSON.stringify(resolved)}`);
  }
 // The module path is runtime-selected (CLI --store / MSTAR_STORE_MODULE),
 // so a static import cannot name it; dynamic import() is the loader.
  const mod = (await import(resolved)) as Record<string, unknown>;
  const candidate = mod.createArtifactStore ?? mod.default ?? mod;
  const store = typeof candidate === "function" ? await (candidate as () => unknown)() : candidate;
  if (!isArtifactStore(store)) {
    throw new Error(
      `loadStoreModule: module ${JSON.stringify(resolved)} does not export an ArtifactStore \u2014 expected a createArtifactStore named export, a default factory, or a default object with put() and get() functions`,
    );
  }
  return store;
}
