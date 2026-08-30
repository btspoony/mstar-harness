#!/usr/bin/env bun
/**
 * ci-packed-manifest-guard.ts — the root package.json is the manifest that
 * git/hosted installs resolve (`omp plugin install github:…`,
 * `bun add github:…`). The `workspace:` protocol is pack-time-only syntax and
 * unresolvable outside the declaring workspace, so a `workspace:` spec in a
 * shipped dependency section breaks every hosted install at resolve time
 * (20260829-omp-git-install-workspace-dep hotfix).
 *
 * Raw violations fail fast (report + exit 1) before packing: a raw
 * `workspace:` spec makes `bun pm pack` throw, which would preempt the
 * guard's own rejection report.
 *
 * The section scan is a pure exported function; its semantics are guarded by
 * `scripts/ci-packed-manifest-guard.test.ts`.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHIPPED_SECTIONS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;

type Manifest = Partial<
  Record<(typeof SHIPPED_SECTIONS)[number] | "devDependencies", Record<string, string>>
>;

/** `workspace:` specs found in shipped dependency sections (devDependencies exempt). */
export function findWorkspaceSpecs(manifest: Manifest): string[] {
  const hits: string[] = [];
  for (const section of SHIPPED_SECTIONS) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) {
        hits.push(`${section}["${name}"] = "${spec}"`);
      }
    }
  }
  return hits;
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`command failed: ${cmd.join(" ")}`);
}

function fail(failures: string[]): never {
  console.error(
    "workspace: protocol is unresolvable in hosted/git installs — forbidden in shipped dependency sections:",
  );
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

async function main(): Promise<void> {
  // 1. Raw root manifest — what `bun add github:…` resolves before any pack
  //    rewriting (the 20260829 failure happened at this stage). Fail fast:
  //    `bun pm pack` below rejects raw `workspace:` specs itself, and its
  //    throw would preempt this guard's own rejection report.
  const rawFailures = findWorkspaceSpecs(
    (await Bun.file("package.json").json()) as Manifest,
  ).map((hit) => `package.json ${hit}`);
  if (rawFailures.length) fail(rawFailures);

  // 2. Packed manifest — what a hosted install actually receives. Only runs
  //    when the raw manifest is clean.
  const failures: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "packed-manifest-guard-"));
  try {
    await run(["bun", "pm", "pack", "--destination", dir, "--quiet"]);
    const tgz = readdirSync(dir).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error(`bun pm pack produced no tarball in ${dir}`);
    await run(["tar", "-xzf", join(dir, tgz), "-C", dir]);
    const packed = (await Bun.file(join(dir, "package", "package.json")).json()) as Manifest;
    for (const hit of findWorkspaceSpecs(packed)) failures.push(`packed manifest ${hit}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length) fail(failures);
  console.log("OK — raw + packed root manifests carry no workspace: specs in shipped dependency sections");
}

if (import.meta.main) {
  await main();
}
