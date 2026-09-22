/**
 * scripts/execution-consumer-manifest.ts — source/package/instruction
 * inventory producer and parity validator (phase 2b execution contract §4.2
 * package/instruction result, §7 R1, §9 rows S12/S16/S17; protocol
 * `consumer-v1`).
 *
 * What this records, per consumer: the canonical build-entry source digests,
 * the generated artifact digests, the entrypoint, the exact runtime target and
 * floor, the declared capability, and the canonical copied-instruction trees
 * that package their assets from the repo-root `skills/`, `commands/`,
 * `agents/` corpus.
 *
 * This is packaging evidence only. It never inspects an installed consumer,
 * never reads a home directory, never bumps a version and never invents
 * parity: a missing or empty build output refuses instead of producing a
 * manifest. The layouts below mirror the existing build scripts (each
 * package's `build`/`bundle-assets` script and `scripts/build-zcode-hooks.ts`)
 * — this is an inventory over those layouts, not a second build system.
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
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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

/** One `skills/`|`commands/`|`agents/` tree that a package bundles. `copy`
 * targets must match the source tree exactly; `merge` targets are supersets
 * (an overlay appends host-only files) so every source file must appear in the
 * target with identical bytes and link target. Both modes hash the source tree,
 * so a stale copy — or a stale source — invalidates the manifest. */
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
  readonly sources: readonly ConsumerDigest[];
  readonly generated: readonly ConsumerDigest[];
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
  | "consumer.copy-symlink-unresolved"
  | "consumer.copy-symlink-escapes-tree"
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
  readonly sources: readonly string[];
  readonly generated: readonly string[];
  readonly copies: readonly ConsumerCopyLayout[];
}

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

/** The canonical consumer inventory. Derived from the existing build layouts:
 * `packages/engine` (+audit), `packages/cli`, `packages/dsh` (+invariant),
 * `packages/omp` (pre-hook + two extensions + six tool bundles),
 * `packages/opencode` and the committed ZCode hook. */
export const CONSUMER_LAYOUTS: readonly ConsumerLayout[] = [
  {
    id: "engine",
    packageRoot: "packages/engine",
    capability: "writer",
    capabilityNote: null,
    runtime: { target: "node", declaration: "package-engines" },
    packageJson: "packages/engine/package.json",
    entrypoint: "packages/engine/dist/engine.js",
    sources: ["packages/engine/package.json", "packages/engine/src/index.ts"],
    generated: ["packages/engine/dist/audit.js", "packages/engine/dist/engine.js"],
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
    sources: ["packages/cli/package.json", "packages/cli/src/index.ts"],
    generated: ["packages/cli/dist/mstar-harness.js"],
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
    sources: [
      "packages/dsh/package.json",
      "packages/dsh/src/index.ts",
      "packages/dsh/src/invariant.ts",
    ],
    generated: ["packages/dsh/dist/index.js", "packages/dsh/dist/invariant.js"],
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
    sources: [
      "packages/omp/package.json",
      "packages/omp/src/extensions/model-handoff.ts",
      "packages/omp/src/extensions/phase2-orchestration.ts",
      "packages/omp/src/hooks/pre/mstar-gates.ts",
    ],
    generated: [
      "packages/omp/dist/extensions/model-handoff.js",
      "packages/omp/dist/extensions/phase2-orchestration.js",
      "packages/omp/dist/hooks/pre/mstar-gates.js",
      "packages/omp/dist/tools/mstar_dispatch_validate/index.js",
      "packages/omp/dist/tools/mstar_iteration_gate/index.js",
      "packages/omp/dist/tools/mstar_lease_verify/index.js",
      "packages/omp/dist/tools/mstar_path_resolve/index.js",
      "packages/omp/dist/tools/mstar_status_validate/index.js",
      "packages/omp/dist/tools/mstar_worktree_check/index.js",
    ],
    copies: OMP_HARNESS_ASSET_COPIES,
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
    sources: ["packages/opencode/package.json", "packages/opencode/src/mstar.ts"],
    generated: ["packages/opencode/dist/mstar.js"],
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
    sources: ["hooks/src/mstar-write-gate.ts"],
    generated: ["hooks/mstar-write-gate.mjs"],
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

/** Reject absolute, backslashed and traversal-bearing recorded paths, and any
 * path that resolves outside the repository root. Runs before any read so an
 * installed or foreign path can never be inspected. */
function resolveInsideRepo(rootAbs: string, relPath: string): string {
  if (relPath.length === 0 || isAbsolute(relPath) || relPath.includes("\\")) {
    refuse("consumer.path-outside-root", `recorded path is not repo-relative: ${relPath}`);
  }
  const abs = resolve(rootAbs, relPath);
  const prefix = rootAbs.endsWith("/") ? rootAbs : `${rootAbs}/`;
  if (abs !== rootAbs && !abs.startsWith(prefix)) {
    refuse("consumer.path-outside-root", `recorded path escapes the repo root: ${relPath}`);
  }
  return abs;
}

interface TreeEntry {
  readonly path: string;
  readonly kind: "file" | "symlink";
  readonly sha256: string;
  readonly linkTarget: string | null;
}

/** Walk a copied-instruction tree into canonical entries. A symlink is
 * recorded by the canonical repo-relative path it resolves to plus the
 * resolved bytes, so the source tree and the copied tree hash identically only
 * when every file, byte and link target matches. */
function treeEntries(rootAbs: string, repoAbs: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const walk = (dirAbs: string, relDir: string): void => {
    const dirents = readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const dirent of dirents) {
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
          refuse("consumer.copy-symlink-unresolved", `${rootAbs}: dangling symlink ${rel}`);
        }
        const linkTarget = toPosix(relative(repoAbs, resolved));
        if (linkTarget.length === 0 || isAbsolute(linkTarget) || linkTarget.startsWith("../")) {
          refuse(
            "consumer.copy-symlink-escapes-tree",
            `${rootAbs}: symlink ${rel} resolves outside the repository`,
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

function hashCopiedTree(
  repoAbs: string,
  sourceRoot: string,
  targetRoot: string,
  mode: CopiedInstructionMode,
): CopiedInstructionTree {
  const sourceAbs = resolveInsideRepo(repoAbs, sourceRoot);
  const targetAbs = resolveInsideRepo(repoAbs, targetRoot);
  if (!existsSync(sourceAbs)) {
    refuse("consumer.copy-root-missing", `missing copied-instruction source ${sourceRoot}`);
  }
  if (!existsSync(targetAbs)) {
    refuse("consumer.copy-root-missing", `missing copied-instruction target ${targetRoot}`);
  }
  const sourceEntries = treeEntries(sourceAbs, repoAbs);
  const sourceDigest = createHash("sha256").update(JSON.stringify(sourceEntries)).digest("hex");

  if (mode === "copy") {
    const targetDigest = createHash("sha256")
      .update(JSON.stringify(treeEntries(targetAbs, repoAbs)))
      .digest("hex");
    if (sourceDigest !== targetDigest) {
      refuse(
        "consumer.digest-mismatch",
        `copied instruction tree ${targetRoot} does not match its source ${sourceRoot}`,
      );
    }
  } else {
    // Overlay merge: the target is a superset, so every source entry must be
    // present with identical bytes and link target (host-only extras allowed).
    const targetByPath = new Map(treeEntries(targetAbs, repoAbs).map((entry) => [entry.path, entry]));
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
    sourceRoot: toPosix(relative(repoAbs, sourceAbs)),
    targetRoot: toPosix(relative(repoAbs, targetAbs)),
    mode,
    files: sourceEntries.length,
    sha256: sourceDigest,
  };
}

function hashFile(repoAbs: string, relPath: string): ConsumerDigest {
  const abs = resolveInsideRepo(repoAbs, relPath);
  return { path: toPosix(relative(repoAbs, abs)), sha256: sha256File(abs) };
}

/** The floor a package's own metadata declares for `target`; missing keys
 * refuse rather than defaulting to the canonical floor. */
function declaredFloor(packageJsonAbs: string, target: "node" | "bun"): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonAbs, "utf8"));
  } catch {
    refuse("consumer.schema-invalid", `unreadable package metadata ${packageJsonAbs}`);
  }
  const engines =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { engines?: Record<string, unknown> }).engines
      : undefined;
  const declared = engines?.[target];
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
  const packageRootAbs = resolveInsideRepo(repoAbs, layout.packageRoot);
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
      floor: declaredFloor(resolveInsideRepo(repoAbs, packageJson), layout.runtime.target),
      declaration: layout.runtime.declaration,
    };
  } else {
    runtime = {
      target: layout.runtime.target,
      floor: CANONICAL_RUNTIME_FLOOR[layout.runtime.target],
      declaration: layout.runtime.declaration,
    };
  }

  const generated = layout.generated
    .map((rel) => hashFile(repoAbs, rel))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (generated.length === 0) {
    refuse("consumer.generated-missing", `${layout.id} declares no generated artifact`);
  }
  for (const artifact of generated) {
    if (statSync(resolveInsideRepo(repoAbs, artifact.path)).size === 0) {
      refuse("consumer.generated-empty", `${layout.id} has empty build output ${artifact.path}`);
    }
  }

  const entrypointAbs = resolveInsideRepo(repoAbs, layout.entrypoint);
  if (!generated.some((artifact) => artifact.path === layout.entrypoint)) {
    refuse(
      "consumer.generated-missing",
      `${layout.id} entrypoint ${layout.entrypoint} is not a declared generated artifact`,
    );
  }
  if (!existsSync(entrypointAbs)) {
    refuse("consumer.generated-missing", `${layout.id} is missing build output ${layout.entrypoint}`);
  }

  const sources = layout.sources
    .map((rel) => hashFile(repoAbs, rel))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const copiedInstructions = layout.copies
    .map((copy) => hashCopiedTree(repoAbs, copy.from, copy.to, copy.mode))
    .sort((a, b) => (a.targetRoot < b.targetRoot ? -1 : a.targetRoot > b.targetRoot ? 1 : 0));

  return {
    id: layout.id,
    packageRoot: toPosix(relative(repoAbs, packageRootAbs)) || ".",
    capability: layout.capability,
    capabilityNote: layout.capabilityNote,
    entrypoint: toPosix(relative(repoAbs, entrypointAbs)),
    runtime,
    sources,
    generated,
    copiedInstructions,
  };
}

/** Build the canonical consumer inventory for a repository checkout. Refuses
 * on any missing/empty build output, missing copied tree or metadata mismatch —
 * a manifest is never fabricated from partial state. */
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

/** Re-derive every recorded fact from the bytes on disk and the canonical
 * layout, without running any build or generator. Any drift — source, generated
 * artifact, copied instruction tree, runtime floor, capability or digest —
 * refuses. */
export function verifyExecutionConsumerManifest(manifest: ExecutionConsumerManifest): void {
  if (typeof manifest !== "object" || manifest === null) {
    refuse("consumer.schema-invalid", "manifest is not an object");
  }
  if (manifest.version !== 1) {
    refuse("consumer.schema-invalid", `unsupported manifest version ${String(manifest.version)}`);
  }
  if (manifest.protocol !== CONSUMER_MANIFEST_PROTOCOL) {
    refuse(
      "consumer.protocol-unsupported",
      `expected protocol ${CONSUMER_MANIFEST_PROTOCOL}, found ${String(manifest.protocol)}`,
    );
  }
  const givenRoot = assertString(manifest.repoRoot, "repoRoot");
  if (!existsSync(resolve(givenRoot))) {
    refuse("consumer.path-missing", `repo root does not exist: ${givenRoot}`);
  }
  const repoAbs = realpathSync(resolve(givenRoot));

  const consumers: readonly ExecutionConsumerEntry[] = Array.isArray(manifest.consumers)
    ? manifest.consumers
    : refuse("consumer.schema-invalid", "consumers must be a non-empty array");
  if (consumers.length === 0) {
    refuse("consumer.schema-invalid", "consumers must be a non-empty array");
  }
  const expectedIds = CONSUMER_LAYOUTS.map((layout) => layout.id).sort();
  const seen = new Set<string>();
  const actualIds: string[] = [];
  for (const consumer of consumers) {
    const id = assertString(consumer.id, "consumer.id");
    if (seen.has(id)) {
      refuse("consumer.consumer-set-mismatch", `duplicate consumer ${id}`);
    }
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

  for (const consumer of consumers) {
    const layout = CONSUMER_LAYOUTS.find((candidate) => candidate.id === consumer.id);
    if (layout === undefined) {
      refuse("consumer.consumer-set-mismatch", `unknown consumer ${consumer.id}`);
    }

    if (consumer.capability !== layout.capability) {
      refuse(
        "consumer.capability-mismatch",
        `${consumer.id} declares capability ${String(consumer.capability)}, expected ${layout.capability}`,
      );
    }
    if ((layout.capabilityNote === null) !== (consumer.capabilityNote === null)) {
      refuse(
        "consumer.capability-mismatch",
        `${consumer.id} capability note does not match the canonical declaration`,
      );
    }
    if (layout.capabilityNote !== null && consumer.capabilityNote !== layout.capabilityNote) {
      refuse(
        "consumer.capability-mismatch",
        `${consumer.id} capability note does not match the canonical declaration`,
      );
    }

    const expectedRuntime: ConsumerRuntime =
      layout.runtime.declaration === "package-engines"
        ? {
            target: layout.runtime.target,
            declaration: "package-engines",
            floor: declaredFloor(
              resolveInsideRepo(repoAbs, layout.packageJson as string),
              layout.runtime.target,
            ),
          }
        : {
            target: layout.runtime.target,
            declaration: "canonical-floor",
            floor: CANONICAL_RUNTIME_FLOOR[layout.runtime.target],
          };
    if (
      consumer.runtime.target !== expectedRuntime.target ||
      consumer.runtime.declaration !== expectedRuntime.declaration ||
      consumer.runtime.floor !== expectedRuntime.floor
    ) {
      refuse(
        "consumer.runtime-mismatch",
        `${consumer.id} records runtime ${JSON.stringify(consumer.runtime)} but the source declares ${JSON.stringify(expectedRuntime)}`,
      );
    }

    const expectedEntrypoint = toPosix(layout.entrypoint);
    if (consumer.entrypoint !== expectedEntrypoint) {
      refuse(
        "consumer.generated-missing",
        `${consumer.id} records entrypoint ${String(consumer.entrypoint)}, expected ${expectedEntrypoint}`,
      );
    }

    const checkDigests = (
      kind: "sources" | "generated",
      recorded: readonly ConsumerDigest[],
      expectedPaths: readonly string[],
    ): void => {
      if (!Array.isArray(recorded)) {
        refuse("consumer.schema-invalid", `${consumer.id}.${kind} must be an array`);
      }
      // Containment first: a recorded path that would leave the repository is
      // refused before any comparison or read, so foreign/installed state can
      // never be inspected.
      const paths: string[] = [];
      for (const digest of recorded) {
        const path = assertString(digest.path, `${consumer.id}.${kind}.path`);
        resolveInsideRepo(repoAbs, path);
        paths.push(path);
      }
      const sortedExpected = [...expectedPaths].sort();
      const sortedActual = [...paths].sort();
      if (
        sortedActual.length !== sortedExpected.length ||
        sortedActual.some((path, i) => path !== sortedExpected[i])
      ) {
        refuse(
          "consumer.consumer-set-mismatch",
          `${consumer.id}.${kind} [${sortedActual.join(", ")}] does not match the canonical [${sortedExpected.join(", ")}]`,
        );
      }
      for (const digest of recorded) {
        const recomputed = hashFile(repoAbs, digest.path);
        assertDigest(digest.sha256, `${consumer.id}.${kind}[${digest.path}].sha256`);
        if (recomputed.sha256 !== digest.sha256) {
          refuse(
            "consumer.digest-mismatch",
            `${consumer.id}.${kind} digest for ${digest.path} is stale`,
          );
        }
      }
      if (kind === "generated") {
        for (const digest of recorded) {
          if (statSync(resolveInsideRepo(repoAbs, digest.path)).size === 0) {
            refuse("consumer.generated-empty", `${consumer.id} has empty build output ${digest.path}`);
          }
        }
      }
    };

    checkDigests("sources", consumer.sources, layout.sources);
    checkDigests("generated", consumer.generated, layout.generated);

    const copyTrees: readonly CopiedInstructionTree[] = Array.isArray(consumer.copiedInstructions)
      ? consumer.copiedInstructions
      : refuse("consumer.schema-invalid", `${consumer.id}.copiedInstructions must be an array`);
    const expectedCopyRoots = layout.copies
      .map((copy) => `${toPosix(copy.from)}->${toPosix(copy.to)}`)
      .sort();
    const actualCopyRoots = copyTrees
      .map(
        (tree) =>
          `${assertString(tree.sourceRoot, `${consumer.id}.copiedInstructions.source`)}->${assertString(tree.targetRoot, `${consumer.id}.copiedInstructions.target`)}`,
      )
      .sort();
    if (
      actualCopyRoots.length !== expectedCopyRoots.length ||
      actualCopyRoots.some((root, i) => root !== expectedCopyRoots[i])
    ) {
      refuse(
        "consumer.consumer-set-mismatch",
        `${consumer.id}.copiedInstructions [${actualCopyRoots.join(", ")}] does not match the canonical [${expectedCopyRoots.join(", ")}]`,
      );
    }
    for (const tree of copyTrees) {
      const copy = layout.copies.find(
        (candidate) => toPosix(candidate.from) === tree.sourceRoot && toPosix(candidate.to) === tree.targetRoot,
      );
      if (copy === undefined) {
        refuse(
          "consumer.consumer-set-mismatch",
          `${consumer.id}.copiedInstructions has no canonical mapping for ${tree.targetRoot}`,
        );
      }
      if (tree.mode !== copy.mode) {
        refuse(
          "consumer.schema-invalid",
          `${consumer.id}.copiedInstructions[${tree.targetRoot}].mode must be ${copy.mode}`,
        );
      }
      const recomputed = hashCopiedTree(repoAbs, copy.from, copy.to, copy.mode);
      assertDigest(tree.sha256, `${consumer.id}.copiedInstructions[${tree.targetRoot}].sha256`);
      if (recomputed.sha256 !== tree.sha256 || recomputed.files !== tree.files) {
        refuse(
          "consumer.digest-mismatch",
          `${consumer.id} copied instruction tree ${tree.targetRoot} is stale`,
        );
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
  ).map((layout) => `${toPosix(layout.packageRoot)}/dist/execution-consumer.json`);
  return [...packageManifests.sort(), "hooks/execution-consumer.json"].map((rel) =>
    join(repoRoot, rel),
  );
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
    const targets = executionConsumerManifestPaths(repoInput);
    if (options.mode === "write") {
      const manifest = collectExecutionConsumerManifest(options.repo);
      const text = serializeExecutionConsumerManifest(manifest);
      for (const target of targets) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text);
      }
      console.log(
        `execution-consumer-manifest: wrote ${targets.length} manifest(s) for ${manifest.consumers.length} consumers`,
      );
      return 0;
    }

    let reference: string | null = null;
    let manifest: ExecutionConsumerManifest | null = null;
    for (const target of targets) {
      if (!existsSync(target)) {
        refuse("consumer.manifest-missing", `manifest not written yet: ${target}`);
      }
      const text = readFileSync(target, "utf8");
      if (reference !== null && text !== reference) {
        refuse("consumer.manifest-drift", `manifest copies disagree: ${target}`);
      }
      reference = text;
      manifest ??= JSON.parse(text) as ExecutionConsumerManifest;
    }
    const document = manifest as ExecutionConsumerManifest;
    const repoAbs = realpathSync(repoInput);
    const recordedAbs = realpathSync(resolve(cwd, document.repoRoot));
    if (repoAbs !== recordedAbs) {
      refuse(
        "consumer.repo-root-mismatch",
        `manifest was produced for ${document.repoRoot}, not ${options.repo}`,
      );
    }
    verifyExecutionConsumerManifest(document);
    console.log(
      `execution-consumer-manifest: verified ${targets.length} manifest(s) for ${document.consumers.length} consumers`,
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
