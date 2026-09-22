/**
 * scripts/execution-consumer-manifest.test.ts — parity/refusal coverage for the
 * consumer-v1 inventory producer (contract §4.2 / §7 R1).
 *
 * The fixture is a self-contained temporary checkout: a small instruction
 * corpus (`skills/`, `commands/`, `agents/`, including a relative symlink), the
 * five package layouts and the committed ZCode hook artifact. Nothing outside
 * the fixture is read — the "no installed state" case proves a recorded
 * out-of-root path refuses before any bytes are touched.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CONSUMER_MANIFEST_PROTOCOL,
  ExecutionConsumerManifestError,
  type ExecutionConsumerManifest,
  collectExecutionConsumerManifest,
  executionConsumerManifestPaths,
  runExecutionConsumerManifestCli,
  verifyExecutionConsumerManifest,
} from "./execution-consumer-manifest.ts";

const SCRIPT = join(import.meta.dir, "execution-consumer-manifest.ts");
const INSTRUCTION_ROOTS = ["skills", "commands", "agents"] as const;
const OMP_TOOLS = [
  "mstar_dispatch_validate",
  "mstar_iteration_gate",
  "mstar_lease_verify",
  "mstar_path_resolve",
  "mstar_status_validate",
  "mstar_worktree_check",
] as const;

/** Structure of a JSON-round-tripped manifest; the type-only refusals under
 * test need a writable shape, and the manifest contract stays the source of
 * truth via the `verifyExecutionConsumerManifest` calls around each mutation. */
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
    runtime: { target: string; floor: string; declaration: string };
    sources: { path: string; sha256: string }[];
    generated: { path: string; sha256: string }[];
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

function copyInto(root: string, from: string, to: string): void {
  const dest = join(root, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(root, from), dest, { recursive: true });
}

function packageJson(root: string, dir: string, engines: Record<string, string>): void {
  write(
    root,
    `${dir}/package.json`,
    `${JSON.stringify({ name: `@mstar-harness/${dir.split("/").pop()}`, engines }, null, 2)}\n`,
  );
}

function scaffoldInstructions(root: string): void {
  write(root, "skills/mstar-demo/SKILL.md", "# demo skill\n");
  write(root, "skills/shared/note.md", "shared note\n");
  write(root, "commands/mstar-demo.md", "# demo command\n");
  write(root, "agents/mstar-demo.md", "# demo agent\n");
  // Relative link that stays inside the tree after `cpSync` preserves it.
  symlinkSync("../shared/note.md", join(root, "skills/mstar-demo/linked.md"));
}

function buildFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "execution-consumer-manifest-"));
  fixtures.push(root);
  scaffoldInstructions(root);

  packageJson(root, "packages/engine", { bun: ">=1.4.0", node: ">=24.18.0" });
  write(root, "packages/engine/src/index.ts", "export const engine = 1;\n");
  write(root, "packages/engine/dist/engine.js", "// engine bundle\n");
  write(root, "packages/engine/dist/audit.js", "// audit bundle\n");

  packageJson(root, "packages/cli", { bun: ">=1.4.0", node: ">=24.18.0" });
  write(root, "packages/cli/src/index.ts", "export const cli = 1;\n");
  write(root, "packages/cli/dist/mstar-harness.js", "// cli bundle\n");

  packageJson(root, "packages/dsh", { bun: ">=1.4.0" });
  write(root, "packages/dsh/src/index.ts", "export const dsh = 1;\n");
  write(root, "packages/dsh/src/invariant.ts", "export const invariant = 1;\n");
  write(root, "packages/dsh/dist/index.js", "// dsh bundle\n");
  write(root, "packages/dsh/dist/invariant.js", "// dsh invariant bundle\n");
  for (const instructionRoot of INSTRUCTION_ROOTS) {
    copyInto(root, instructionRoot, `packages/dsh/harness-${instructionRoot}`);
  }

  packageJson(root, "packages/omp", { bun: ">=1.4.0" });
  write(root, "packages/omp/src/hooks/pre/mstar-gates.ts", "export const gates = 1;\n");
  write(root, "packages/omp/src/extensions/model-handoff.ts", "export const handoff = 1;\n");
  write(root, "packages/omp/src/extensions/phase2-orchestration.ts", "export const phase2 = 1;\n");
  write(root, "packages/omp/dist/hooks/pre/mstar-gates.js", "// omp pre hook\n");
  write(root, "packages/omp/dist/extensions/model-handoff.js", "// omp handoff\n");
  write(root, "packages/omp/dist/extensions/phase2-orchestration.js", "// omp phase2\n");
  for (const tool of OMP_TOOLS) {
    write(root, `packages/omp/dist/tools/${tool}/index.js`, `// omp tool ${tool}\n`);
  }
  for (const instructionRoot of INSTRUCTION_ROOTS) {
    copyInto(root, instructionRoot, `packages/omp/harness-${instructionRoot}`);
    copyInto(root, instructionRoot, `packages/omp/${instructionRoot}`);
  }

  packageJson(root, "packages/opencode", { bun: ">=1.4.0", node: ">=24.18.0" });
  write(root, "packages/opencode/src/mstar.ts", "export const mstar = 1;\n");
  write(root, "packages/opencode/dist/mstar.js", "// opencode bundle\n");
  write(root, "packages/opencode/agents/pm.md", "# opencode-only primary\n");
  for (const instructionRoot of INSTRUCTION_ROOTS) {
    copyInto(root, instructionRoot, `packages/opencode/harness-${instructionRoot}`);
  }
  copyInto(root, "packages/opencode/agents", "packages/opencode/harness-agents");

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

function asManifest(manifest: MutableManifest): ExecutionConsumerManifest {
  // Intentionally-invalid documents under test: the refusals below assert that
  // verification rejects the tampered value before trusting it.
  return manifest as unknown as ExecutionConsumerManifest;
}

function expectRefusal(run: () => void, code: string): void {
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

afterAll(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

describe("execution-consumer-manifest — canonical collection", () => {
  test("collects the exact consumer set with capabilities, runtime floors and copied trees", () => {
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

    const cli = manifest.consumers.find((consumer) => consumer.id === "cli");
    expect(cli?.capability).toBe("writer");
    expect(cli?.runtime).toEqual({
      target: "node",
      declaration: "package-engines",
      floor: ">=24.18.0",
    });
    const omp = manifest.consumers.find((consumer) => consumer.id === "omp");
    expect(omp?.runtime.target).toBe("bun");
    expect(omp?.runtime.floor).toBe(">=1.4.0");

    // decision-only is explicit, never an absent or writer capability.
    const opencode = manifest.consumers.find((consumer) => consumer.id === "opencode");
    expect(opencode?.capability).toBe("decision-only");
    expect(opencode?.capabilityNote).toContain("decision-only");

    // ZCode has no package metadata; its floor is declared as the canonical one.
    const zcode = manifest.consumers.find((consumer) => consumer.id === "zcode");
    expect(zcode?.runtime.declaration).toBe("canonical-floor");
    expect(zcode?.runtime.floor).toBe(">=24.18.0");
    expect(zcode?.entrypoint).toBe("hooks/mstar-write-gate.mjs");

    const dshCopies = manifest.consumers.find((consumer) => consumer.id === "dsh")?.copiedInstructions ?? [];
    expect(dshCopies.map((tree) => `${tree.sourceRoot}->${tree.targetRoot}`)).toEqual([
      "agents->packages/dsh/harness-agents",
      "commands->packages/dsh/harness-commands",
      "skills->packages/dsh/harness-skills",
    ]);
    expect(dshCopies.map((tree) => tree.files)).toEqual([1, 1, 3]);

    const ompCopies = manifest.consumers.find((consumer) => consumer.id === "omp")?.copiedInstructions ?? [];
    expect(ompCopies.map((tree) => tree.targetRoot)).toEqual([
      "packages/omp/agents",
      "packages/omp/commands",
      "packages/omp/harness-agents",
      "packages/omp/harness-commands",
      "packages/omp/harness-skills",
      "packages/omp/skills",
    ]);

    verifyExecutionConsumerManifest(manifest);
  });

  test("refuses to collect when build output is missing instead of fabricating parity", () => {
    const root = buildFixture();
    unlinkSync(join(root, "packages/engine/dist/engine.js"));
    expectRefusal(() => collectExecutionConsumerManifest(root), "consumer.path-missing");

    const emptyRoot = buildFixture();
    writeFileSync(join(emptyRoot, "packages/cli/dist/mstar-harness.js"), "");
    expectRefusal(() => collectExecutionConsumerManifest(emptyRoot), "consumer.generated-empty");
  });

  test("refuses a package whose engines floor is not the canonical runtime floor", () => {
    const root = buildFixture();
    packageJson(root, "packages/cli", { bun: ">=1.4.0", node: ">=22.0.0" });
    expectRefusal(() => collectExecutionConsumerManifest(root), "consumer.runtime-mismatch");
  });
});

describe("execution-consumer-manifest — verification refusals", () => {
  test("passes on the exact fixture tree and refuses a stale generated artifact", () => {
    const root = buildFixture();
    const manifest = collectExecutionConsumerManifest(root);
    verifyExecutionConsumerManifest(manifest);

    writeFileSync(join(root, "packages/engine/dist/engine.js"), "// stale engine bundle\n");
    expectRefusal(() => verifyExecutionConsumerManifest(manifest), "consumer.digest-mismatch");
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

  test("refuses a stale copied instruction corpus", () => {
    const root = buildFixture();
    const manifest = collectExecutionConsumerManifest(root);
    writeFileSync(
      join(root, "packages/dsh/harness-skills/mstar-demo/SKILL.md"),
      "# drifted skill\n",
    );
    expectRefusal(() => verifyExecutionConsumerManifest(manifest), "consumer.digest-mismatch");
  });

  test("refuses a copied symlink repointed at another same-content file", () => {
    const root = buildFixture();
    const manifest = collectExecutionConsumerManifest(root);
    writeFileSync(join(root, "packages/dsh/harness-skills/shared/other.md"), "shared note\n");
    unlinkSync(join(root, "packages/dsh/harness-skills/mstar-demo/linked.md"));
    symlinkSync("../shared/other.md", join(root, "packages/dsh/harness-skills/mstar-demo/linked.md"));
    expectRefusal(() => verifyExecutionConsumerManifest(manifest), "consumer.digest-mismatch");
  });

  test("refuses runtime, capability and digest tampering in the manifest itself", () => {
    const root = buildFixture();
    const manifest = collectExecutionConsumerManifest(root);

    const runtimeTamper = cloneManifest(manifest);
    consumerIn(runtimeTamper, "engine").runtime.floor = ">=22.0.0";
    expectRefusal(() => verifyExecutionConsumerManifest(asManifest(runtimeTamper)), "consumer.runtime-mismatch");

    const capabilityTamper = cloneManifest(manifest);
    consumerIn(capabilityTamper, "opencode").capability = "writer";
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

    const hashTamper = cloneManifest(manifest);
    consumerIn(hashTamper, "cli").generated[0]!.sha256 = "0".repeat(64);
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
  });

  test("refuses a recorded path that would leave the repo root, without inspecting it", () => {
    const root = buildFixture();
    const outside = join(dirname(root), "outside-consumer-artifact.js");
    writeFileSync(outside, "// installed or foreign artifact\n");
    try {
      const manifest = collectExecutionConsumerManifest(root);

      const escaped = cloneManifest(manifest);
      consumerIn(escaped, "cli").generated[0]!.path = "../outside-consumer-artifact.js";
      expectRefusal(() => verifyExecutionConsumerManifest(asManifest(escaped)), "consumer.path-outside-root");

      const absolute = cloneManifest(manifest);
      consumerIn(absolute, "cli").generated[0]!.path = "/etc/hosts";
      expectRefusal(() => verifyExecutionConsumerManifest(asManifest(absolute)), "consumer.path-outside-root");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("refuses a symlink that resolves outside the repository", () => {
    const root = buildFixture();
    const outside = join(dirname(root), "outside-link.md");
    writeFileSync(outside, "outside target\n");
    symlinkSync(outside, join(root, "skills/mstar-demo/escaped.md"));
    expectRefusal(() => collectExecutionConsumerManifest(root), "consumer.copy-symlink-escapes-tree");
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
      "hooks/execution-consumer.json",
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

    expect(await runExecutionConsumerManifestCli(["--repo", root, "--check"], root)).toBe(0);
    expect(targets.map((target) => readFileSync(target, "utf8"))).toEqual(written);

    // A drifted copy of one manifest refuses rather than silently winning.
    writeFileSync(join(root, "hooks/execution-consumer.json"), "{}\n");
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
