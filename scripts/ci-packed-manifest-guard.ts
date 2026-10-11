#!/usr/bin/env bun
/**
 * `package.json` is the manifest that git/hosted installs resolve
 * (`omp plugin install github:…`, `bun add github:…`). The `workspace:`
 * protocol is pack-time-only syntax and unresolvable outside the declaring
 * workspace, so a `workspace:` spec in a shipped dependency section breaks
 * every hosted install at resolve time (the hotfix that motivated this guard).
 *
 * The same raw + packed check can target a package manifest path, for example
 * `bun run ci:packed-manifest-guard -- packages/opencode-v2/package.json`.
 *
 * Raw violations fail fast (report + exit 1) before packing: a raw
 * `workspace:` spec makes `bun pm pack` throw, which would preempt the
 * guard's own rejection report.
 *
 * The section scan is a pure exported function; its semantics are guarded by
 * `scripts/ci-packed-manifest-guard.test.ts`.
 */
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

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

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
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
  const manifestPath = resolve(process.argv[2] ?? "package.json");
  const packageDir = dirname(manifestPath);
  const packageLabel = process.argv[2] ?? "root package.json";

  // 1. Raw manifest — what hosted installs resolve before pack rewriting.
  const rawFailures = findWorkspaceSpecs(
    (await Bun.file(manifestPath).json()) as Manifest,
  ).map((hit) => `${packageLabel} ${hit}`);
  if (rawFailures.length) fail(rawFailures);

  // 2. Packed manifest — what a hosted install actually receives.
  const failures: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "packed-manifest-guard-"));
  try {
    await run(["bun", "pm", "pack", "--destination", dir, "--quiet"], packageDir);
    const tgz = readdirSync(dir).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error(`bun pm pack produced no tarball in ${dir}`);
    await run(["tar", "-xzf", join(dir, tgz), "-C", dir], packageDir);
    const packed = (await Bun.file(join(dir, "package", "package.json")).json()) as Manifest;
    for (const hit of findWorkspaceSpecs(packed)) failures.push(`packed ${packageLabel} ${hit}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length) fail(failures);
  console.log(`OK — raw + packed ${packageLabel} manifests carry no workspace: specs in shipped dependency sections`);
}

if (import.meta.main) {
  await main();
}
