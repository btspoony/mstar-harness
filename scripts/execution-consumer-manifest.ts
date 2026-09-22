/**
 * scripts/execution-consumer-manifest.ts — source/package/instruction
 * inventory producer and parity validator (phase 2b execution contract §4.2
 * package/instruction result, §7 R1, §9 rows S12/S16/S17; protocol
 * `consumer-v1`).
 *
 * What this records, per consumer: the canonical build-input closure (source
 * trees plus config/build-script files), the generated output closure (build
 * output trees plus the public entry artifacts), the entrypoint, the exact
 * runtime target and floor, the declared capability, and the canonical
 * copied-instruction trees that package their assets from the repo-root
 * `skills/`, `commands/`, `agents/` corpus.
 *
 * This is packaging evidence only. It never inspects an installed consumer,
 * never reads a home directory, never bumps a version and never invents
 * parity: a missing or empty build output refuses instead of producing a
 * manifest. The layouts below mirror the existing build scripts (each
 * package's `build`/`bundle-assets`/`build-client` scripts and
 * `scripts/build-zcode-hooks.ts`) — this is an inventory over those layouts,
 * not a second build system, and a recorded source/output digest is **not** a
 * proof that the output was compiled from that source. Only the real package
 * build can prove that; R3 runs it.
 *
 * CLI:
 *   bun scripts/execution-consumer-manifest.ts --repo . --write
 *   bun scripts/execution-consumer-manifest.ts --repo . --check
 * `--write` emits `packages/<id>/dist/execution-consumer.json` for
 * engine/CLI/DSh/OMP/OpenCode plus the ZCode plugin-root copy
 * `hooks/execution-consumer.json`; `--check` re-verifies every written
 * manifest against the bytes on disk without writing anything.
 *
 * `manifest.repoRoot` is stored verbatim as the caller supplied it (`--repo .`
 * keeps the committed artifact portable); every other path is repo-relative.
 * Verification resolves that field against the current process root, and
 * `--check` additionally requires it to match `--repo`.
 *
 * Repo convention: same-name test scripts/execution-consumer-manifest.test.ts.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { MIN_BUN_VERSION, MIN_NODE_VERSION } from "../packages/engine/src/index.ts";

export const CONSUMER_MANIFEST_PROTOCOL = "consumer-v1" as const;

/** Canonical runtime floors (contract Global Constraints; engine §8 owns the
 * constants). `target` names the runtime the entrypoint is actually launched
 * with, never a demand to install both runtimes. */
export const CANONICAL_RUNTIME_FLOOR = {
  node: `>=${MIN_NODE_VERSION}`,
  bun: `>=${MIN_BUN_VERSION}`,
} as const;

/** Declared consumer capability (contract §4.2). `decision-only` marks a
 * consumer whose write path is unsupported: it observes and refuses, and the
 * manifest must say so instead of advertising a writer. */
export type ConsumerCapability = "writer" | "read-only" | "decision-only";

export interface ConsumerRuntime {
  readonly target: "node" | "bun";
  /** Exact floor for `target`, e.g. `>=24.18.0`. */
  readonly floor: string;
  /** Where the floor is declared: package `engines` (cross-checked by bytes)
   * or the canonical floor itself (no package metadata exists — the ZCode
   * plugin root is the repo checkout). */
  readonly declaration: "package-engines" | "canonical-floor";
}

export interface ConsumerDigest {
  /** Repo-relative, canonical, traversal-free. */
  readonly path: string;
  /** Lowercase 64-hex SHA256 over the file bytes. */
  readonly sha256: string;
}

/** Canonical digest of one directory tree: sorted `{path, kind, sha256,
 * linkTarget}` entries, where a symlink is recorded by its tree-relative
 * canonical target and the resolved bytes. A tree digest is self-contained:
 * every link must resolve inside its own tree. */
export interface DigestTree {
  readonly root: string;
  readonly files: number;
  readonly sha256: string;
}

/** The build-input or generated-output closure of one consumer. */
export interface ConsumerArtifactSet {
  readonly trees: readonly DigestTree[];
  readonly files: readonly ConsumerDigest[];
}

/** One `skills/`|`commands/`|`agents/` tree that a package bundles. `copy`
 * targets must match the source tree exactly; `merge` targets are supersets
 * (an overlay appends host-only files) so every source file must appear in the
 * target with identical bytes and link target. Both modes record the source
 * tree digest, so a stale copy — or a stale source — invalidates the manifest. */
export interface CopiedInstructionTree {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly mode: CopiedInstructionMode;
  readonly files: number;
  readonly sha256: string;
}

export type CopiedInstructionMode = "copy" | "merge";

export interface ExecutionConsumerEntry {
  readonly id: string;
  readonly packageRoot: string;
  readonly capability: ConsumerCapability;
  /** Non-null whenever the capability is not a plain writer. */
  readonly capabilityNote: string | null;
  readonly entrypoint: string;
  readonly runtime: ConsumerRuntime;
  readonly sources: ConsumerArtifactSet;
  readonly generated: ConsumerArtifactSet;
  readonly copiedInstructions: readonly CopiedInstructionTree[];
}

export interface ExecutionConsumerManifest {
  readonly version: 1;
  readonly protocol: typeof CONSUMER_MANIFEST_PROTOCOL;
  readonly repoRoot: string;
  readonly consumers: readonly ExecutionConsumerEntry[];
}

/** Stable refusal codes; callers match on these, never on prose. */
export type ConsumerManifestRefusalCode =
  | "consumer.schema-invalid"
  | "consumer.protocol-unsupported"
  | "consumer.consumer-set-mismatch"
  | "consumer.path-outside-root"
  | "consumer.path-missing"
  | "consumer.generated-missing"
  | "consumer.generated-empty"
  | "consumer.digest-mismatch"
  | "consumer.copy-root-missing"
  | "consumer.symlink-unresolved"
  | "consumer.symlink-escapes-tree"
  | "consumer.copy-entry-unsupported"
  | "consumer.runtime-mismatch"
  | "consumer.capability-mismatch"
  | "consumer.manifest-missing"
  | "consumer.manifest-drift"
  | "consumer.repo-root-mismatch";

export class ExecutionConsumerManifestError extends Error {
  readonly code: ConsumerManifestRefusalCode;

  constructor(code: ConsumerManifestRefusalCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ExecutionConsumerManifestError";
    this.code = code;
  }
}

interface DigestTreeSpec {
  readonly root: string;
  /** Basenames skipped at any depth — the allowlist for non-build files we
   * write ourselves (the manifest) so the digest cannot become self-referential. */
  readonly exclude?: readonly string[];
}

interface ConsumerCopyLayout {
  readonly from: string;
  readonly to: string;
  readonly mode: CopiedInstructionMode;
}

interface ConsumerLayout {
  readonly id: string;
  readonly packageRoot: string;
  readonly capability: ConsumerCapability;
  readonly capabilityNote: string | null;
  readonly runtime: {
    readonly target: "node" | "bun";
    readonly declaration: ConsumerRuntime["declaration"];
  };
  /** Package metadata carrying `engines`; `null` when the consumer has none. */
  readonly packageJson: string | null;
  readonly entrypoint: string;
  /** Build-input closure: source roots plus the config/build inputs. */
  readonly sourceTrees: readonly DigestTreeSpec[];
  readonly sourceFiles: readonly string[];
  /** Build-output closure: output roots plus the public entry artifacts. */
  readonly generatedTrees: readonly DigestTreeSpec[];
  readonly generatedFiles: readonly string[];
  readonly copies: readonly ConsumerCopyLayout[];
}

/** The manifest we write lives inside these trees; skipping it by basename is
 * the explicit non-build allowlist that keeps the digest cycle-free. */
const MANIFEST_BASENAME = "execution-consumer.json";
const BUILD_OUTPUT_EXCLUSIONS: readonly string[] = [MANIFEST_BASENAME];

const HARNESS_ASSET_COPIES: readonly ConsumerCopyLayout[] = [
  { from: "skills", to: "harness-skills", mode: "copy" },
  { from: "commands", to: "harness-commands", mode: "copy" },
  { from: "agents", to: "harness-agents", mode: "copy" },
];

const OMP_HARNESS_ASSET_COPIES: readonly ConsumerCopyLayout[] = [
  ...HARNESS_ASSET_COPIES.map((copy) => ({
    from: copy.from,
    to: `packages/omp/${copy.to}`,
    mode: copy.mode,
  })),
  { from: "skills", to: "packages/omp/skills", mode: "copy" },
  { from: "commands", to: "packages/omp/commands", mode: "copy" },
  { from: "agents", to: "packages/omp/agents", mode: "copy" },
];

/** The canonical consumer inventory, derived from the real build contract:
 * engine (`bun build` + `tsc --emitDeclarationOnly` into `dist`), CLI
 * (`build-web` + `bun build` + the dist literal escaper), DSh (`bundle-assets`
 * + `bun build` + `build-client`), OMP (`bundle-assets` + `bun build` + root
 * `hooks`/`extensions`/`tools` mirrors), OpenCode (`bundle-assets` +
 * `bun build`) and the committed ZCode hook. */
export const CONSUMER_LAYOUTS: readonly ConsumerLayout[] = [
  {
    id: "engine",
    packageRoot: "packages/engine",
    capability: "writer",
    capabilityNote: null,
    runtime: { target: "node", declaration: "package-engines" },
    packageJson: "packages/engine/package.json",
    entrypoint: "packages/engine/dist/engine.js",
    sourceTrees: [{ root: "packages/engine/src" }],
    sourceFiles: ["packages/engine/package.json", "packages/engine/tsconfig.json"],
    generatedTrees: [{ root: "packages/engine/dist", exclude: BUILD_OUTPUT_EXCLUSIONS }],
    generatedFiles: ["packages/engine/dist/audit.js", "packages/engine/dist/engine.js"],
    copies: [],
  },
  {
    id: "cli",
    packageRoot: "packages/cli",
    capability: "writer",
    capabilityNote: null,
    runtime: { target: "node", declaration: "package-engines" },
    packageJson: "packages/cli/package.json",
    entrypoint: "packages/cli/dist/mstar-harness.js",
    sourceTrees: [{ root: "packages/cli/src" }, { root: "packages/cli/scripts" }],
    sourceFiles: [
      "packages/cli/package.json",
      "packages/cli/tsconfig.json",
      "scripts/ascii-literal-utils.ts",
      "scripts/escape-dist-literals.ts",
    ],
    generatedTrees: [{ root: "packages/cli/dist", exclude: BUILD_OUTPUT_EXCLUSIONS }],
    generatedFiles: ["packages/cli/dist/mstar-harness.js"],
    copies: [],
  },
  {
    id: "dsh",
    packageRoot: "packages/dsh",
    capability: "writer",
    capabilityNote: null,
    runtime: { target: "bun", declaration: "package-engines" },
    packageJson: "packages/dsh/package.json",
    entrypoint: "packages/dsh/dist/index.js",
    sourceTrees: [{ root: "packages/dsh/src" }, { root: "packages/dsh/scripts" }],
    sourceFiles: ["packages/dsh/package.json", "packages/dsh/tsconfig.json"],
    generatedTrees: [{ root: "packages/dsh/dist", exclude: BUILD_OUTPUT_EXCLUSIONS }],
    generatedFiles: [
      "packages/dsh/dist/client.js",
      "packages/dsh/dist/index.js",
      "packages/dsh/dist/invariant.js",
    ],
    copies: HARNESS_ASSET_COPIES.map((copy) => ({
      from: copy.from,
      to: `packages/dsh/${copy.to}`,
      mode: copy.mode,
    })),
  },
  {
    id: "omp",
    packageRoot: "packages/omp",
    capability: "writer",
    capabilityNote: null,
    runtime: { target: "bun", declaration: "package-engines" },
    packageJson: "packages/omp/package.json",
    entrypoint: "packages/omp/dist/hooks/pre/mstar-gates.js",
    sourceTrees: [{ root: "packages/omp/src" }, { root: "packages/omp/scripts" }],
    sourceFiles: ["packages/omp/package.json", "packages/omp/tsconfig.json"],
    // `dist` plus the package-root convention mirrors the build produces with
    // `cp -R` (hooks/tools/extensions) — the plugin loads the mirrors.
    generatedTrees: [
      { root: "packages/omp/dist", exclude: BUILD_OUTPUT_EXCLUSIONS },
      { root: "packages/omp/extensions", exclude: BUILD_OUTPUT_EXCLUSIONS },
      { root: "packages/omp/hooks", exclude: BUILD_OUTPUT_EXCLUSIONS },
      { root: "packages/omp/tools", exclude: BUILD_OUTPUT_EXCLUSIONS },
    ],
    generatedFiles: [
      "packages/omp/dist/extensions/model-handoff.js",
      "packages/omp/dist/extensions/phase2-orchestration.js",
      "packages/omp/dist/hooks/pre/mstar-gates.js",
      "packages/omp/dist/tools/mstar_dispatch_validate/index.js",
      "packages/omp/dist/tools/mstar_iteration_gate/index.js",
      "packages/omp/dist/tools/mstar_lease_verify/index.js",
      "packages/omp/dist/tools/mstar_path_resolve/index.js",
      "packages/omp/dist/tools/mstar_status_validate/index.js",
      "packages/omp/dist/tools/mstar_worktree_check/index.js",
      // `bundle-assets` copies the omp plugin manifest to the package root.
      "packages/omp/plugin.json",
    ],
    copies: [
      ...OMP_HARNESS_ASSET_COPIES,
      { from: "assets", to: "packages/omp/assets", mode: "copy" },
    ],
  },
  {
    id: "opencode",
    packageRoot: "packages/opencode",
    capability: "decision-only",
    capabilityNote:
      "OpenCode hook is log/decision-only: without native per-call session identity the writer association is refused and this consumer is excluded operationally (contract §6 H4 / S15).",
    runtime: { target: "node", declaration: "package-engines" },
    packageJson: "packages/opencode/package.json",
    entrypoint: "packages/opencode/dist/mstar.js",
    sourceTrees: [{ root: "packages/opencode/src" }, { root: "packages/opencode/scripts" }],
    sourceFiles: ["packages/opencode/package.json"],
    generatedTrees: [{ root: "packages/opencode/dist", exclude: BUILD_OUTPUT_EXCLUSIONS }],
    generatedFiles: ["packages/opencode/dist/mstar.js"],
    copies: [
      { from: "skills", to: "packages/opencode/harness-skills", mode: "copy" },
      { from: "commands", to: "packages/opencode/harness-commands", mode: "copy" },
      // The agents tree is merged, not replaced: OpenCode-only primary-seat
      // overlays append to the copied corpus.
      { from: "agents", to: "packages/opencode/harness-agents", mode: "merge" },
      { from: "packages/opencode/agents", to: "packages/opencode/harness-agents", mode: "merge" },
    ],
  },
  {
    id: "zcode",
    packageRoot: ".",
    capability: "writer",
    capabilityNote: null,
    // The ZCode plugin root is the repo checkout and the hook is spawned as
    // native `node`; there is no package manifest to cross-check, so the
    // canonical floor is recorded as its declaration.
    runtime: { target: "node", declaration: "canonical-floor" },
    packageJson: null,
    entrypoint: "hooks/mstar-write-gate.mjs",
    // The hook bundle inlines the engine, so the engine source is part of this
    // consumer's input closure, not only the hook's own source.
    sourceTrees: [{ root: "hooks/src" }, { root: "packages/engine/src" }],
    sourceFiles: ["scripts/build-zcode-hooks.ts"],
    generatedTrees: [],
    generatedFiles: ["hooks/mstar-write-gate.mjs"],
    copies: [],
  },
];

const HEX64 = /^[0-9a-f]{64}$/;

function refuse(code: ConsumerManifestRefusalCode, message: string): never {
  throw new ExecutionConsumerManifestError(code, message);
}

function sha256File(absPath: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(absPath);
  } catch {
    refuse("consumer.path-missing", `cannot read ${absPath}`);
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function toPosix(value: string): string {
  return value.split("\\").join("/");
}

function insideRepo(repoAbs: string, absPath: string): boolean {
  const prefix = repoAbs.endsWith("/") ? repoAbs : `${repoAbs}/`;
  return absPath === repoAbs || absPath.startsWith(prefix);
}

/** Canonicalize a path — resolving symlinks in every existing component — and
 * require the canonical result to stay inside the repository. Applied to every
 * path before any read or write, so a recorded/lexically-valid path that is a
 * symlink to foreign state refuses instead of being followed. */
function canonicalInsideRepo(repoAbs: string, absPath: string, context: string): string {
  let existing = absPath;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  let resolved: string;
  try {
    resolved = realpathSync(existing);
  } catch {
    refuse("consumer.path-missing", `cannot canonicalize ${context}: ${absPath}`);
  }
  const canonical = missing.length === 0 ? resolved : join(resolved, ...missing);
  if (!insideRepo(repoAbs, canonical)) {
    refuse("consumer.path-outside-root", `${context} resolves outside the repository: ${absPath}`);
  }
  return canonical;
}

/** Reject absolute, backslashed and traversal-bearing recorded paths, then
 * canonicalize and containment-check the result. Returns the canonical
 * absolute path, which is the only path any read/write may use. */
function resolveInsideRepo(repoAbs: string, relPath: string, context: string): string {
  if (relPath.length === 0 || isAbsolute(relPath) || relPath.includes("\\")) {
    refuse("consumer.path-outside-root", `${context} is not repo-relative: ${relPath}`);
  }
  return canonicalInsideRepo(repoAbs, resolve(repoAbs, relPath), context);
}

interface TreeEntry {
  readonly path: string;
  readonly kind: "file" | "symlink";
  readonly sha256: string;
  readonly linkTarget: string | null;
}

/** Walk a tree into canonical entries. A symlink is recorded by the canonical
 * path it resolves to **relative to its own tree** plus the resolved bytes, so
 * two trees hash identically only when every file, byte and self-contained link
 * matches — and a link that escapes its tree refuses, because such a tree is
 * not portable into an installed package. */
function treeEntries(rootAbs: string, exclude: readonly string[]): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const walk = (dirAbs: string, relDir: string): void => {
    const dirents = readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const dirent of dirents) {
      if (exclude.includes(dirent.name)) continue;
      const abs = join(dirAbs, dirent.name);
      const rel = relDir.length === 0 ? dirent.name : `${relDir}/${dirent.name}`;
      if (dirent.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (dirent.isSymbolicLink()) {
        let resolved: string;
        try {
          resolved = realpathSync(abs);
        } catch {
          refuse("consumer.symlink-unresolved", `${rootAbs}: dangling symlink ${rel}`);
        }
        const linkTarget = toPosix(relative(rootAbs, resolved));
        if (!insideRepo(rootAbs, resolved) || linkTarget.startsWith("../")) {
          refuse(
            "consumer.symlink-escapes-tree",
            `${rootAbs}: symlink ${rel} resolves outside its own tree`,
          );
        }
        entries.push({
          path: rel,
          kind: "symlink",
          sha256: sha256File(resolved),
          linkTarget,
        });
        continue;
      }
      if (dirent.isFile()) {
        entries.push({ path: rel, kind: "file", sha256: sha256File(abs), linkTarget: null });
        continue;
      }
      refuse("consumer.copy-entry-unsupported", `${rootAbs}: unsupported entry ${rel}`);
    }
  };
  walk(rootAbs, "");
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

function digestEntries(entries: readonly TreeEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** Digest one declared tree. Roots go through the canonical containment check,
 * so a symlinked root pointing outside the checkout refuses. */
function digestTree(repoAbs: string, spec: DigestTreeSpec): DigestTree {
  const abs = resolveInsideRepo(repoAbs, spec.root, `tree root ${spec.root}`);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    refuse("consumer.path-missing", `missing or non-directory tree root ${spec.root}`);
  }
  const entries = treeEntries(abs, spec.exclude ?? []);
  return { root: toPosix(spec.root), files: entries.length, sha256: digestEntries(entries) };
}

function hashCopiedTree(
  repoAbs: string,
  sourceRoot: string,
  targetRoot: string,
  mode: CopiedInstructionMode,
): CopiedInstructionTree {
  const sourceAbs = resolveInsideRepo(repoAbs, sourceRoot, `copy source ${sourceRoot}`);
  const targetAbs = resolveInsideRepo(repoAbs, targetRoot, `copy target ${targetRoot}`);
  if (!existsSync(sourceAbs)) {
    refuse("consumer.copy-root-missing", `missing copied-instruction source ${sourceRoot}`);
  }
  if (!existsSync(targetAbs)) {
    refuse("consumer.copy-root-missing", `missing copied-instruction target ${targetRoot}`);
  }
  const sourceEntries = treeEntries(sourceAbs, []);
  const sourceDigest = digestEntries(sourceEntries);

  if (mode === "copy") {
    const targetDigest = digestEntries(treeEntries(targetAbs, []));
    if (sourceDigest !== targetDigest) {
      refuse(
        "consumer.digest-mismatch",
        `copied instruction tree ${targetRoot} does not match its source ${sourceRoot}`,
      );
    }
  } else {
    // Overlay merge: the target is a superset, so every source entry must be
    // present with identical bytes and link target (host-only extras allowed).
    const targetByPath = new Map(
      treeEntries(targetAbs, []).map((entry) => [entry.path, entry] as const),
    );
    for (const entry of sourceEntries) {
      const copied = targetByPath.get(entry.path);
      if (
        copied === undefined ||
        copied.kind !== entry.kind ||
        copied.sha256 !== entry.sha256 ||
        copied.linkTarget !== entry.linkTarget
      ) {
        refuse(
          "consumer.digest-mismatch",
          `merged instruction ${targetRoot}/${entry.path} does not match its source ${sourceRoot}/${entry.path}`,
        );
      }
    }
  }

  return {
    sourceRoot: toPosix(sourceRoot),
    targetRoot: toPosix(targetRoot),
    mode,
    files: sourceEntries.length,
    sha256: sourceDigest,
  };
}

function hashFile(repoAbs: string, relPath: string): ConsumerDigest {
  return { path: toPosix(relPath), sha256: sha256File(resolveInsideRepo(repoAbs, relPath, relPath)) };
}

/** The floor a package's own metadata declares for `target`; a missing key or
 * a value that is not the canonical floor refuses rather than defaulting. */
function declaredFloor(packageJsonAbs: string, target: "node" | "bun"): string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(packageJsonAbs, "utf8"));
  } catch {
    refuse("consumer.schema-invalid", `unreadable package metadata ${packageJsonAbs}`);
  }
  const manifest = assertRecord(raw, `package metadata ${packageJsonAbs}`);
  if (!("engines" in manifest) || manifest.engines === undefined) {
    refuse(
      "consumer.runtime-mismatch",
      `${packageJsonAbs} declares no engines.${target} floor for its runtime target`,
    );
  }
  const engines = assertRecord(manifest.engines, `${packageJsonAbs} engines`);
  const declared = engines[target];
  if (typeof declared !== "string" || declared.length === 0) {
    refuse(
      "consumer.runtime-mismatch",
      `${packageJsonAbs} declares no engines.${target} floor for its runtime target`,
    );
  }
  if (declared !== CANONICAL_RUNTIME_FLOOR[target]) {
    refuse(
      "consumer.runtime-mismatch",
      `${packageJsonAbs} engines.${target} is ${declared}, not the canonical ${CANONICAL_RUNTIME_FLOOR[target]}`,
    );
  }
  return declared;
}

function buildConsumer(repoAbs: string, layout: ConsumerLayout): ExecutionConsumerEntry {
  const packageRootAbs = resolveInsideRepo(repoAbs, layout.packageRoot, `package root ${layout.packageRoot}`);
  if (!existsSync(packageRootAbs) || !statSync(packageRootAbs).isDirectory()) {
    refuse("consumer.path-missing", `missing package root ${layout.packageRoot}`);
  }

  let runtime: ConsumerRuntime;
  if (layout.runtime.declaration === "package-engines") {
    const packageJson = layout.packageJson;
    if (packageJson === null) {
      refuse("consumer.schema-invalid", `${layout.id} declares package-engines without a manifest`);
    }
    runtime = {
      target: layout.runtime.target,
      floor: declaredFloor(resolveInsideRepo(repoAbs, packageJson, packageJson), layout.runtime.target),
      declaration: layout.runtime.declaration,
    };
  } else {
    runtime = {
      target: layout.runtime.target,
      floor: CANONICAL_RUNTIME_FLOOR[layout.runtime.target],
      declaration: layout.runtime.declaration,
    };
  }

  const generatedTrees = layout.generatedTrees
    .map((spec) => digestTree(repoAbs, spec))
    .sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
  for (const tree of generatedTrees) {
    if (tree.files === 0) {
      refuse(
        "consumer.generated-empty",
        `${layout.id} has no build output under ${tree.root} — build the package before writing a manifest`,
      );
    }
  }

  const generatedFiles = layout.generatedFiles
    .map((rel) => hashFile(repoAbs, rel))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (generatedFiles.length === 0) {
    refuse("consumer.generated-missing", `${layout.id} declares no generated artifact`);
  }
  for (const artifact of generatedFiles) {
    const abs = resolveInsideRepo(repoAbs, artifact.path, artifact.path);
    if (!existsSync(abs)) {
      refuse("consumer.generated-missing", `${layout.id} is missing build output ${artifact.path}`);
    }
    if (statSync(abs).size === 0) {
      refuse("consumer.generated-empty", `${layout.id} has empty build output ${artifact.path}`);
    }
  }
  if (!generatedFiles.some((artifact) => artifact.path === toPosix(layout.entrypoint))) {
    refuse(
      "consumer.generated-missing",
      `${layout.id} entrypoint ${layout.entrypoint} is not a declared generated artifact`,
    );
  }
  const entrypointAbs = resolveInsideRepo(repoAbs, layout.entrypoint, `entrypoint ${layout.entrypoint}`);
  if (!existsSync(entrypointAbs)) {
    refuse("consumer.generated-missing", `${layout.id} is missing build output ${layout.entrypoint}`);
  }

  const sourceFiles = layout.sourceFiles
    .map((rel) => hashFile(repoAbs, rel))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sourceTrees = layout.sourceTrees
    .map((spec) => digestTree(repoAbs, spec))
    .sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));

  const copiedInstructions = layout.copies
    .map((copy) => hashCopiedTree(repoAbs, copy.from, copy.to, copy.mode))
    .sort((a, b) => (a.targetRoot < b.targetRoot ? -1 : a.targetRoot > b.targetRoot ? 1 : 0));

  return {
    id: layout.id,
    packageRoot: toPosix(layout.packageRoot),
    capability: layout.capability,
    capabilityNote: layout.capabilityNote,
    entrypoint: toPosix(layout.entrypoint),
    runtime,
    sources: { trees: sourceTrees, files: sourceFiles },
    generated: { trees: generatedTrees, files: generatedFiles },
    copiedInstructions,
  };
}

/** Build the canonical consumer inventory for a repository checkout. Refuses
 * on any missing/empty build output, missing input or copied tree, unreadable
 * metadata or symlink escaping the checkout — a manifest is never fabricated
 * from partial state. */
export function collectExecutionConsumerManifest(repoRoot: string): ExecutionConsumerManifest {
  const given = repoRoot.length === 0 ? "." : repoRoot;
  if (!existsSync(resolve(given))) {
    refuse("consumer.path-missing", `repo root does not exist: ${given}`);
  }
  const repoAbs = realpathSync(resolve(given));
  const consumers = CONSUMER_LAYOUTS.map((layout) => buildConsumer(repoAbs, layout)).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return { version: 1, protocol: CONSUMER_MANIFEST_PROTOCOL, repoRoot: given, consumers };
}

function assertDigest(value: unknown, context: string): string {
  if (typeof value !== "string" || !HEX64.test(value)) {
    refuse("consumer.schema-invalid", `${context} is not a lowercase SHA256 digest`);
  }
  return value;
}

function assertString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    refuse("consumer.schema-invalid", `${context} must be a non-empty string`);
  }
  return value;
}

function assertRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse("consumer.schema-invalid", `${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertArray(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    refuse("consumer.schema-invalid", `${context} must be an array`);
  }
  return value;
}

function assertCount(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    refuse("consumer.schema-invalid", `${context} must be a non-negative integer`);
  }
  return value;
}

/** Re-derive every recorded fact from the bytes on disk and the canonical
 * layout, without running any build or generator. Any drift — build input,
 * generated output, copied instruction tree, runtime floor, capability, digest
 * or layout fact — refuses, and recorded paths are canonicalized and
 * containment-checked before any read. */
export function verifyExecutionConsumerManifest(manifest: ExecutionConsumerManifest): void {
  const document = assertRecord(manifest, "manifest");
  if (document.version !== 1) {
    refuse("consumer.schema-invalid", `unsupported manifest version ${String(document.version)}`);
  }
  if (document.protocol !== CONSUMER_MANIFEST_PROTOCOL) {
    refuse(
      "consumer.protocol-unsupported",
      `expected protocol ${CONSUMER_MANIFEST_PROTOCOL}, found ${String(document.protocol)}`,
    );
  }
  const givenRoot = assertString(document.repoRoot, "repoRoot");
  if (!existsSync(resolve(givenRoot))) {
    refuse("consumer.path-missing", `repo root does not exist: ${givenRoot}`);
  }
  const repoAbs = realpathSync(resolve(givenRoot));
  const rawConsumers = assertArray(document.consumers, "consumers");
  if (rawConsumers.length === 0) {
    refuse("consumer.schema-invalid", "consumers must be a non-empty array");
  }

  const expectedIds = CONSUMER_LAYOUTS.map((layout) => layout.id).sort();
  const seen = new Set<string>();
  const actualIds: string[] = [];
  for (const rawConsumer of rawConsumers) {
    const id = assertString(assertRecord(rawConsumer, "consumer").id, "consumer.id");
    if (seen.has(id)) refuse("consumer.consumer-set-mismatch", `duplicate consumer ${id}`);
    seen.add(id);
    actualIds.push(id);
  }
  actualIds.sort();
  if (actualIds.length !== expectedIds.length || actualIds.some((id, i) => id !== expectedIds[i])) {
    refuse(
      "consumer.consumer-set-mismatch",
      `manifest consumers [${actualIds.join(", ")}] do not match the canonical [${expectedIds.join(", ")}]`,
    );
  }

  for (const rawConsumer of rawConsumers) {
    const consumer = assertRecord(rawConsumer, "consumer");
    const id = assertString(consumer.id, "consumer.id");
    const layout = CONSUMER_LAYOUTS.find((candidate) => candidate.id === id);
    if (layout === undefined) {
      refuse("consumer.consumer-set-mismatch", `unknown consumer ${id}`);
    }

    if (consumer.capability !== layout.capability) {
      refuse(
        "consumer.capability-mismatch",
        `${id} declares capability ${String(consumer.capability)}, expected ${layout.capability}`,
      );
    }
    if (layout.capabilityNote === null) {
      if (consumer.capabilityNote !== null) {
        refuse("consumer.capability-mismatch", `${id} carries an unexpected capability note`);
      }
    } else if (consumer.capabilityNote !== layout.capabilityNote) {
      refuse(
        "consumer.capability-mismatch",
        `${id} capability note does not match the canonical declaration`,
      );
    }

    const packageRoot = assertString(consumer.packageRoot, `${id}.packageRoot`);
    resolveInsideRepo(repoAbs, packageRoot, `${id}.packageRoot`);
    if (packageRoot !== toPosix(layout.packageRoot)) {
      refuse(
        "consumer.schema-invalid",
        `${id}.packageRoot is ${packageRoot}, expected ${toPosix(layout.packageRoot)}`,
      );
    }

    const runtime = assertRecord(consumer.runtime, `${id}.runtime`);
    const expectedRuntime: ConsumerRuntime =
      layout.runtime.declaration === "package-engines"
        ? {
            target: layout.runtime.target,
            declaration: "package-engines",
            floor: declaredFloor(
              resolveInsideRepo(repoAbs, layout.packageJson as string, layout.packageJson as string),
              layout.runtime.target,
            ),
          }
        : {
            target: layout.runtime.target,
            declaration: "canonical-floor",
            floor: CANONICAL_RUNTIME_FLOOR[layout.runtime.target],
          };
    if (
      runtime.target !== expectedRuntime.target ||
      runtime.declaration !== expectedRuntime.declaration ||
      runtime.floor !== expectedRuntime.floor
    ) {
      refuse(
        "consumer.runtime-mismatch",
        `${id} records runtime ${JSON.stringify(runtime)} but the source declares ${JSON.stringify(expectedRuntime)}`,
      );
    }

    const entrypoint = assertString(consumer.entrypoint, `${id}.entrypoint`);
    if (entrypoint !== toPosix(layout.entrypoint)) {
      refuse(
        "consumer.generated-missing",
        `${id} records entrypoint ${entrypoint}, expected ${toPosix(layout.entrypoint)}`,
      );
    }

    const checkDigestFiles = (
      kind: "sources" | "generated",
      value: unknown,
      expectedPaths: readonly string[],
    ): readonly string[] => {
      const set = assertRecord(value, `${id}.${kind}`);
      const recorded: { path: string; sha256: string }[] = assertArray(
        set.files,
        `${id}.${kind}.files`,
      ).map((raw) => {
        const digest = assertRecord(raw, `${id}.${kind}.files[]`);
        const path = assertString(digest.path, `${id}.${kind}.files[].path`);
        // Containment before comparison or read: a recorded path that leaves
        // the repository (including via a symlink) never gets inspected.
        resolveInsideRepo(repoAbs, path, `${id}.${kind}.files[${path}]`);
        return { path, sha256: assertDigest(digest.sha256, `${id}.${kind}.files[${path}].sha256`) };
      });
      const sortedExpected = [...expectedPaths].sort();
      const sortedActual = recorded.map((digest) => digest.path).sort();
      if (
        sortedActual.length !== sortedExpected.length ||
        sortedActual.some((path, i) => path !== sortedExpected[i])
      ) {
        refuse(
          "consumer.consumer-set-mismatch",
          `${id}.${kind}.files [${sortedActual.join(", ")}] does not match the canonical [${sortedExpected.join(", ")}]`,
        );
      }
      for (const digest of recorded) {
        const recomputed = hashFile(repoAbs, digest.path);
        if (recomputed.sha256 !== digest.sha256) {
          refuse("consumer.digest-mismatch", `${id}.${kind}.files digest for ${digest.path} is stale`);
        }
        if (kind === "generated") {
          if (statSync(resolveInsideRepo(repoAbs, digest.path, digest.path)).size === 0) {
            refuse("consumer.generated-empty", `${id} has empty build output ${digest.path}`);
          }
        }
      }
      return recorded.map((digest) => digest.path);
    };

    const checkDigestTrees = (
      kind: "sources" | "generated",
      value: unknown,
      specs: readonly DigestTreeSpec[],
    ): void => {
      const set = assertRecord(value, `${id}.${kind}`);
      const recorded: { root: string; files: number; sha256: string }[] = assertArray(
        set.trees,
        `${id}.${kind}.trees`,
      ).map((raw) => {
        const tree = assertRecord(raw, `${id}.${kind}.trees[]`);
        const root = assertString(tree.root, `${id}.${kind}.trees[].root`);
        resolveInsideRepo(repoAbs, root, `${id}.${kind}.trees[${root}]`);
        return {
          root,
          files: assertCount(tree.files, `${id}.${kind}.trees[${root}].files`),
          sha256: assertDigest(tree.sha256, `${id}.${kind}.trees[${root}].sha256`),
        };
      });
      const sortedExpected = specs.map((spec) => toPosix(spec.root)).sort();
      const sortedActual = recorded.map((tree) => tree.root).sort();
      if (
        sortedActual.length !== sortedExpected.length ||
        sortedActual.some((root, i) => root !== sortedExpected[i])
      ) {
        refuse(
          "consumer.consumer-set-mismatch",
          `${id}.${kind}.trees [${sortedActual.join(", ")}] does not match the canonical [${sortedExpected.join(", ")}]`,
        );
      }
      for (const spec of specs) {
        const recomputed = digestTree(repoAbs, spec);
        const recordedTree = recorded.find((tree) => tree.root === toPosix(spec.root));
        if (recomputed.files === 0 && kind === "generated") {
          refuse("consumer.generated-empty", `${id} has no build output under ${recomputed.root}`);
        }
        if (
          recordedTree === undefined ||
          recordedTree.sha256 !== recomputed.sha256 ||
          recordedTree.files !== recomputed.files
        ) {
          refuse("consumer.digest-mismatch", `${id}.${kind} tree ${recomputed.root} is stale`);
        }
      }
    };

    const generatedPaths = checkDigestFiles("generated", consumer.generated, layout.generatedFiles);
    if (!generatedPaths.includes(entrypoint)) {
      refuse(
        "consumer.generated-missing",
        `${id} entrypoint ${entrypoint} is not part of the recorded generated set`,
      );
    }
    checkDigestFiles("sources", consumer.sources, layout.sourceFiles);
    checkDigestTrees("sources", consumer.sources, layout.sourceTrees);
    checkDigestTrees("generated", consumer.generated, layout.generatedTrees);

    const copyTrees: {
      sourceRoot: string;
      targetRoot: string;
      mode: unknown;
      files: number;
      sha256: string;
    }[] = assertArray(consumer.copiedInstructions, `${id}.copiedInstructions`).map((raw) => {
      const tree = assertRecord(raw, `${id}.copiedInstructions[]`);
      const sourceRoot = assertString(tree.sourceRoot, `${id}.copiedInstructions[].source`);
      const targetRoot = assertString(tree.targetRoot, `${id}.copiedInstructions[].target`);
      resolveInsideRepo(repoAbs, sourceRoot, `${id}.copiedInstructions.source`);
      resolveInsideRepo(repoAbs, targetRoot, `${id}.copiedInstructions.target`);
      return {
        sourceRoot,
        targetRoot,
        mode: tree.mode,
        files: assertCount(tree.files, `${id}.copiedInstructions[${targetRoot}].files`),
        sha256: assertDigest(tree.sha256, `${id}.copiedInstructions[${targetRoot}].sha256`),
      };
    });
    const expectedCopyRoots = layout.copies
      .map((copy) => `${toPosix(copy.from)}->${toPosix(copy.to)}`)
      .sort();
    const actualCopyRoots = copyTrees
      .map((tree) => `${tree.sourceRoot}->${tree.targetRoot}`)
      .sort();
    if (
      actualCopyRoots.length !== expectedCopyRoots.length ||
      actualCopyRoots.some((root, i) => root !== expectedCopyRoots[i])
    ) {
      refuse(
        "consumer.consumer-set-mismatch",
        `${id}.copiedInstructions [${actualCopyRoots.join(", ")}] does not match the canonical [${expectedCopyRoots.join(", ")}]`,
      );
    }
    for (const copy of layout.copies) {
      const tree = copyTrees.find(
        (candidate) =>
          candidate.sourceRoot === toPosix(copy.from) && candidate.targetRoot === toPosix(copy.to),
      );
      if (tree === undefined) {
        refuse(
          "consumer.consumer-set-mismatch",
          `${id}.copiedInstructions has no canonical mapping for ${copy.to}`,
        );
      }
      if (tree.mode !== copy.mode) {
        refuse(
          "consumer.schema-invalid",
          `${id}.copiedInstructions[${copy.to}].mode must be ${copy.mode}`,
        );
      }
      const recomputed = hashCopiedTree(repoAbs, copy.from, copy.to, copy.mode);
      if (recomputed.sha256 !== tree.sha256 || recomputed.files !== tree.files) {
        refuse("consumer.digest-mismatch", `${id} copied instruction tree ${copy.to} is stale`);
      }
    }
  }
}

/** Deterministic serialization of a manifest document. */
export function serializeExecutionConsumerManifest(manifest: ExecutionConsumerManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Every path `--write` emits: one manifest per package `dist/` (engine, CLI,
 * DSh, OMP, OpenCode) plus the ZCode plugin-root copy. */
export function executionConsumerManifestPaths(repoRoot: string): readonly string[] {
  const packageManifests = CONSUMER_LAYOUTS.filter(
    (layout) => layout.packageJson !== null,
  ).map((layout) => `${toPosix(layout.packageRoot)}/dist/${MANIFEST_BASENAME}`);
  return [...packageManifests.sort(), `hooks/${MANIFEST_BASENAME}`].map((rel) => join(repoRoot, rel));
}

const USAGE =
  "usage: bun scripts/execution-consumer-manifest.ts --repo <path> (--write | --check)";

interface CliOptions {
  readonly repo: string;
  readonly mode: "write" | "check";
}

function parseCli(argv: readonly string[]): CliOptions {
  let repo = ".";
  let mode: CliOptions["mode"] | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo") {
      const value = argv[++i];
      if (value === undefined) refuse("consumer.schema-invalid", "--repo requires a path");
      repo = value;
    } else if (arg === "--write") {
      mode = "write";
    } else if (arg === "--check") {
      mode = "check";
    } else {
      refuse("consumer.schema-invalid", `unknown argument ${arg}`);
    }
  }
  if (mode === null) refuse("consumer.schema-invalid", "one of --write or --check is required");
  return { repo, mode };
}

/** Write a manifest copy without following a foreign target: the parent is
 * canonicalized inside the checkout, a symlinked target refuses, and the bytes
 * land through a temp file plus rename. */
function writeManifestCopy(repoAbs: string, target: string, text: string): void {
  const parent = canonicalInsideRepo(repoAbs, dirname(target), `manifest parent ${target}`);
  mkdirSync(parent, { recursive: true });
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    refuse("consumer.path-outside-root", `refusing to write through a symlinked manifest ${target}`);
  }
  canonicalInsideRepo(repoAbs, target, `manifest ${target}`);
  const staging = `${target}.tmp-${process.pid}`;
  writeFileSync(staging, text);
  renameSync(staging, target);
}

function readManifestCopy(repoAbs: string, target: string): string {
  const canonical = canonicalInsideRepo(repoAbs, target, `manifest ${target}`);
  if (lstatSync(canonical).isSymbolicLink()) {
    refuse("consumer.path-outside-root", `refusing to read a symlinked manifest ${target}`);
  }
  return readFileSync(canonical, "utf8");
}

/** Run the CLI. Returns the process exit code (0 ok, 1 refusal, 2 usage). */
export async function runExecutionConsumerManifestCli(
  argv: readonly string[],
  cwd: string = process.cwd(),
): Promise<number> {
  if (argv.includes("--help") || argv.length === 0) {
    console.log(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  let options: CliOptions;
  try {
    options = parseCli(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }

  try {
    const repoInput = isAbsolute(options.repo) ? options.repo : resolve(cwd, options.repo);
    if (!existsSync(repoInput)) {
      refuse("consumer.path-missing", `repo root does not exist: ${options.repo}`);
    }
    const repoAbs = realpathSync(repoInput);
    const targets = executionConsumerManifestPaths(repoAbs);

    if (options.mode === "write") {
      const manifest = collectExecutionConsumerManifest(options.repo);
      const text = serializeExecutionConsumerManifest(manifest);
      for (const target of targets) writeManifestCopy(repoAbs, target, text);
      console.log(
        `execution-consumer-manifest: wrote ${targets.length} manifest(s) for ${manifest.consumers.length} consumers`,
      );
      return 0;
    }

    let reference: string | null = null;
    let document: Record<string, unknown> | null = null;
    for (const target of targets) {
      if (!existsSync(target)) {
        refuse("consumer.manifest-missing", `manifest not written yet: ${target}`);
      }
      const text = readManifestCopy(repoAbs, target);
      if (reference !== null && text !== reference) {
        refuse("consumer.manifest-drift", `manifest copies disagree: ${target}`);
      }
      if (document === null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          refuse("consumer.schema-invalid", `manifest is not valid JSON: ${target}`);
        }
        document = assertRecord(parsed, `manifest ${target}`);
      }
      reference = text;
    }
    const recordedRoot = assertString(document?.repoRoot, "repoRoot");
    const recordedAbs = realpathSync(resolve(cwd, recordedRoot));
    if (repoAbs !== recordedAbs) {
      refuse(
        "consumer.repo-root-mismatch",
        `manifest was produced for ${recordedRoot}, not ${options.repo}`,
      );
    }
    // `document` was shape-checked to an object; verify() re-validates every
    // field it reads, so this boundary cast adds no unchecked access.
    const validated = document as unknown as ExecutionConsumerManifest;
    verifyExecutionConsumerManifest(validated);
    console.log(
      `execution-consumer-manifest: verified ${targets.length} manifest(s) for ${validated.consumers.length} consumers`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ExecutionConsumerManifestError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exit(await runExecutionConsumerManifestCli(process.argv.slice(2)));
}
