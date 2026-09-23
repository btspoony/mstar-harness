/**
 * R3 — assembled package parity and the R17 generated ZCode hook (Node).
 *
 * Run with: `node --test packages/cli/test/execution-package.node.test.mjs`
 *
 * WHAT THIS TEST ACTUALLY EXERCISES (a real regression over real artifacts)
 *
 * 1. THE BUILT CLI BUNDLE — `packages/cli/dist/mstar-harness.js`, the CLI
 *    package's declared `bin` entrypoint, built with `bun build --target node`.
 *    It is spawned as a subprocess under the runtime running this test and is
 *    driven through the ACTIVE execution transport: `workflow register`
 *    (write/creation), `plan bind --coordinator` and `plan bind --plan`
 *    (bind), `plan prepare` (write), `plan show` (read), `plan bind
 *    --resume-ref` (read-only resume) and a `plan progress` write plus its
 *    exact retry. Nothing asserts the CLI's own claim alone: the authority is
 *    re-read through the engine's public readers and through `node:sqlite`
 *    directly.
 * 2. THE BUILT ENGINE GENERATION — `@mstar-harness/engine` resolves through
 *    the package's declared `exports` to `packages/engine/dist/engine.js`.
 *    Only that built artifact is imported (NEVER TypeScript source), and it
 *    runs real `node:sqlite` against a populated temporary store.
 * 3. THE COMMITTED ZCODE HOOK BUNDLE — `hooks/mstar-write-gate.mjs`, the
 *    artifact `scripts/build-zcode-hooks.ts` generates and `hooks/hooks.json`
 *    runs via `node`. It is spawned as a subprocess with real PreToolUse
 *    envelopes against a populated database fixture and against a
 *    pre-activation harness fixture.
 * 4. THE GENERATED CONSUMER MANIFESTS — `hooks/execution-consumer.json` plus
 *    every `<consumer>/execution-consumer/<id>.json` evidence document. Every
 *    recorded digest is RE-DERIVED from the bytes on disk (declared files,
 *    source/generated trees, copied instruction trees), so a stale generated
 *    artifact, a stale copy or a hand-edited manifest fails here.
 *
 * WHAT THIS TEST IS NOT (labels, so no reader over-claims)
 *
 * - NOT a native-host test. No ZCode / OMP / DSh / OpenCode host process, no
 *   host session identity, no native hook delivery, and no installed binary is
 *   involved. The ZCode hook is driven exactly the way its own process
 *   contract defines (stdin envelope + exit code), which is the host's
 *   protocol but not the host itself.
 * - NOT an adoption or installed-state test. Everything happens in temporary
 *   directories; the real control root, the real credentials and any installed
 *   generation are never read or written.
 * - Only the NODE-target artifacts (CLI bundle, engine generation, committed
 *   ZCode hook) are executed. The OMP / DSh / OpenCode entrypoints are Bun or
 *   other-runtime targets: here they are covered by the generated-manifest
 *   parity assertions, and the populated fixture recipe reused from H2's OMP
 *   `phase2-launches` seed is executed against the built engine to show that a
 *   real OMP-shaped database fixture runs under Node — never that an OMP host
 *   ran.
 * - No TypeScript source is imported anywhere in this file.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/* The BUILT engine generation, through the package's declared `exports` map
 * (`default: ./dist/engine.js`). Importing the package name — never a source
 * path — is what keeps this a package-level regression rather than a
 * source-level test. */
import {
  bindExecutionSession,
  createExecutionWorkflow,
  encodeExecutionSessionRef,
  initializeExecutionAuthority,
  initializeStore,
  mutateExecutionPlan,
  readExecutionAuthority,
  registerCatalogEntity,
  serializeExecutionValue,
} from "@mstar-harness/engine";

// `packages/cli/test` -> `packages/cli` -> `packages` -> the repository root.
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(TEST_DIR, "..");
const REPO = resolve(CLI_ROOT, "..", "..");
const CLI_ENTRY = join(CLI_ROOT, "dist", "mstar-harness.js");
const HOOK_ENTRY = join(REPO, "hooks", "mstar-write-gate.mjs");
const MANIFEST_PATH = join(REPO, "hooks", "execution-consumer.json");
const MANIFEST_BASENAME = "execution-consumer.json";

// The resolution above is load-bearing for EVERY manifest/artifact path in this
// file: a wrong level would silently point outside the checkout. Fail loudly on
// the repository's own landmarks rather than on a downstream missing file.
assert.ok(existsSync(join(REPO, "package.json")), `repository root did not resolve: ${REPO}`);
assert.ok(existsSync(join(CLI_ROOT, "package.json")), `CLI package root did not resolve: ${CLI_ROOT}`);
assert.ok(existsSync(MANIFEST_PATH), `generated manifest not found at ${MANIFEST_PATH}`);

const WORKFLOW_ID = "wf-r3-parity";
const PLAN_ID = "20260921-r3-parity-plan";
const COORDINATOR_ID = "coord-r3";
const PLAN_PM_ID = "planpm-r3";
const BRANCH = "feature/r3-parity";
const WIRE_PREFIX = "exec-session-v1:";

const OMP_WORKFLOW_ID = "wf-r3-omp-fixture";
const OMP_PLAN_ID = "20260921-r3-omp-plan";
const OMP_COORDINATOR_ID = "coord-r3-omp";
const OMP_PLAN_SESSION_ID = "planpm-r3-omp";

/** Ambient variables that would otherwise leak the real environment (or a real
 * launcher identity) into a spawned child. */
const STRIPPED_ENV = [
  "MSTAR_HARNESS_DIR",
  "MSTAR_CONTROL_ROOT",
  "SDD_DIR",
  "MSTAR_HOST_SESSION_ID",
  "MSTAR_EXECUTION_IDENTITY",
  "MSTAR_WRITE_GATE",
];

const roots = [];

after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------------ */

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function toPosix(value) {
  return value.split("\\").join("/");
}

/**
 * The manifest producer's canonical tree walk, re-implemented here from the
 * bytes: entries are `{path, kind, sha256, linkTarget}` in that key order, a
 * symlink recorded by its tree-relative canonical target plus the resolved
 * bytes, entries sorted by path, and the digest being the SHA-256 of the
 * serialized entry list. Reproducing it (rather than importing the producer)
 * is what makes the assertion an independent re-derivation.
 */
function treeEntries(rootAbs, exclude) {
  const entries = [];
  const walk = (dirAbs, relDir) => {
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
        const resolved = realpathSync(abs);
        const linkTarget = toPosix(relative(rootAbs, resolved));
        assert.ok(!linkTarget.startsWith("../"), `${rel}: symlink escapes its own tree`);
        entries.push({ path: rel, kind: "symlink", sha256: sha256File(resolved), linkTarget });
        continue;
      }
      if (dirent.isFile()) {
        entries.push({ path: rel, kind: "file", sha256: sha256File(abs), linkTarget: null });
        continue;
      }
      assert.fail(`${rel}: unsupported filesystem entry`);
    }
  };
  walk(rootAbs, "");
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function digestEntries(entries) {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** Assert one recorded tree digest against the tree on disk. */
function assertTreeDigest(label, tree, exclude) {
  const abs = join(REPO, tree.root);
  assert.ok(existsSync(abs), `${label}: declared tree root ${tree.root} is missing`);
  const entries = treeEntries(abs, exclude);
  assert.equal(entries.length, tree.files, `${label}: ${tree.root} file count drifted`);
  assert.equal(digestEntries(entries), tree.sha256, `${label}: ${tree.root} digest drifted`);
}

/** `">=24.18.0"` against `process.versions.node`-style versions. */
function satisfiesFloor(version, floor) {
  const match = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(floor);
  assert.ok(match, `unsupported runtime floor literal ${JSON.stringify(floor)}`);
  const actual = version.split(".").map(Number);
  const floorParts = [match[1], match[2], match[3]].map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > floorParts[index]) return true;
    if (actual[index] < floorParts[index]) return false;
  }
  return true;
}

/* ------------------------------------------------------------------------ *
 * Built-artifact inventory
 * ------------------------------------------------------------------------ */

function readManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

function consumerById(manifest, id) {
  const consumer = manifest.consumers.find((candidate) => candidate.id === id);
  assert.ok(consumer, `manifest declares no ${id} consumer`);
  return consumer;
}

/* ------------------------------------------------------------------------ *
 * Temporary workspaces (never the real control root)
 * ------------------------------------------------------------------------ */

/** A temp Git workspace whose `.mstar` holds a REAL, ACTIVE execution authority
 * built by the built engine's own producers over real `node:sqlite`. */
async function makeActiveWorkspace(label) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`)));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=r3@test", "-c", "user.name=r3", "commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: root,
  });
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  const store = await initializeStore({ harnessDir: harness });
  store.close();
  await initializeExecutionAuthority({ harnessDir: harness });
  return { root, harness };
}

/** The header block the engine's Assignment parser accepts (the DB prepare
 * seals it). Same shape the reviewed CLI transport fixtures use. */
function assignmentText(input) {
  return [
    `# Assignment \u2014 ${input.planId}`,
    "",
    `**Control harness root**: ${input.harness}`,
    `**Workflow id**: ${input.workflowId}`,
    `**Plan id**: ${input.planId}`,
    `**Plan Path**: ${input.planPath}`,
    `**Worktree Path**: ${input.worktreePath}`,
    `**Working branch**: ${input.branch}`,
    `**SDD dir**: ${input.sddDir}`,
    "**Execute as**: project-manager",
    "**Execution scope**: plan",
    "**Delegation**: allowed (plan-local subagents only)",
    "**Prepare gate**: go",
    "**QA gate**: mandatory",
    "**Findings cleanup**: allow-residual",
    "",
    "Body.",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------------ *
 * Spawning the BUILT CLI
 * ------------------------------------------------------------------------ */

function cliEnv(fixture, identity) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (STRIPPED_ENV.includes(key)) continue;
    env[key] = value;
  }
  env.MSTAR_HARNESS_DIR = fixture.harness;
  if (identity !== undefined) env.MSTAR_EXECUTION_IDENTITY = serializeExecutionValue(identity);
  return env;
}

function runCli(fixture, args, identity) {
  const proc = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: fixture.root,
    env: cliEnv(fixture, identity),
    encoding: "utf8",
  });
  return { exitCode: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

/** Exit 0 + the parsed JSON envelope, or a failure naming stdout AND stderr. */
function ok(result, label) {
  assert.equal(
    result.exitCode,
    0,
    `${label}: expected exit 0, got ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
  );
  try {
    return JSON.parse(result.stdout);
  } catch {
    assert.fail(`${label}: expected JSON on stdout, got ${JSON.stringify(result.stdout)} (stderr: ${result.stderr})`);
  }
}

function coordinatorIdentity() {
  return { source: "local", sessionId: COORDINATOR_ID, workflowId: WORKFLOW_ID, role: "coordinator", planId: null };
}

function planPmIdentity() {
  return { source: "local", sessionId: PLAN_PM_ID, workflowId: WORKFLOW_ID, role: "plan-pm", planId: PLAN_ID };
}

/** A canonical plain copy of an engine-returned session reference (the engine's
 * canonical-value rule accepts only plain objects, so a reference that travels
 * back into a request is projected field by field). */
function plainRef(ref) {
  return {
    storeId: ref.storeId,
    epoch: ref.epoch,
    workflowId: ref.workflowId,
    role: ref.role,
    sessionId: ref.sessionId,
    planId: ref.planId,
  };
}

async function tokenOf(harness, selection) {
  const read = await readExecutionAuthority({ harnessDir: harness }, selection);
  return read.token;
}

/* ------------------------------------------------------------------------ *
 * Spawning the COMMITTED ZCode hook
 * ------------------------------------------------------------------------ */

function hookEnv(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (STRIPPED_ENV.includes(key)) continue;
    env[key] = value;
  }
  Object.assign(env, overrides ?? {});
  return env;
}

function runGate(payload, options = {}) {
  const proc = spawnSync(process.execPath, [HOOK_ENTRY], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: hookEnv(options.env),
    encoding: "utf8",
  });
  return { exitCode: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

function writeEvent(toolInput, cwd) {
  return cwd === undefined ? { tool_name: "Write", tool_input: toolInput } : { tool_name: "Write", tool_input: toolInput, cwd };
}

/* ------------------------------------------------------------------------ *
 * 1. Built / committed artifacts are real node-target artifacts
 * ------------------------------------------------------------------------ */

test("built CLI, built engine generation and committed ZCode hook are present node-target artifacts", () => {
  assert.ok(existsSync(CLI_ENTRY), `built CLI bundle missing: ${toPosix(relative(REPO, CLI_ENTRY))}`);
  // The CLI bundle is the package's declared `bin` entrypoint, not a stray file.
  const cliPkg = JSON.parse(readFileSync(join(REPO, "packages", "cli", "package.json"), "utf8"));
  assert.equal(cliPkg.bin["mstar-harness"], "dist/mstar-harness.js");
  assert.equal(cliPkg.bin.mstar, "dist/mstar-harness.js");

  // The engine generation resolves through the declared `exports` map.
  const enginePkg = JSON.parse(readFileSync(join(REPO, "packages", "engine", "package.json"), "utf8"));
  assert.equal(enginePkg.exports["."].default, "./dist/engine.js");
  const engineEntry = resolve(REPO, "packages/engine/dist/engine.js");
  assert.ok(existsSync(engineEntry), "built engine generation missing");
  // The exported readers/producers this regression drives really exist on it.
  for (const exported of [
    readExecutionAuthority,
    initializeExecutionAuthority,
    initializeStore,
    serializeExecutionValue,
    encodeExecutionSessionRef,
  ]) {
    assert.equal(typeof exported, "function");
  }

  // The committed ZCode hook is generated output, run by `node` from hooks.json.
  assert.ok(existsSync(HOOK_ENTRY), "committed ZCode hook bundle missing");
  const hookHead = readFileSync(HOOK_ENTRY, "utf8").split("\n", 2);
  assert.equal(hookHead[0], "#!/usr/bin/env node");
  assert.match(hookHead[1], /^\/\/ @generated by scripts\/build-zcode-hooks\.ts from hooks\/src\/mstar-write-gate\.ts/);
  const hooksJson = JSON.parse(readFileSync(join(REPO, "hooks", "hooks.json"), "utf8"));
  const writeGate = hooksJson.hooks.PreToolUse.find((entry) => entry.matcher === "Write|Edit");
  assert.ok(writeGate, "hooks.json declares no Write|Edit PreToolUse entry");
  assert.equal(writeGate.hooks[0].command, "node");
  assert.deepEqual(writeGate.hooks[0].args, ["${ZCODE_PLUGIN_ROOT}/hooks/mstar-write-gate.mjs"]);

  // This regression needs the CLI/engine/ZCode declared Node floor.
  const nodeFloor = consumerById(readManifest(), "cli").runtime.floor;
  assert.ok(
    satisfiesFloor(process.versions.node, nodeFloor),
    `this regression runs on Node ${process.versions.node}, below the declared floor ${nodeFloor}`,
  );
});

/* ------------------------------------------------------------------------ *
 * 2. Generated manifests agree with the bytes on disk
 * ------------------------------------------------------------------------ */

test("generated consumer manifests agree with the bytes on disk (all six consumers)", () => {
  const manifest = readManifest();
  assert.equal(manifest.version, 1);
  assert.equal(manifest.protocol, "consumer-v1");
  assert.equal(manifest.repoRoot, ".");
  assert.deepEqual(
    manifest.consumers.map((consumer) => consumer.id).sort(),
    ["cli", "dsh", "engine", "omp", "opencode", "zcode"],
  );

  const nodeFloors = new Set(
    manifest.consumers
      .filter((consumer) => consumer.runtime.declaration === "package-engines" && consumer.runtime.target === "node")
      .map((consumer) => consumer.runtime.floor),
  );
  assert.equal(nodeFloors.size, 1, "the package-declared Node floors disagree");

  for (const consumer of manifest.consumers) {
    const label = `[${consumer.id}]`;
    const packageRoot = consumer.packageRoot === "." ? REPO : join(REPO, consumer.packageRoot);
    const entryAbs = join(REPO, consumer.entrypoint);
    assert.ok(existsSync(entryAbs), `${label} entrypoint ${consumer.entrypoint} does not exist`);

    // Every declared source and generated FILE is byte-identical to its record.
    for (const file of [...consumer.sources.files, ...consumer.generated.files]) {
      const abs = join(REPO, file.path);
      assert.ok(existsSync(abs), `${label} declared file ${file.path} is missing`);
      assert.equal(sha256File(abs), file.sha256, `${label} declared file ${file.path} drifted`);
    }
    // Every declared TREE is re-digested from the bytes. Generated trees carry
    // the producer's own manifest-basename exclusion PLUS the exclusions the
    // manifest RECORDS (an artifact whose bytes belong to a declared producer,
    // e.g. the DSh client bundle, is outside the digested closure by name — the
    // recorded list is what lets this verifier re-digest the same closure).
    for (const tree of consumer.sources.trees) assertTreeDigest(`${label} source tree`, tree, []);
    for (const tree of consumer.generated.trees) {
      assertTreeDigest(`${label} generated tree`, tree, [MANIFEST_BASENAME, ...(tree.exclude ?? [])]);
    }

    // Copied instruction trees: a `copy` target must equal its source tree
    // exactly, a `merge` target must contain every source entry byte-identically.
    for (const copy of consumer.copiedInstructions) {
      const sourceEntries = treeEntries(join(REPO, copy.sourceRoot), []);
      assert.equal(sourceEntries.length, copy.files, `${label} copy ${copy.sourceRoot} file count drifted`);
      assert.equal(digestEntries(sourceEntries), copy.sha256, `${label} copy source ${copy.sourceRoot} drifted`);
      const targetEntries = treeEntries(join(REPO, copy.targetRoot), []);
      if (copy.mode === "copy") {
        assert.equal(
          digestEntries(targetEntries),
          copy.sha256,
          `${label} copy target ${copy.targetRoot} no longer matches ${copy.sourceRoot}`,
        );
      } else {
        assert.equal(copy.mode, "merge");
        const targetByPath = new Map(targetEntries.map((entry) => [entry.path, entry]));
        for (const entry of sourceEntries) {
          const copied = targetByPath.get(entry.path);
          assert.ok(copied, `${label} merged target ${copy.targetRoot} is missing ${entry.path}`);
          assert.equal(copied.kind, entry.kind, `${label} merged ${copy.targetRoot}/${entry.path} kind drifted`);
          assert.equal(copied.sha256, entry.sha256, `${label} merged ${copy.targetRoot}/${entry.path} bytes drifted`);
          assert.equal(copied.linkTarget, entry.linkTarget, `${label} merged ${copy.targetRoot}/${entry.path} link drifted`);
        }
      }
    }

    // The entrypoint is declared by an actual package build/plugin surface —
    // never accepted merely because the bytes happen to exist.
    const tail = toPosix(relative(packageRoot, entryAbs));
    const declarationDocs = [
      join(packageRoot, "package.json"),
      join(packageRoot, "plugin.json"),
      join(REPO, ".omp-plugin", "plugin.json"),
      join(REPO, "hooks", "hooks.json"),
    ].filter((doc) => existsSync(doc));
    assert.ok(
      declarationDocs.some((doc) => readFileSync(doc, "utf8").includes(tail)),
      `${label} entrypoint ${tail} is not declared by any package/plugin surface`,
    );

    // The recorded runtime floor is the one the package itself declares (and a
    // repo-root consumer with no `engines` carries the canonical Node floor).
    if (consumer.runtime.declaration === "package-engines") {
      const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
      assert.equal(
        packageJson.engines?.[consumer.runtime.target],
        consumer.runtime.floor,
        `${label} recorded floor disagrees with the package's own engines.${consumer.runtime.target}`,
      );
    } else {
      assert.equal(consumer.runtime.declaration, "canonical-floor");
      assert.equal(consumer.runtime.target, "node");
      assert.ok(nodeFloors.has(consumer.runtime.floor), `${label} canonical floor is not the declared Node floor`);
    }
  }

  // R17: the ZCode consumer's generated artifact IS the committed hook bundle,
  // and its recorded build inputs cover the engine source the hook inlines.
  const zcode = consumerById(manifest, "zcode");
  assert.equal(zcode.capability, "writer");
  assert.deepEqual(zcode.generated.files.map((file) => file.path), ["hooks/mstar-write-gate.mjs"]);
  assert.equal(zcode.generated.files[0].sha256, sha256File(HOOK_ENTRY));
  const zcodeSourceRoots = zcode.sources.trees.map((tree) => tree.root).sort();
  assert.deepEqual(zcodeSourceRoots, ["hooks/src", "packages/engine/src"]);
});

test("per-consumer evidence documents mirror the aggregate manifest", () => {
  const manifest = readManifest();
  for (const consumer of manifest.consumers) {
    const packageRoot = consumer.packageRoot === "." ? REPO : join(REPO, consumer.packageRoot);
    const evidencePath = join(packageRoot, "execution-consumer", `${consumer.id}.json`);
    assert.ok(existsSync(evidencePath), `missing evidence document for ${consumer.id}`);
    const raw = readFileSync(evidencePath, "utf8");
    assert.equal(raw.endsWith("\n"), true, `${consumer.id} evidence document has no terminal LF`);
    const document = JSON.parse(raw);
    assert.equal(document.consumers.length, 1, `${consumer.id} evidence document must carry exactly one entry`);
    assert.deepEqual(document.consumers[0], consumer, `${consumer.id} evidence document drifted from the aggregate`);
  }
});

/* ------------------------------------------------------------------------ *
 * 3. The BUILT CLI over a populated temporary store
 * ------------------------------------------------------------------------ */

test("built CLI runs bind/resume/read/write on a populated execution store (DB-only, current generation)", async () => {
  const fixture = await makeActiveWorkspace("mstar-r3-cli");
  const planPath = join(fixture.harness, "plans", `${PLAN_ID}.md`);
  const sddDir = join(fixture.harness, "sdd", PLAN_ID);
  const worktreePath = join(fixture.root, "wt-r3");
  const evidencePath = join(sddDir, "evidence.md");
  const assignmentPath = join(sddDir, "assignment.md");
  writeText(planPath, `# Plan ${PLAN_ID}\n\n**plan_id:** ${PLAN_ID}\n`);
  writeText(evidencePath, "# evidence\n");
  mkdirSync(worktreePath, { recursive: true });
  writeText(
    assignmentPath,
    assignmentText({
      harness: fixture.harness,
      workflowId: WORKFLOW_ID,
      planId: PLAN_ID,
      planPath,
      worktreePath,
      branch: BRANCH,
      sddDir,
    }),
  );
  const progressPath = join(fixture.root, "progress.json");
  writeJson(progressPath, { status: "InReview", summary: "r3 assembled-package regression", evidence_paths: [evidencePath] });

  // The creation CAS consumes the ROOT token this store actually reports.
  const rootToken = (await readExecutionAuthority({ harnessDir: fixture.harness })).token;

  // --- write: workflow creation through the ACTIVE route -------------------
  const registered = ok(
    runCli(
      fixture,
      [
        "workflow",
        "register",
        "--workflow",
        WORKFLOW_ID,
        "--plan-id",
        PLAN_ID,
        "--plan-title",
        "R3 parity plan",
        "--plan-file",
        `plans/${PLAN_ID}.md`,
        "--delivery-kind",
        "development",
        "--branch-source",
        BRANCH,
        "--branch-target",
        "main",
        "--expect",
        rootToken,
        "--operation",
        "register-1",
        "--harness",
        fixture.harness,
        "--json",
      ],
      coordinatorIdentity(),
    ),
    "workflow register",
  );
  assert.equal(registered.route, "execution");
  assert.equal(registered.operation, "workflow register");
  assert.equal(registered.data.workflowId, WORKFLOW_ID);

  // --- bind: the trusted local coordinator bootstrap -----------------------
  const coordinatorToken = await tokenOf(fixture.harness, { workflowId: WORKFLOW_ID });
  const claimed = ok(
    runCli(
      fixture,
      [
        "plan",
        "bind",
        "--execution",
        "--workflow",
        WORKFLOW_ID,
        "--coordinator",
        "--expect",
        coordinatorToken,
        "--operation",
        "bind-coordinator",
        "--harness",
        fixture.harness,
        "--json",
      ],
      coordinatorIdentity(),
    ),
    "plan bind --coordinator",
  );
  assert.equal(claimed.route, "execution");
  assert.equal(claimed.operation, "bind");
  assert.equal(claimed.operation_id, "bind-coordinator");
  assert.equal(claimed.data.role, "coordinator");
  assert.equal(claimed.data.sessionId, COORDINATOR_ID);
  assert.equal(claimed.data.workflowId, WORKFLOW_ID);
  const coordinatorWire = encodeExecutionSessionRef(claimed.data);
  assert.ok(coordinatorWire.startsWith(WIRE_PREFIX), `unexpected session reference ${coordinatorWire}`);

  // --- write: prepare seals the reviewed Assignment ------------------------
  const prePrepareToken = await tokenOf(fixture.harness, { workflowId: WORKFLOW_ID, planId: PLAN_ID });
  const prepared = ok(
    runCli(
      fixture,
      [
        "plan",
        "prepare",
        "--session-ref",
        coordinatorWire,
        "--plan",
        PLAN_ID,
        "--assignment",
        assignmentPath,
        "--expect",
        prePrepareToken,
        "--operation",
        "prepare-1",
        "--harness",
        fixture.harness,
        "--json",
      ],
      coordinatorIdentity(),
    ),
    "plan prepare",
  );
  assert.equal(prepared.route, "execution");
  assert.equal(prepared.data.plan.id, PLAN_ID);
  assert.equal(prepared.data.coordination.prepared.assignment_path, assignmentPath);

  // --- bind: the plan seat claims the row's execution lease ----------------
  const postPrepareToken = await tokenOf(fixture.harness, { workflowId: WORKFLOW_ID, planId: PLAN_ID });
  const planBound = ok(
    runCli(
      fixture,
      [
        "plan",
        "bind",
        "--execution",
        "--workflow",
        WORKFLOW_ID,
        "--plan",
        PLAN_ID,
        "--expect",
        postPrepareToken,
        "--operation",
        "bind-plan-pm",
        "--harness",
        fixture.harness,
        "--json",
      ],
      planPmIdentity(),
    ),
    "plan bind --plan",
  );
  assert.equal(planBound.operation, "bind");
  assert.equal(planBound.data.role, "plan-pm");
  assert.equal(planBound.data.planId, PLAN_ID);
  assert.equal(planBound.data.sessionId, PLAN_PM_ID);
  const planPmWire = encodeExecutionSessionRef(planBound.data);
  assert.ok(planPmWire.startsWith(WIRE_PREFIX));

  // --- read: the session-authorized view of the prepared row ---------------
  const viewed = ok(
    runCli(
      fixture,
      ["plan", "show", "--session-ref", planPmWire, "--plan", PLAN_ID, "--harness", fixture.harness, "--json"],
      planPmIdentity(),
    ),
    "plan show",
  );
  assert.equal(viewed.route, "execution");
  assert.equal(viewed.operation, "show");
  assert.equal(viewed.data.plan.id, PLAN_ID);
  assert.equal(viewed.data.session.sessionId, PLAN_PM_ID);
  assert.equal(viewed.data.coordination.prepared.assignment_path, assignmentPath);

  // --- read-only resume: an existing reference resumes under this identity --
  const resumed = ok(
    runCli(fixture, ["plan", "bind", "--execution", "--resume-ref", planPmWire, "--json"], planPmIdentity()),
    "plan bind --resume-ref",
  );
  assert.equal(resumed.route, "execution");
  assert.equal(resumed.operation, "bind");
  assert.equal(resumed.data.sessionId, PLAN_PM_ID);
  // A resume is a read: it carries neither an operation receipt nor a replay flag.
  assert.equal(resumed.operation_id, undefined);
  assert.equal(resumed.replayed, undefined);

  // --- write: the plan-owned progress mutation, then its exact retry -------
  const progressArgs = [
    "plan",
    "progress",
    "--session-ref",
    planPmWire,
    "--file",
    progressPath,
    "--expect",
    await tokenOf(fixture.harness, { workflowId: WORKFLOW_ID, planId: PLAN_ID }),
    "--operation",
    "progress-1",
    "--harness",
    fixture.harness,
    "--json",
  ];
  const progressed = ok(runCli(fixture, progressArgs, planPmIdentity()), "plan progress");
  assert.equal(progressed.route, "execution");
  assert.equal(progressed.operation, "progress");
  assert.equal(progressed.replayed, false);
  assert.equal(progressed.data.plan.status, "InReview");
  assert.equal(progressed.data.coordination.progress.status, "InReview");

  const retried = ok(runCli(fixture, progressArgs, planPmIdentity()), "plan progress (retry)");
  assert.equal(retried.replayed, true, "an identical retry must replay the recorded receipt, not re-commit");
  assert.equal(retried.operation_id, "progress-1");
  assert.equal(retried.data.plan.status, "InReview");

  // --- the AUTHORITY's own truth, not the CLI's claim ---------------------
  const authority = await readExecutionAuthority({ harnessDir: fixture.harness }, { workflowId: WORKFLOW_ID, planId: PLAN_ID });
  assert.equal(authority.data.workflow.id, WORKFLOW_ID);
  assert.equal(authority.data.plan.id, PLAN_ID);
  assert.equal(authority.data.plan.status, "InReview");
  assert.equal(authority.data.session.sessionId, PLAN_PM_ID);
  assert.equal(authority.data.coordination.progress.summary, "r3 assembled-package regression");
  assert.equal(authority.data.coordination.prepared.prepared_by, COORDINATOR_ID);
  assert.equal(progressed.store_id, authority.storeId, "the CLI's reported store disagrees with the authority read");
  assert.equal(progressed.epoch, authority.epoch, "the CLI's reported epoch disagrees with the authority read");

  // --- current generation: the database is the ONLY persistence route -----
  assert.ok(!existsSync(join(fixture.harness, "status.json")), "the active route must not write a root status.json");
  assert.ok(
    !existsSync(join(fixture.harness, "workflows", WORKFLOW_ID, "snapshot.json")),
    "the active route must not write a workflow snapshot",
  );
});

test("the store the built CLI wrote is a real node:sqlite authority", async () => {
  const fixture = await makeActiveWorkspace("mstar-r3-sqlite");
  writeText(join(fixture.harness, "plans", `${PLAN_ID}.md`), `# Plan ${PLAN_ID}\n\n**plan_id:** ${PLAN_ID}\n`);
  const rootToken = (await readExecutionAuthority({ harnessDir: fixture.harness })).token;
  ok(
    runCli(
      fixture,
      [
        "workflow",
        "register",
        "--workflow",
        WORKFLOW_ID,
        "--plan-id",
        PLAN_ID,
        "--plan-title",
        "R3 sqlite plan",
        "--plan-file",
        `plans/${PLAN_ID}.md`,
        "--delivery-kind",
        "development",
        "--branch-source",
        BRANCH,
        "--branch-target",
        "main",
        "--expect",
        rootToken,
        "--operation",
        "register-1",
        "--harness",
        fixture.harness,
        "--json",
      ],
      coordinatorIdentity(),
    ),
    "workflow register",
  );
  const coordinatorToken = await tokenOf(fixture.harness, { workflowId: WORKFLOW_ID });
  ok(
    runCli(
      fixture,
      [
        "plan",
        "bind",
        "--execution",
        "--workflow",
        WORKFLOW_ID,
        "--coordinator",
        "--expect",
        coordinatorToken,
        "--operation",
        "bind-coordinator",
        "--harness",
        fixture.harness,
        "--json",
      ],
      coordinatorIdentity(),
    ),
    "plan bind --coordinator",
  );

  // Read the store the CLI actually wrote, straight through node:sqlite.
  const dbPath = join(fixture.harness, "store.db");
  assert.ok(existsSync(dbPath), `the built CLI wrote no store at ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((row) => row.name);
    for (const table of [
      "execution_meta",
      "execution_workflows",
      "execution_plans",
      "execution_sessions",
      "execution_operations",
    ]) {
      assert.ok(tables.includes(table), `node:sqlite store is missing ${table}`);
    }
    const meta = db.prepare("select authority_state, protocol_version from execution_meta where id = 1").get();
    assert.equal(meta.authority_state, "active");
    assert.equal(meta.protocol_version, 1);
    const workflows = db
      .prepare("select workflow_id, state_json from execution_workflows where workflow_id = ?")
      .all(WORKFLOW_ID);
    assert.equal(workflows.length, 1, "the created workflow is not in the store's own table");
    assert.equal(JSON.parse(workflows[0].state_json).id, WORKFLOW_ID);
    const sessions = db
      .prepare("select session_id, role, state from execution_sessions where workflow_id = ? order by role")
      .all(WORKFLOW_ID);
    assert.deepEqual(
      sessions.map((row) => [row.role, row.session_id, row.state]),
      [["coordinator", COORDINATOR_ID, "active"]],
    );
    const operations = db
      .prepare("select operation_id from execution_operations where workflow_id = ? order by operation_id")
      .all(WORKFLOW_ID)
      .map((row) => row.operation_id);
    assert.ok(operations.includes("bind-coordinator"), `the bind's replay key is not recorded: ${JSON.stringify(operations)}`);
  } finally {
    db.close();
  }
});

/* ------------------------------------------------------------------------ *
 * 4. The COMMITTED ZCode hook bundle
 * ------------------------------------------------------------------------ */

test("committed ZCode hook refuses the retired coordination-document route on an ACTIVE authority", async () => {
  const fixture = await makeActiveWorkspace("mstar-r3-hook-active");
  // The ZCode hook resolves the harness root through the same engine path
  // resolution; pin it to this fixture so no ambient root can be consulted.
  const env = { MSTAR_HARNESS_DIR: fixture.harness };

  // A VALID root status.json write is still refused: while the execution
  // authority is ACTIVE the file is retired as a persistence route.
  const retired = runGate(
    writeEvent(
      { file_path: join(fixture.harness, "status.json"), content: JSON.stringify({ version: 2, updated_at: "2026-09-23", workflows: [] }) },
      fixture.root,
    ),
    { env },
  );
  assert.equal(retired.exitCode, 2, `expected a block, got ${retired.exitCode} (stderr: ${retired.stderr})`);
  assert.equal(retired.stdout, "");
  const lines = retired.stderr.trimEnd().split("\n");
  assert.equal(lines[0], "[Morning Star write gate] blocked Write to status.json");
  assert.ok(lines[1].startsWith("[high] execution.direct-write-refused: "), `unexpected violation line: ${lines[1]}`);

  // The authority database itself is never hand-writable.
  const storeWrite = runGate(
    writeEvent({ file_path: join(fixture.harness, "store.db"), content: "nope" }, fixture.root),
    { env },
  );
  assert.equal(storeWrite.exitCode, 2);
  assert.equal(storeWrite.stdout, "");
  assert.ok(storeWrite.stderr.includes("[high] store.direct-write-refused: "), `unexpected: ${storeWrite.stderr}`);

  // And a workflow snapshot reached through the same authority is refused too.
  const snapshot = runGate(
    writeEvent(
      { file_path: join(fixture.harness, "workflows", WORKFLOW_ID, "snapshot.json"), content: JSON.stringify({ schema_version: 1 }) },
      fixture.root,
    ),
    { env },
  );
  assert.equal(snapshot.exitCode, 2);
  assert.ok(snapshot.stderr.includes("[high] execution.direct-write-refused: "), `unexpected: ${snapshot.stderr}`);
});

test("committed ZCode hook keeps the pre-activation document gate intact", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-r3-hook-legacy-")));
  roots.push(root);
  const harness = join(root, ".mstar");
  mkdirSync(join(harness, "workflows"), { recursive: true });
  mkdirSync(join(harness, "projects"), { recursive: true });
  const validStatus = JSON.stringify({ version: 2, updated_at: "2026-09-23", workflows: [] });
  writeFileSync(join(harness, "status.json"), validStatus);

  // A valid coordination document still passes silently (exit 0, no output).
  const pass = runGate(writeEvent({ file_path: join(harness, "status.json"), content: validStatus }, root));
  assert.equal(pass.exitCode, 0, `expected a silent pass, got ${pass.exitCode} (stderr: ${pass.stderr})`);
  assert.equal(pass.stdout, "");
  assert.equal(pass.stderr, "");

  // Under opt-in hard enforcement an invalid document still blocks, with the
  // frozen stderr shape (header, violation line, enforcement line).
  writeFileSync(join(root, ".mstarc"), "[config]\nenforcement=hard\n");
  const blocked = runGate(writeEvent({ file_path: join(harness, "status.json"), content: "{ not json" }, root));
  assert.equal(blocked.exitCode, 2);
  assert.equal(blocked.stdout, "");
  const lines = blocked.stderr.trimEnd().split("\n");
  assert.equal(lines[0], "[Morning Star write gate] blocked Write to status.json");
  assert.ok(lines[1].startsWith("[high] status.invalid-json: "), `unexpected violation line: ${lines[1]}`);
  assert.equal(lines.length, 3);
});

/* ------------------------------------------------------------------------ *
 * 5. H2's OMP source fixture recipe on the built engine (NOT a native-host test)
 * ------------------------------------------------------------------------ */

test("H2's OMP source fixture recipe executes on the built engine under real Node", async () => {
  // NOT a native-host test: no OMP host process is started. This reuses the
  // reviewed `phase2-launches` seed recipe (a real populated DB: catalog plan
  // registration, a `phase-2-execute` workflow holding the plan with its lease
  // scope, a prepared Assignment through the DB verb, and coordinator +
  // plan-pm session binds) against the BUILT engine generation, so the OMP
  // consumer's DB route is proven on the assembled package rather than on
  // source.
  const fixture = await makeActiveWorkspace("mstar-r3-omp");
  const rootToken = (await readExecutionAuthority({ harnessDir: fixture.harness })).token;

  const integrationPath = join(fixture.root, "integration-wt");
  const worktreePath = join(fixture.root, "wt-omp");
  mkdirSync(integrationPath, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  const planPath = join(fixture.harness, "plans", `${OMP_PLAN_ID}.md`);
  const sddDir = join(fixture.harness, "sdd", OMP_PLAN_ID);
  const assignmentPath = join(sddDir, "assignment.md");
  writeText(planPath, `# Plan ${OMP_PLAN_ID}\n\n**plan_id:** ${OMP_PLAN_ID}\n`);
  writeText(
    assignmentPath,
    assignmentText({
      harness: fixture.harness,
      workflowId: OMP_WORKFLOW_ID,
      planId: OMP_PLAN_ID,
      planPath,
      worktreePath,
      branch: BRANCH,
      sddDir,
    }),
  );

  await registerCatalogEntity(
    { harnessDir: fixture.harness },
    { kind: "plan", id: OMP_PLAN_ID, title: `Plan ${OMP_PLAN_ID}`, rootKind: "plans", relativePath: `plans/${OMP_PLAN_ID}.md` },
    { operationId: `register-${OMP_PLAN_ID}`, actor: "r3-node-regression" },
  );

  const coordinatorContext = {
    harnessDir: fixture.harness,
    caller: { sessionId: OMP_COORDINATOR_ID, role: "coordinator", workflowId: OMP_WORKFLOW_ID, planId: null },
  };
  const created = await createExecutionWorkflow(coordinatorContext, {
    entry: { id: OMP_WORKFLOW_ID, type: "iteration", started_at: "2026-09-23T00:00:00Z", dir: `workflows/${OMP_WORKFLOW_ID}` },
    snapshot: {
      schema_version: 1,
      id: OMP_WORKFLOW_ID,
      type: "iteration",
      status: "running",
      phase: "phase-2-execute",
      started_at: "2026-09-23T00:00:00Z",
      updated_at: "2026-09-23T00:00:00Z",
      branch: { base: "main", integration: "integration/r3" },
      integration_worktree_path: integrationPath,
      plans: [
        {
          id: OMP_PLAN_ID,
          title: `Plan ${OMP_PLAN_ID}`,
          file: `plans/${OMP_PLAN_ID}.md`,
          status: "Todo",
          metadata: { worktree_path: worktreePath, working_branch: BRANCH },
        },
      ],
    },
    expected: rootToken,
    operationId: `create-${OMP_WORKFLOW_ID}`,
  });
  assert.equal(created.data.workflows[0].state.id, OMP_WORKFLOW_ID);

  const workflowToken = await tokenOf(fixture.harness, { workflowId: OMP_WORKFLOW_ID });
  const bound = await bindExecutionSession(coordinatorContext, {
    workflowId: OMP_WORKFLOW_ID,
    planId: null,
    role: "coordinator",
    expected: workflowToken,
    operationId: `bind-${OMP_COORDINATOR_ID}`,
  });
  assert.equal(bound.data.role, "coordinator");
  assert.equal(bound.data.sessionId, OMP_COORDINATOR_ID);

  // The canonical workflow directory the launcher's journal lives in must exist.
  mkdirSync(join(fixture.harness, "workflows", OMP_WORKFLOW_ID), { recursive: true });
  const prepared = await mutateExecutionPlan(coordinatorContext, {
    operationId: `prepare-${OMP_PLAN_ID}`,
    session: plainRef(bound.data),
    expected: await tokenOf(fixture.harness, { workflowId: OMP_WORKFLOW_ID, planId: OMP_PLAN_ID }),
    planId: OMP_PLAN_ID,
    operation: { kind: "prepare", assignmentPath },
  });
  assert.equal(prepared.data.coordination.prepared.assignment_path, assignmentPath);
  assert.equal(prepared.data.coordination.prepared.prepared_by, OMP_COORDINATOR_ID);

  const planContext = {
    harnessDir: fixture.harness,
    caller: { sessionId: OMP_PLAN_SESSION_ID, role: "plan-pm", workflowId: OMP_WORKFLOW_ID, planId: OMP_PLAN_ID },
  };
  const planBound = await bindExecutionSession(planContext, {
    workflowId: OMP_WORKFLOW_ID,
    planId: OMP_PLAN_ID,
    role: "plan-pm",
    expected: await tokenOf(fixture.harness, { workflowId: OMP_WORKFLOW_ID, planId: OMP_PLAN_ID }),
    operationId: `bind-${OMP_PLAN_SESSION_ID}`,
  });
  assert.equal(planBound.data.role, "plan-pm");
  assert.equal(planBound.data.planId, OMP_PLAN_ID);

  const workflowRead = await readExecutionAuthority({ harnessDir: fixture.harness }, { workflowId: OMP_WORKFLOW_ID });
  const entry = workflowRead.data.workflows.find((candidate) => candidate.state.id === OMP_WORKFLOW_ID);
  assert.ok(entry, "the registered workflow is not readable through the authority");
  assert.equal(entry.state.phase, "phase-2-execute");
  assert.equal(entry.plans.length, 1);
  assert.equal(entry.coordinator.sessionId, OMP_COORDINATOR_ID);

  const planRead = await readExecutionAuthority({ harnessDir: fixture.harness }, { workflowId: OMP_WORKFLOW_ID, planId: OMP_PLAN_ID });
  assert.equal(planRead.data.plan.id, OMP_PLAN_ID);
  assert.equal(planRead.data.session.sessionId, OMP_PLAN_SESSION_ID);

  // The populated fixture is a real SQLite authority, not an in-memory stub.
  const db = new DatabaseSync(join(fixture.harness, "store.db"), { readOnly: true });
  try {
    const sessions = db
      .prepare("select role, session_id from execution_sessions where workflow_id = ? order by role")
      .all(OMP_WORKFLOW_ID);
    assert.deepEqual(
      sessions.map((row) => [row.role, row.session_id]),
      [
        ["coordinator", OMP_COORDINATOR_ID],
        ["plan-pm", OMP_PLAN_SESSION_ID],
      ],
    );
    const leases = db.prepare("select plan_id from execution_leases where workflow_id = ?").all(OMP_WORKFLOW_ID);
    assert.deepEqual(
      leases.map((row) => row.plan_id),
      [OMP_PLAN_ID],
      "the plan-pm bind must claim the row's execution lease",
    );
  } finally {
    db.close();
  }
});
