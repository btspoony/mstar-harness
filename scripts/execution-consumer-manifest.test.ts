/**
 * scripts/execution-consumer-manifest.test.ts — parity/refusal coverage for the
 * consumer-v1 inventory producer (contract §4.2 / §7 R1).
 *
 * The fixture is a self-contained temporary checkout: a small instruction
 * corpus, the five package build layouts (source trees, config, build scripts,
 * output trees), the OMP convention mirrors and the committed ZCode hook
 * artifact.
 *
 * Instruction copies are produced by the **real bundler primitive** —
 * `fs.rmSync(target)` plus `fs.cpSync(source, target, { recursive: true })`,
 * exactly as `packages/{dsh,omp,opencode}/scripts/bundle-harness-assets.ts`
 * does (the OpenCode overlay is the merge variant without the `rmSync`). The
 * fixture therefore exercises the producer's actual copy semantics; where that
 * primitive yields a checkout-bound link instead of a portable one, the
 * validator must refuse rather than accept it.
 *
 * Nothing outside the fixture is read: the containment cases prove a recorded
 * path, symlinked root, staging path or manifest leaf that would leave the
 * checkout refuses before any bytes are touched.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  CONSUMER_MANIFEST_PROTOCOL,
  type ConsumerManifestRefusalCode,
  ExecutionConsumerManifestError,
  type ExecutionConsumerManifest,
  collectExecutionConsumerManifest,
  executionConsumerEvidenceDocuments,
  executionConsumerEvidencePaths,
  executionConsumerManifestPaths,
  runExecutionConsumerManifestCli,
  serializeExecutionConsumerEvidenceDocument,
  verifyExecutionConsumerManifest,
} from "./execution-consumer-manifest.ts";
import { serializeExecutionValue } from "../packages/engine/src/index.ts";

const SCRIPT = join(import.meta.dir, "execution-consumer-manifest.ts");
const INSTRUCTION_ROOTS = ["skills", "commands", "agents"] as const;

interface FixtureOptions {
  /** Add a self-contained in-repo instruction symlink to the `skills` corpus. */
  readonly instructionSymlink?: boolean;
}

/** Structure of a JSON-round-tripped manifest; the refusals under test need a
 * writable shape, and `verifyExecutionConsumerManifest` stays the source of
 * truth via the calls around each mutation. */
interface MutableManifest {
  version: number;
  protocol: string;
  repoRoot: string;
  consumers: {
    id: string;
    packageRoot: string;
    capability: string;
    capabilityNote: string | null;
    entrypoint: string;
    runtime: { target: string; floor: string; declaration: string } | null;
    sources: {
      trees: { root: string; files: number; sha256: string }[];
      files: { path: string; sha256: string }[];
    } | null;
    generated: {
      trees: { root: string; files: number; sha256: string }[];
      files: { path: string; sha256: string }[];
    } | null;
    copiedInstructions: {
      sourceRoot: string;
      targetRoot: string;
      mode: string;
      files: number;
      sha256: string;
    }[];
  }[];
}

const fixtures: string[] = [];

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** The `copyTree` primitive of the real bundle-assets scripts: clear the target,
 * then `cpSync(..., { recursive: true })`. */
function bundleCopy(root: string, from: string, to: string): void {
  const dest = join(root, to);
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(join(root, from), dest, { recursive: true });
}

/** The OpenCode overlay primitive (`mergeTree`): `cpSync` without the clear. */
function overlayCopy(root: string, from: string, to: string): void {
  const dest = join(root, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(root, from), dest, { recursive: true });
}

/** Mirror one built file to its package-root convention path (OMP's `cp -R`). */
function mirrorFile(root: string, from: string, to: string): void {
  const target = join(root, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, from), target);
}

function packageJson(root: string, dir: string, engines: Record<string, string>): void {
  write(
    root,
    `${dir}/package.json`,
    `${JSON.stringify({ name: `@mstar-harness/${dir.split("/").pop()}`, engines }, null, 2)}\n`,
  );
}

function scaffoldInstructions(root: string, options: FixtureOptions): void {
  write(root, "skills/mstar-demo/SKILL.md", "# demo skill\n");
  write(root, "skills/shared/note.md", "shared note\n");
  write(root, "commands/mstar-demo.md", "# demo command\n");
  write(root, "agents/mstar-demo.md", "# demo agent\n");
  if (options.instructionSymlink === true) {
    // Relative link that stays inside the `skills` tree.
    symlinkSync("../shared/note.md", join(root, "skills/mstar-demo/linked.md"));
  }
}

function buildFixture(options: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "execution-consumer-manifest-"));
  fixtures.push(root);
  scaffoldInstructions(root, options);

  write(root, "scripts/escape-dist-literals.ts", "export const escape = 1;\n");
  write(root, "scripts/ascii-literal-utils.ts", "export const mask = 1;\n");
  write(root, "scripts/build-zcode-hooks.ts", "export const hooks = 1;\n");

  packageJson(root, "packages/engine", { bun: ">=1.4.0", node: ">=24.18.0" });
  write(root, "packages/engine/tsconfig.json", '{ "include": ["src"] }\n');
  write(root, "packages/engine/src/index.ts", "export const engine = 1;\n");
  write(root, "packages/engine/src/store-db.ts", "export const store = 1;\n");
  write(root, "packages/engine/scripts/build.ts", "export const build = 1;\n");
  write(root, "packages/engine/scripts/debug-esm.ts", "export const debug = 1;\n");
  write(root, "packages/engine/dist/engine.js", "// engine bundle\n");
  write(root, "packages/engine/dist/audit.js", "// audit bundle\n");
  write(root, "packages/engine/dist/index.d.ts", "export declare const engine: number;\n");
  write(root, "packages/engine/dist/audit.d.ts", "export declare const audit: number;\n");

  packageJson(root, "packages/cli", { bun: ">=1.4.0", node: ">=24.18.0" });
  write(root, "packages/cli/tsconfig.json", '{ "include": ["src"] }\n');
  write(root, "packages/cli/src/index.ts", "export const cli = 1;\n");
  write(root, "packages/cli/scripts/build-web.ts", "export const web = 1;\n");
  write(root, "packages/cli/dist/mstar-harness.js", "// cli bundle\n");

  for (const config of [
    ".codex-plugin/mcp.json",
    ".codex-plugin/plugin.json",
    ".cursor-plugin/mcp.json",
    ".cursor-plugin/plugin.json",
    ".kimi-plugin/mcp.json",
    ".kimi-plugin/plugin.json",
    ".omp-plugin/mcp.json",
    ".zcode-plugin/mcp.json",
    ".zcode-plugin/plugin.json",
    "packages/opencode/mcp.json",
  ]) {
    write(root, config, `// ${config}\n`);
  }
  write(root, ".omp-plugin/plugin.json", '{ "name": "morning-star-harness" }\n');

  packageJson(root, "packages/dsh", { bun: ">=1.4.0" });
  write(root, "packages/dsh/tsconfig.json", '{ "include": ["src"] }\n');
  write(root, "packages/dsh/src/index.ts", "export const dsh = 1;\n");
  write(root, "packages/dsh/src/invariant.ts", "export const invariant = 1;\n");
  write(root, "packages/dsh/scripts/bundle-harness-assets.ts", "export const bundle = 1;\n");
  write(root, "packages/dsh/scripts/build-client-bundle.ts", "export const client = 1;\n");
  write(root, "packages/dsh/workflows/example.js", "return null;\n");
  write(root, "packages/dsh/dist/index.js", "// dsh bundle\n");
  write(root, "packages/dsh/dist/invariant.js", "// dsh invariant bundle\n");
  write(root, "packages/dsh/dist/client.js", "// dsh client bundle\n");
  write(root, "packages/dsh/dist/index.d.ts", "export declare const dsh: number;\n");
  for (const instructionRoot of INSTRUCTION_ROOTS) {
    bundleCopy(root, instructionRoot, `packages/dsh/harness-${instructionRoot}`);
  }

  packageJson(root, "packages/omp", { bun: ">=1.4.0" });
  write(root, "packages/omp/tsconfig.json", '{ "include": ["src"] }\n');
  write(root, "packages/omp/src/hooks/pre/mstar-gates.ts", "export const gates = 1;\n");
  write(root, "packages/omp/src/extensions/model-handoff.ts", "export const handoff = 1;\n");
  write(root, "packages/omp/src/extensions/phase2-orchestration.ts", "export const phase2 = 1;\n");
  write(root, "packages/omp/scripts/bundle-harness-assets.ts", "export const bundle = 1;\n");
  write(root, "packages/omp/dist/hooks/pre/mstar-gates.js", "// omp pre hook\n");
  write(root, "packages/omp/dist/extensions/model-handoff.js", "// omp handoff\n");
  write(root, "packages/omp/dist/extensions/phase2-orchestration.js", "// omp phase2\n");
  mirrorFile(
    root,
    "packages/omp/dist/hooks/pre/mstar-gates.js",
    "packages/omp/hooks/pre/mstar-gates.js",
  );
  mirrorFile(
    root,
    "packages/omp/dist/extensions/model-handoff.js",
    "packages/omp/extensions/model-handoff.js",
  );
  mirrorFile(
    root,
    "packages/omp/dist/extensions/phase2-orchestration.js",
    "packages/omp/extensions/phase2-orchestration.js",
  );
  for (const instructionRoot of INSTRUCTION_ROOTS) {
    bundleCopy(root, instructionRoot, `packages/omp/harness-${instructionRoot}`);
    bundleCopy(root, instructionRoot, `packages/omp/${instructionRoot}`);
  }
  write(root, "assets/logo.txt", "brand asset\n");
  bundleCopy(root, "assets", "packages/omp/assets");
  write(root, ".omp-plugin/plugin.json", '{ "name": "morning-star-harness" }\n');
  mirrorFile(root, ".omp-plugin/plugin.json", "packages/omp/plugin.json");
  mirrorFile(root, ".omp-plugin/mcp.json", "packages/omp/mcp.json");

  packageJson(root, "packages/opencode", { bun: ">=1.4.0", node: ">=24.18.0" });
  write(root, "packages/opencode/src/mstar.ts", "export const mstar = 1;\n");
  write(root, "packages/opencode/scripts/bundle-harness-assets.ts", "export const bundle = 1;\n");
  write(root, "packages/opencode/dist/mstar.js", "// opencode bundle\n");
  write(root, "packages/opencode/agents/pm.md", "# opencode-only primary\n");
  for (const instructionRoot of INSTRUCTION_ROOTS) {
    bundleCopy(root, instructionRoot, `packages/opencode/harness-${instructionRoot}`);
  }
  overlayCopy(root, "packages/opencode/agents", "packages/opencode/harness-agents");

  write(root, "hooks/src/mstar-write-gate.ts", "export const writeGate = 1;\n");
  write(root, "hooks/mstar-write-gate.mjs", "#!/usr/bin/env node\n// zcode hook\n");

  return root;
}

function cloneManifest(manifest: ExecutionConsumerManifest): MutableManifest {
  // Round-trip a document this process just produced, into a writable shape.
  return JSON.parse(JSON.stringify(manifest)) as MutableManifest;
}

function consumerIn(manifest: MutableManifest, id: string): MutableManifest["consumers"][number] {
  const consumer = manifest.consumers.find((candidate) => candidate.id === id);
  if (consumer === undefined) throw new Error(`fixture manifest has no consumer ${id}`);
  return consumer;
}

function asManifest(manifest: MutableManifest | Record<string, unknown>): ExecutionConsumerManifest {
  // Intentionally-invalid documents under test: the refusals below assert that
  // verification rejects the tampered value before trusting it.
  return manifest as unknown as ExecutionConsumerManifest;
}

function expectRefusal(run: () => void, code: ConsumerManifestRefusalCode): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) throw new Error(`expected refusal ${code}, nothing was thrown`);
  expect(caught).toBeInstanceOf(ExecutionConsumerManifestError);
  expect((caught as ExecutionConsumerManifestError).code).toBe(code);
}

/** Classify what the bundler actually produced for a copied instruction entry:
 * a self-contained link, a checkout-bound link, a dereferenced file, or nothing.
 * The producer's expected outcome is derived from this, never assumed. */
function classifyCopiedLink(
  treeRoot: string,
  entry: string,
): { kind: "symlink" | "file" | "missing"; portable: boolean } {
  if (!existsSync(entry)) return { kind: "missing", portable: false };
  if (!lstatSync(entry).isSymbolicLink()) return { kind: "file", portable: true };
  const rel = relative(treeRoot, realpathSync(entry));
  return { kind: "symlink", portable: rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) };
}

afterAll(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

describe("execution-consumer-manifest — canonical collection", () => {
  test("collects consumer capabilities and runtime floors", () => {
    const root = buildFixture();
    const manifest = collectExecutionConsumerManifest(root);

    expect(manifest.version).toBe(1);
    expect(manifest.protocol).toBe(CONSUMER_MANIFEST_PROTOCOL);
    expect(manifest.consumers.map((consumer) => consumer.id)).toEqual([
      "cli",
      "dsh",
      "engine",
      "omp",
      "opencode",
      "zcode",
    ]);

    const cli = consumerIn(cloneManifest(manifest), "cli");
    expect(cli.capability).toBe("writer");
    expect(cli.runtime).toEqual({
      target: "node",
      declaration: "package-engines",
      floor: ">=24.18.0",
    });
    expect(cli.sources?.trees.map((tree) => tree.root)).toEqual([
      "packages/cli/scripts",
      "packages/cli/src",
    ]);
    expect(cli.generated?.trees.map((tree) => tree.root)).toEqual(["packages/cli/dist"]);
    // The single bundle's bytes are environment-dependent, so this consumer
    // records no generated digest and excludes the bundle from its tree; what
    // it does pin is the source closure and the runtime floor.
    expect(cli.generated?.trees[0]?.exclude).toEqual(["execution-consumer.json", "mstar-harness.js"]);
    expect(cli.generated?.files).toEqual([]);

    const omp = manifest.consumers.find((consumer) => consumer.id === "omp");
    expect(omp?.runtime.target).toBe("bun");
    expect(omp?.runtime.floor).toBe(">=1.4.0");
    // The plugin manifest source and MCP launch config are real copy inputs.
    expect(omp?.sources.files.map((file) => file.path)).toEqual([
      ".omp-plugin/mcp.json",
      ".omp-plugin/plugin.json",
      "packages/omp/package.json",
      "packages/omp/tsconfig.json",
    ]);
    // The plugin loads package-root convention mirrors, so they are part of the generated closure, not only `dist`.
    expect(omp?.generated.trees.map((tree) => tree.root)).toEqual([
      "packages/omp/dist",
      "packages/omp/extensions",
      "packages/omp/hooks",
    ]);

    // DSh's whole `dist` closure is deliberately empty here: rebuilding it
    // changes `index.js`/`invariant.js` bytes even on one machine, so a digest
    // would record the builder, not the source. Integrity for this consumer is
    // its source closure plus the entrypoint existence proof; `dist/client.js`
    // keeps its own re-derivation proof outside this manifest.
    const dsh = manifest.consumers.find((consumer) => consumer.id === "dsh");
    expect(dsh?.generated.files).toEqual([]);
    expect(dsh?.generated.trees).toEqual([]);
    expect(dsh?.sources.trees.map((tree) => tree.root)).toEqual([
      "packages/dsh/scripts",
      "packages/dsh/src",
      "packages/dsh/workflows",
    ]);
    // ...and engine pins no build output either: `dist` bytes depend on the
    // build environment, so a manifest written here cannot be verified on a
    // checkout that was never built.
    const engine = manifest.consumers.find((consumer) => consumer.id === "engine");
    expect(engine?.generated.files).toEqual([]);
    expect(engine?.generated.trees).toEqual([]);
    expect(engine?.entrypoint).toBe("packages/engine/dist/engine.js");
    // The engine's build scripts are part of its input closure: `build.ts` runs
    // the bundle and `debug-esm.ts` is a bundled build input.
    expect(engine?.sources.trees.map((tree) => tree.root)).toEqual([
      "packages/engine/scripts",
      "packages/engine/src",
    ]);

    // OpenCode dynamically injects the CLI MCP server, whose handlers mutate; it remains a writer.
    const opencode = manifest.consumers.find((consumer) => consumer.id === "opencode");
    expect(opencode?.capability).toBe("writer");
    expect(opencode?.capabilityNote).toBeNull();

    // ZCode has no package metadata; its floor is declared as the canonical
    // one and the inlined engine source is part of its input closure.
    const zcode = manifest.consumers.find((consumer) => consumer.id === "zcode");
    expect(zcode?.runtime.declaration).toBe("canonical-floor");
    expect(zcode?.runtime.floor).toBe(">=24.18.0");
    expect(zcode?.entrypoint).toBe("hooks/mstar-write-gate.mjs");
    expect(zcode?.sources.trees.map((tree) => tree.root)).toEqual([
      "hooks/src",
      "packages/engine/src",
    ]);


    verifyExecutionConsumerManifest(manifest);
  });

  test("refuses to collect when build output is missing or empty instead of fabricating parity", () => {
    const missing = buildFixture();
    unlinkSync(join(missing, "packages/engine/dist/engine.js"));
    expectRefusal(() => collectExecutionConsumerManifest(missing), "consumer.generated-missing");

    const emptyArtifact = buildFixture();
    writeFileSync(join(emptyArtifact, "packages/cli/dist/mstar-harness.js"), "");
    expectRefusal(() => collectExecutionConsumerManifest(emptyArtifact), "consumer.generated-empty");

    const emptyTree = buildFixture();
    rmSync(join(emptyTree, "packages/omp/extensions"), { recursive: true, force: true });
    mkdirSync(join(emptyTree, "packages/omp/extensions"), { recursive: true });
    expectRefusal(() => collectExecutionConsumerManifest(emptyTree), "consumer.generated-empty");

    // The DSh client bundle is deliberately OUTSIDE the manifest's byte-pinned
    // closure (it is produced from declared inputs; see the layout note), so its
    // absence is not a manifest drift — its provenance is proven by the
    // producer's own re-derivation test. Every artifact inside the closure still
    // refuses when it is missing.
    const missingClient = buildFixture();
    unlinkSync(join(missingClient, "packages/dsh/dist/client.js"));
    verifyExecutionConsumerManifest(collectExecutionConsumerManifest(missingClient));

    const missingDsh = buildFixture();
    unlinkSync(join(missingDsh, "packages/dsh/dist/index.js"));
    expectRefusal(() => collectExecutionConsumerManifest(missingDsh), "consumer.generated-missing");
  });

  test("accepts an empty generated closure for a consumer that declares one, and still proves its entrypoint", () => {
    // `cli` deliberately declares no generated file: its single bundle's bytes
    // are environment-dependent. Collecting and verifying it must therefore
    // succeed on an unchanged tree — with no digest recorded for the bundle.
    const root = buildFixture();
    const manifest = collectExecutionConsumerManifest(root);
    const cli = consumerIn(cloneManifest(manifest), "cli");
    expect(cli.generated?.files).toEqual([]);
    verifyExecutionConsumerManifest(manifest);

    // The bundle is still a required artifact: rewriting its bytes is not
    // drift (it is deliberately unpinned), but removing it is.
    writeFileSync(join(root, "packages/cli/dist/mstar-harness.js"), "// rebuilt cli bundle\n");
    verifyExecutionConsumerManifest(manifest);
    unlinkSync(join(root, "packages/cli/dist/mstar-harness.js"));
    expectRefusal(() => verifyExecutionConsumerManifest(manifest), "consumer.generated-missing");

    // The producer proves the same thing, and refuses an empty bundle.
    const absent = buildFixture();
    unlinkSync(join(absent, "packages/cli/dist/mstar-harness.js"));
    expectRefusal(() => collectExecutionConsumerManifest(absent), "consumer.generated-missing");
    const empty = buildFixture();
    writeFileSync(join(empty, "packages/cli/dist/mstar-harness.js"), "");
    expectRefusal(() => collectExecutionConsumerManifest(empty), "consumer.generated-empty");
  });

  test("still refuses a consumer whose declared generated tree or artifact is absent", () => {
    // Only a layout that DECLARES no generated file is relaxed: a consumer
    // that declares generated trees must still have them built.
    const missingTree = buildFixture();
    rmSync(join(missingTree, "packages/opencode/dist"), { recursive: true, force: true });
    expectRefusal(() => collectExecutionConsumerManifest(missingTree), "consumer.path-missing");

    const emptyDeclaredTree = buildFixture();
    rmSync(join(emptyDeclaredTree, "packages/opencode/dist"), { recursive: true, force: true });
    mkdirSync(join(emptyDeclaredTree, "packages/opencode/dist"), { recursive: true });
    expectRefusal(() => collectExecutionConsumerManifest(emptyDeclaredTree), "consumer.generated-empty");

    // A declared artifact can also go missing while its tree stays non-empty:
    // that is still a refusal, never a silently shortened closure.
    const missingDeclaredArtifact = buildFixture();
    write(missingDeclaredArtifact, "packages/opencode/dist/chunk.js", "// extra bundle chunk\n");
    unlinkSync(join(missingDeclaredArtifact, "packages/opencode/dist/mstar.js"));
    expectRefusal(() => collectExecutionConsumerManifest(missingDeclaredArtifact), "consumer.path-missing");
  });

  test("refuses a package whose engines floor is not the canonical runtime floor", () => {
    const root = buildFixture();
    packageJson(root, "packages/cli", { bun: ">=1.4.0", node: ">=22.0.0" });
    expectRefusal(() => collectExecutionConsumerManifest(root), "consumer.runtime-mismatch");
  });
});

describe("execution-consumer-manifest — verification refusals", () => {
  test("passes on the exact fixture tree and refuses stale generated artifacts", () => {
    const root = buildFixture();
    const manifest = collectExecutionConsumerManifest(root);
    verifyExecutionConsumerManifest(manifest);
    const loaderDrift = buildFixture();
    const loaderManifest = collectExecutionConsumerManifest(loaderDrift);
    writeFileSync(join(loaderDrift, ".codex-plugin/mcp.json"), "// stale Codex loader config\n");
    expectRefusal(() => verifyExecutionConsumerManifest(loaderManifest), "consumer.digest-mismatch");

    // The engine's `dist` is NOT byte-pinned (its bytes depend on the build
    // environment), so rewritten bundle or declaration bytes are not drift;
    // removal of the entrypoint still is.
    const engineDrift = buildFixture();
    const engineManifest = collectExecutionConsumerManifest(engineDrift);
    writeFileSync(join(engineDrift, "packages/engine/dist/engine.js"), "// stale engine bundle\n");
    writeFileSync(join(engineDrift, "packages/engine/dist/index.d.ts"), "// stale types\n");
    verifyExecutionConsumerManifest(engineManifest);
    unlinkSync(join(engineDrift, "packages/engine/dist/engine.js"));
    expectRefusal(() => verifyExecutionConsumerManifest(engineManifest), "consumer.generated-missing");

    // A consumer that still pins its `dist` tree refuses stale declaration bytes.
    const declarationDrift = buildFixture();
    const declarationManifest = collectExecutionConsumerManifest(declarationDrift);
    writeFileSync(
      join(declarationDrift, "packages/opencode/dist/mstar.d.ts"),
      "// stale opencode types\n",
    );
    expectRefusal(
      () => verifyExecutionConsumerManifest(declarationManifest),
      "consumer.digest-mismatch",
    );

    // The DSh client bundle is NOT byte-pinned by this manifest: its bytes come
    // from a declared producer with declared inputs, so a recorded digest would
    // record the machine that built it. A change to it is therefore not a
    // manifest drift — the producer's own re-derivation test owns that artifact.
    const clientDrift = buildFixture();
    const clientManifest = collectExecutionConsumerManifest(clientDrift);
    writeFileSync(join(clientDrift, "packages/dsh/dist/client.js"), "// stale client bundle\n");
    verifyExecutionConsumerManifest(clientManifest);

    // Rebuilding or editing DSh's `dist` is not drift either: those bytes change
    // between builds of the same source, so the manifest proves this consumer
    // through its source closure instead.
    const dshDrift = buildFixture();
    const dshManifest = collectExecutionConsumerManifest(dshDrift);
    writeFileSync(join(dshDrift, "packages/dsh/dist/index.js"), "// stale dsh bundle\n");
    verifyExecutionConsumerManifest(dshManifest);

    const dshSourceDrift = buildFixture();
    const dshSourceManifest = collectExecutionConsumerManifest(dshSourceDrift);
    writeFileSync(join(dshSourceDrift, "packages/dsh/src/index.ts"), "// edited dsh source\n");
    expectRefusal(() => verifyExecutionConsumerManifest(dshSourceManifest), "consumer.digest-mismatch");

    const mirrorDrift = buildFixture();
    const mirrorManifest = collectExecutionConsumerManifest(mirrorDrift);
    writeFileSync(join(mirrorDrift, "packages/omp/hooks/pre/mstar-gates.js"), "// stale mirror\n");
    expectRefusal(() => verifyExecutionConsumerManifest(mirrorManifest), "consumer.digest-mismatch");
  });

  test("refuses a stale committed ZCode hook and a stale source entry", () => {
    const staleHookRoot = buildFixture();
    const staleHook = collectExecutionConsumerManifest(staleHookRoot);
    writeFileSync(join(staleHookRoot, "hooks/mstar-write-gate.mjs"), "// old hook\n");
    expectRefusal(() => verifyExecutionConsumerManifest(staleHook), "consumer.digest-mismatch");

    const staleSourceRoot = buildFixture();
    const staleSource = collectExecutionConsumerManifest(staleSourceRoot);
    writeFileSync(join(staleSourceRoot, "packages/cli/src/index.ts"), "export const cli = 2;\n");
    expectRefusal(() => verifyExecutionConsumerManifest(staleSource), "consumer.digest-mismatch");
  });

  test("refuses a changed transitive build input with the old bundle still in place", () => {
    const root = buildFixture();
    const manifest = collectExecutionConsumerManifest(root);
    // `store-db.ts` is not an entry file, but it is a real engine build input —
    // engine and the ZCode hook (which inlines the engine) both consume it.
    writeFileSync(join(root, "packages/engine/src/store-db.ts"), "export const store = 2;\n");
    expectRefusal(() => verifyExecutionConsumerManifest(manifest), "consumer.digest-mismatch");
    expect(readFileSync(join(root, "packages/engine/dist/engine.js"), "utf8")).toBe(
      "// engine bundle\n",
    );

    // The build script is an input too: a change to it invalidates the recorded
    // closure even though the still-present dist bytes are untouched.
    const scriptDrift = buildFixture();
    const scriptManifest = collectExecutionConsumerManifest(scriptDrift);
    writeFileSync(join(scriptDrift, "packages/engine/scripts/debug-esm.ts"), "export const debug = 2;\n");
    expectRefusal(() => verifyExecutionConsumerManifest(scriptManifest), "consumer.digest-mismatch");
  });

  test("refuses a changed OMP plugin manifest while the old root copy stays", () => {
    const root = buildFixture();
    const manifest = collectExecutionConsumerManifest(root);
    writeFileSync(join(root, ".omp-plugin/plugin.json"), '{ "name": "renamed-harness" }\n');
    expectRefusal(() => verifyExecutionConsumerManifest(manifest), "consumer.digest-mismatch");
    expect(readFileSync(join(root, "packages/omp/plugin.json"), "utf8")).toBe(
      '{ "name": "morning-star-harness" }\n',
    );
  });

  test("refuses a stale copied instruction corpus", () => {
    const root = buildFixture();
    const manifest = collectExecutionConsumerManifest(root);
    writeFileSync(
      join(root, "packages/dsh/harness-skills/mstar-demo/SKILL.md"),
      "# drifted skill\n",
    );
    expectRefusal(() => verifyExecutionConsumerManifest(manifest), "consumer.digest-mismatch");
  });

  test("the real bundler copy decides whether an instruction symlink stays portable", () => {
    const root = buildFixture({ instructionSymlink: true });
    const copied = join(root, "packages/dsh/harness-skills/mstar-demo/linked.md");
    const treeRoot = join(root, "packages/dsh/harness-skills");
    const shape = classifyCopiedLink(treeRoot, copied);

    if (shape.kind === "symlink" && shape.portable) {
      // The bundler produced a self-contained link: parity must be accepted.
      verifyExecutionConsumerManifest(collectExecutionConsumerManifest(root));
      return;
    }
    if (shape.kind === "symlink") {
      // The copy kept a checkout-bound backlink (or points at a foreign file):
      // the producer must refuse it, never accept it as portable parity.
      expectRefusal(() => collectExecutionConsumerManifest(root), "consumer.symlink-escapes-tree");
      return;
    }
    // Dereferenced into a regular file, or dropped: the copied entry no longer
    // matches the source link shape, so the tree digest must refuse.
    expectRefusal(() => collectExecutionConsumerManifest(root), "consumer.digest-mismatch");
  });

  test("refuses a copied tree that keeps a link back into the source checkout", () => {
    const root = buildFixture();
    const manifest = collectExecutionConsumerManifest(root);
    // A link from inside the copied tree back to the repo corpus is not
    // installable, even though it resolves inside the checkout.
    symlinkSync(
      "../../../../skills/shared/note.md",
      join(root, "packages/dsh/harness-skills/mstar-demo/backlink.md"),
    );
    expectRefusal(() => verifyExecutionConsumerManifest(manifest), "consumer.symlink-escapes-tree");
  });

  test("refuses source symlinks that escape the checkout or dangle", () => {
    const outsideLink = buildFixture();
    const outside = join(dirname(outsideLink), "outside-instruction.md");
    writeFileSync(outside, "foreign instruction\n");
    try {
      symlinkSync(outside, join(outsideLink, "skills/mstar-demo/outside.md"));
      expectRefusal(() => collectExecutionConsumerManifest(outsideLink), "consumer.symlink-escapes-tree");
    } finally {
      rmSync(outside, { force: true });
    }

    const crossTree = buildFixture();
    symlinkSync("../skills/shared/note.md", join(crossTree, "agents/escaped.md"));
    expectRefusal(() => collectExecutionConsumerManifest(crossTree), "consumer.symlink-escapes-tree");

    const dangling = buildFixture();
    symlinkSync("../shared/missing.md", join(dangling, "skills/mstar-demo/dangling.md"));
    expectRefusal(() => collectExecutionConsumerManifest(dangling), "consumer.symlink-unresolved");
  });

  test("refuses runtime, capability, packageRoot, protocol and set tampering", () => {
    const root = buildFixture();
    const manifest = collectExecutionConsumerManifest(root);

    const runtimeTamper = cloneManifest(manifest);
    const engineRuntime = consumerIn(runtimeTamper, "engine").runtime;
    if (engineRuntime === null) throw new Error("fixture engine runtime missing");
    engineRuntime.floor = ">=22.0.0";
    expectRefusal(() => verifyExecutionConsumerManifest(asManifest(runtimeTamper)), "consumer.runtime-mismatch");

    const capabilityTamper = cloneManifest(manifest);
    consumerIn(capabilityTamper, "opencode").capability = "decision-only";
    expectRefusal(
      () => verifyExecutionConsumerManifest(asManifest(capabilityTamper)),
      "consumer.capability-mismatch",
    );

    const unknownCapability = cloneManifest(manifest);
    consumerIn(unknownCapability, "zcode").capability = "authority";
    expectRefusal(
      () => verifyExecutionConsumerManifest(asManifest(unknownCapability)),
      "consumer.capability-mismatch",
    );

    const packageRootTamper = cloneManifest(manifest);
    consumerIn(packageRootTamper, "cli").packageRoot = "packages/dsh";
    expectRefusal(
      () => verifyExecutionConsumerManifest(asManifest(packageRootTamper)),
      "consumer.schema-invalid",
    );

    const hashTamper = cloneManifest(manifest);
    const cliGenerated = consumerIn(hashTamper, "opencode").generated;
    if (cliGenerated === null) throw new Error("fixture opencode generated set missing");
    cliGenerated.files[0]!.sha256 = "0".repeat(64);
    expectRefusal(() => verifyExecutionConsumerManifest(asManifest(hashTamper)), "consumer.digest-mismatch");

    const protocolTamper = cloneManifest(manifest);
    protocolTamper.protocol = "consumer-v2";
    expectRefusal(
      () => verifyExecutionConsumerManifest(asManifest(protocolTamper)),
      "consumer.protocol-unsupported",
    );

    const setTamper = cloneManifest(manifest);
    setTamper.consumers = setTamper.consumers.filter((consumer) => consumer.id !== "omp");
    expectRefusal(
      () => verifyExecutionConsumerManifest(asManifest(setTamper)),
      "consumer.consumer-set-mismatch",
    );

    const treeTamper = cloneManifest(manifest);
    const cliSources = consumerIn(treeTamper, "cli").sources;
    if (cliSources === null) throw new Error("fixture cli source set missing");
    cliSources.trees[0]!.files = 0;
    expectRefusal(() => verifyExecutionConsumerManifest(asManifest(treeTamper)), "consumer.digest-mismatch");
  });

  test("refuses malformed documents with stable schema refusals", () => {
    const root = buildFixture();
    const manifest = collectExecutionConsumerManifest(root);

    const nullConsumer = cloneManifest(manifest) as unknown as Record<string, unknown>;
    nullConsumer.consumers = [null];
    expectRefusal(() => verifyExecutionConsumerManifest(asManifest(nullConsumer)), "consumer.schema-invalid");

    const emptyConsumers = cloneManifest(manifest) as unknown as Record<string, unknown>;
    emptyConsumers.consumers = [];
    expectRefusal(
      () => verifyExecutionConsumerManifest(asManifest(emptyConsumers)),
      "consumer.schema-invalid",
    );

    const nullRuntime = cloneManifest(manifest);
    consumerIn(nullRuntime, "engine").runtime = null;
    expectRefusal(
      () => verifyExecutionConsumerManifest(asManifest(nullRuntime)),
      "consumer.schema-invalid",
    );

    const nullSets = cloneManifest(manifest);
    consumerIn(nullSets, "engine").sources = null;
    expectRefusal(() => verifyExecutionConsumerManifest(asManifest(nullSets)), "consumer.schema-invalid");

    expectRefusal(
      () => verifyExecutionConsumerManifest(asManifest({ version: 1, protocol: "consumer-v1" })),
      "consumer.schema-invalid",
    );
  });

  test("refuses a recorded path that would leave the repo root, without inspecting it", () => {
    const root = buildFixture();
    const outside = join(dirname(root), "outside-consumer-artifact.js");
    writeFileSync(outside, "// installed or foreign artifact\n");
    try {
      const manifest = collectExecutionConsumerManifest(root);

      const escaped = cloneManifest(manifest);
      const generated = consumerIn(escaped, "opencode").generated;
      if (generated === null) throw new Error("fixture opencode generated set missing");
      generated.files[0]!.path = "../outside-consumer-artifact.js";
      expectRefusal(() => verifyExecutionConsumerManifest(asManifest(escaped)), "consumer.path-outside-root");

      const absolute = cloneManifest(manifest);
      const absoluteGenerated = consumerIn(absolute, "opencode").generated;
      if (absoluteGenerated === null) throw new Error("fixture opencode generated set missing");
      absoluteGenerated.trees[0]!.root = "/etc";
      expectRefusal(() => verifyExecutionConsumerManifest(asManifest(absolute)), "consumer.path-outside-root");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("refuses file, root and artifact symlinks that point outside the checkout", () => {
    const fileLink = buildFixture();
    const outsideFile = join(dirname(fileLink), "outside-package.json");
    writeFileSync(outsideFile, '{ "engines": { "node": ">=24.18.0" } }\n');
    try {
      unlinkSync(join(fileLink, "packages/cli/package.json"));
      symlinkSync(outsideFile, join(fileLink, "packages/cli/package.json"));
      expectRefusal(() => collectExecutionConsumerManifest(fileLink), "consumer.path-outside-root");
    } finally {
      rmSync(outsideFile, { force: true });
    }

    const rootLink = buildFixture();
    const outsideDir = mkdtempSync(join(tmpdir(), "execution-consumer-outside-"));
    fixtures.push(outsideDir);
    write(outsideDir, "note.md", "foreign corpus\n");
    rmSync(join(rootLink, "packages/dsh/harness-skills"), { recursive: true, force: true });
    symlinkSync(outsideDir, join(rootLink, "packages/dsh/harness-skills"));
    expectRefusal(() => collectExecutionConsumerManifest(rootLink), "consumer.path-outside-root");

    const artifactLink = buildFixture();
    const outsideArtifact = join(dirname(artifactLink), "outside-bundle.js");
    writeFileSync(outsideArtifact, "// foreign bundle\n");
    try {
      unlinkSync(join(artifactLink, "packages/opencode/dist/mstar.js"));
      symlinkSync(outsideArtifact, join(artifactLink, "packages/opencode/dist/mstar.js"));
      expectRefusal(
        () => collectExecutionConsumerManifest(artifactLink),
        "consumer.symlink-escapes-tree",
      );
    } finally {
      rmSync(outsideArtifact, { force: true });
    }
  });
});

describe("execution-consumer-manifest — CLI", () => {
  test("--write emits every manifest copy and --check verifies without writing", async () => {
    const root = buildFixture();
    const targets = executionConsumerManifestPaths(root);
    expect(targets.map((target) => target.slice(root.length + 1))).toEqual([
      "packages/cli/dist/execution-consumer.json",
      "packages/dsh/dist/execution-consumer.json",
      "packages/engine/dist/execution-consumer.json",
      "packages/omp/dist/execution-consumer.json",
      "packages/opencode/dist/execution-consumer.json",
      "scripts/packaging-manifests/manifest.json",
    ]);

    expect(await runExecutionConsumerManifestCli(["--repo", root, "--check"], root)).toBe(1);
    expect(await runExecutionConsumerManifestCli(["--repo", root, "--write"], root)).toBe(0);

    const written = targets.map((target) => readFileSync(target, "utf8"));
    for (const text of written) {
      const manifest = JSON.parse(text) as ExecutionConsumerManifest;
      // The written artifact keeps the caller-supplied portable root.
      expect(manifest.repoRoot).toBe(root);
      verifyExecutionConsumerManifest(manifest);
    }
    expect(written[0]).toBe(written[written.length - 1]);
    // The staging files are renamed away, never left behind.
    expect(targets.some((target) => existsSync(`${target}.staging-${process.pid}`))).toBe(false);

    // The written manifest lives inside the recorded dist trees; the digest must
    // stay stable across the write (the manifest basename is excluded).
    expect(await runExecutionConsumerManifestCli(["--repo", root, "--check"], root)).toBe(0);
    expect(targets.map((target) => readFileSync(target, "utf8"))).toEqual(written);

    // A drifted copy of one manifest refuses rather than silently winning.
    writeFileSync(join(root, "scripts/packaging-manifests/manifest.json"), "{}\n");
    expect(await runExecutionConsumerManifestCli(["--repo", root, "--check"], root)).toBe(1);

    // Invalid JSON in every copy is a stable schema refusal, not a raw SyntaxError.
    for (const target of targets) writeFileSync(target, "{ not json");
    expect(await runExecutionConsumerManifestCli(["--repo", root, "--check"], root)).toBe(1);
  });

  test("refuses a pre-created staging path instead of writing through it", async () => {
    const root = buildFixture();
    const outside = join(dirname(root), "outside-staging.json");
    writeFileSync(outside, "foreign staging\n");
    try {
      const target = executionConsumerManifestPaths(root)[0]!;
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(outside, `${target}.staging-${process.pid}`);
      expect(await runExecutionConsumerManifestCli(["--repo", root, "--write"], root)).toBe(1);
      expect(readFileSync(outside, "utf8")).toBe("foreign staging\n");
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("refuses to read or write a manifest through a symlink", async () => {
    const root = buildFixture();
    const outside = join(dirname(root), "outside-manifest.json");
    writeFileSync(outside, "{}\n");
    try {
      const target = executionConsumerManifestPaths(root)[5]!;
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(outside, target);
      expect(await runExecutionConsumerManifestCli(["--repo", root, "--write"], root)).toBe(1);
      expect(await runExecutionConsumerManifestCli(["--repo", root, "--check"], root)).toBe(1);
      expect(readFileSync(outside, "utf8")).toBe("{}\n");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("refuses a manifest copy symlinked to another in-repo manifest", async () => {
    const root = buildFixture();
    expect(await runExecutionConsumerManifestCli(["--repo", root, "--write"], root)).toBe(0);

    const targets = executionConsumerManifestPaths(root);
    const source = targets[0]!;
    const redirected = targets[targets.length - 1]!;
    // Byte-identical bytes, so only the lexical symlink check can catch this.
    unlinkSync(redirected);
    symlinkSync(source, redirected);
    expect(await runExecutionConsumerManifestCli(["--repo", root, "--check"], root)).toBe(1);
  });

  test("the real entrypoint runs under bun from an arbitrary cwd", () => {
    const root = buildFixture();
    const writeRun = spawnSync("bun", [SCRIPT, "--repo", root, "--write"], { cwd: root });
    expect(writeRun.status).toBe(0);
    const checkRun = spawnSync("bun", [SCRIPT, "--repo", root, "--check"], { cwd: root });
    expect(checkRun.status).toBe(0);

    for (const target of executionConsumerManifestPaths(root)) {
      verifyExecutionConsumerManifest(
        JSON.parse(readFileSync(target, "utf8")) as ExecutionConsumerManifest,
      );
    }
  });
});



describe("execution-consumer-manifest — canonical per-consumer evidence documents", () => {
  test("emits one canonical single-consumer document per consumer", () => {
    const root = buildFixture();
    const manifest = collectExecutionConsumerManifest(root);
    const documents = executionConsumerEvidenceDocuments(manifest);
    const targets = executionConsumerEvidencePaths(root);
    const ids = manifest.consumers.map((consumer) => consumer.id);

    expect(documents.map((document) => document.consumers[0].id)).toEqual(ids);
    expect(targets.map((target) => target.consumerId)).toEqual(ids);
    // ONE directory, named by consumer: the aggregate and the evidence
    // documents live together under the repo-root `scripts/` tree.
    expect(targets.map((target) => relative(root, target.path))).toEqual([
      "scripts/packaging-manifests/cli.json",
      "scripts/packaging-manifests/dsh.json",
      "scripts/packaging-manifests/engine.json",
      "scripts/packaging-manifests/omp.json",
      "scripts/packaging-manifests/opencode.json",
      "scripts/packaging-manifests/zcode.json",
    ]);

    for (const document of documents) {
      const text = serializeExecutionConsumerEvidenceDocument(document);
      const parsed = JSON.parse(text) as Record<string, unknown> & {
        consumers: Array<Record<string, unknown>>;
      };
      // The reviewed substrate's `producedDocument` rule, checked with the
      // engine's own canonicalizer: the bytes have exactly one meaning.
      expect(serializeExecutionValue(parsed)).toBe(text);
      expect(text.endsWith("\n")).toBe(true);
      expect(text.endsWith("\n\n")).toBe(false);
      // `expectConsumerManifest` decodes exactly one consumer entry per document.
      expect(parsed.consumers.length).toBe(1);
      const entry = parsed.consumers[0]!;
      // The decoder's closed closure: a document outside it is refused, so the
      // emitted shape must be exactly the released `consumer-v1` shape.
      expect(Object.keys(parsed).sort()).toEqual(["consumers", "protocol", "repoRoot", "version"]);
      expect(Object.keys(entry).sort()).toEqual([
        "capability",
        "capabilityNote",
        "copiedInstructions",
        "entrypoint",
        "generated",
        "id",
        "packageRoot",
        "runtime",
        "sources",
      ]);
      expect(Object.keys(entry.runtime as object).sort()).toEqual(["declaration", "floor", "target"]);
      for (const set of [entry.sources, entry.generated] as Array<{ trees: Array<object>; files: Array<object> }>) {
        expect(Object.keys(set).sort()).toEqual(["files", "trees"]);
        for (const tree of set.trees) {
          const record = tree as Record<string, unknown>;
          // `exclude` is optional: a tree records the basenames it did not digest
          // (an artifact proved by its producer instead of by its bytes).
          expect(Object.keys(record).sort()).toEqual(
            Object.hasOwn(record, "exclude") ? ["exclude", "files", "root", "sha256"] : ["files", "root", "sha256"],
          );
          if (Object.hasOwn(record, "exclude")) {
            expect(Array.isArray(record.exclude)).toBe(true);
            for (const name of record.exclude as unknown[]) expect(typeof name).toBe("string");
          }
        }
        for (const file of set.files) expect(Object.keys(file).sort()).toEqual(["path", "sha256"]);
      }
      for (const copy of entry.copiedInstructions as Array<object>) {
        expect(Object.keys(copy).sort()).toEqual(["files", "mode", "sha256", "sourceRoot", "targetRoot"]);
      }
      expect(parsed.version).toBe(1);
      expect(parsed.protocol).toBe(CONSUMER_MANIFEST_PROTOCOL);
      expect(parsed.repoRoot).toBe(root);
      // The handoff form carries the aggregate's own entry, never a second fact.
      const aggregate = manifest.consumers.find((consumer) => consumer.id === entry.id);
      expect(serializeExecutionValue(entry)).toBe(serializeExecutionValue(aggregate));
    }

    // Publishing evidence cannot invalidate a recorded tree digest: every
    // evidence path sits outside the consumer's declared closures.
    for (const [index, target] of targets.entries()) {
      const consumer = manifest.consumers[index]!;
      const rel = relative(root, target.path);
      for (const tree of [...consumer.sources.trees, ...consumer.generated.trees]) {
        expect(rel === tree.root || rel.startsWith(`${tree.root}/`)).toBe(false);
      }
    }
    // And the manifest this producer already verifies stays valid with them on
    // disk: the evidence documents are not part of any digested closure.
    expect(executionConsumerManifestPaths(root).length).toBe(6);
  });

  test("--write publishes the evidence documents and --check verifies them", async () => {
    const root = buildFixture();
    expect(await runExecutionConsumerManifestCli(["--repo", root, "--write"], root)).toBe(0);

    const targets = executionConsumerEvidencePaths(root);
    for (const { path } of targets) expect(existsSync(path)).toBe(true);
    const written = targets.map(({ path }) => readFileSync(path));
    expect(await runExecutionConsumerManifestCli(["--repo", root, "--check"], root)).toBe(0);
    expect(targets.map(({ path }) => readFileSync(path))).toEqual(written);

    // A re-encoded (non-canonical) document is refused, not reformatted.
    const first = targets[0]!;
    writeFileSync(
      first.path,
      `${JSON.stringify(JSON.parse(readFileSync(first.path, "utf8")), null, 2)}\n`,
    );
    expect(await runExecutionConsumerManifestCli(["--repo", root, "--check"], root)).toBe(1);

    // Canonical bytes that disagree with the aggregate are drift.
    expect(await runExecutionConsumerManifestCli(["--repo", root, "--write"], root)).toBe(0);
    const document = JSON.parse(readFileSync(first.path, "utf8")) as {
      consumers: Array<Record<string, unknown>>;
    };
    document.consumers.push({ ...document.consumers[0]!, id: "engine" });
    writeFileSync(first.path, serializeExecutionValue(document));
    expect(await runExecutionConsumerManifestCli(["--repo", root, "--check"], root)).toBe(1);
  });

});
