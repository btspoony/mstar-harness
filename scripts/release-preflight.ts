#!/usr/bin/env bun
/**
 * release-preflight.ts — decide the publish set before anything is published.
 *
 * Usage:
 *   bun run scripts/release-preflight.ts <version>
 *
 * The Release workflow runs this before its first `npm publish`. For every
 * non-private workspace package it asks the registry whether `<name>@<version>`
 * already exists:
 *
 *   - `skip`    — HTTP 200; npm rejects a duplicate version, so this package
 *                 must not be published again.
 *   - `publish` — HTTP 404; the version is free.
 *   - refuse    — any other status or an unreachable registry. An unknown
 *                 registry state is never treated as "publish", because that
 *                 would repeat the duplicate-publish failure this check exists
 *                 to prevent.
 *
 * It also refuses when a publishable manifest does not carry `<version>`: the
 * release surfaces were then not prepared for this version.
 *
 * When `GITHUB_OUTPUT` is set, `skip=` and `publish=` (space-separated names)
 * are appended for the workflow steps to consume.
 */
import { appendFileSync } from "node:fs";
import {
  publishedPackageNames,
  type RegistryFetch,
  REGISTRY_TIMEOUT_MS,
} from "./prepare-release.ts";
import { RELEASE_VERSION_RE, VERSION_SURFACES } from "./release-surfaces.ts";

const REGISTRY_URL = "https://registry.npmjs.org";

/** A workspace package the release may publish. */
export type PublishablePackage = { name: string; version: string };

/** Publish/skip decision for the whole release, or an actionable refusal. */
export type PublishSetDecision =
  | { status: "ready"; skip: string[]; publish: string[]; lines: string[] }
  | { status: "refused"; message: string };

/**
 * Workspace packages the release may publish: a package manifest under a
 * `packages/` subdirectory with a name and no `private: true`. The selection
 * rule itself is owned by `publishedPackageNames()`; this only attaches each
 * selected manifest's version by intersecting with the names that helper
 * returns.
 */
export async function readPublishablePackages(
  surfaces: readonly { path: string }[] = VERSION_SURFACES,
): Promise<PublishablePackage[]> {
  const published = new Set(await publishedPackageNames(surfaces));
  const packages: PublishablePackage[] = [];
  for (const surface of surfaces) {
    if (!/^packages\/[^/]+\/package\.json$/.test(surface.path)) continue;
    const pkg = (await Bun.file(surface.path).json()) as { name?: string; version?: string };
    if (!pkg.name || !published.has(pkg.name)) continue;
    packages.push({ name: pkg.name, version: pkg.version ?? "" });
  }
  return packages;
}

/** Names of publishable packages that do not carry the release version. */
export function versionMismatches(packages: readonly PublishablePackage[], version: string): string[] {
  return packages.filter((p) => p.version !== version).map((p) => `${p.name} (has ${p.version || "<missing>"})`);
}

/**
 * Classify every package as `publish` or `skip` for `version`. A status other
 * than 200/404, a thrown request, or a version mismatch refuses the whole set.
 * Exported for tests, which inject `registryFetch`.
 */
export async function decidePublishSet(
  packages: readonly PublishablePackage[],
  version: string,
  registryFetch: RegistryFetch = fetch,
  timeoutMs: number = REGISTRY_TIMEOUT_MS,
): Promise<PublishSetDecision> {
  const mismatches = versionMismatches(packages, version);
  if (mismatches.length) {
    return {
      status: "refused",
      message:
        `Release surfaces are not prepared for ${version}: ${mismatches.join(", ")}. ` +
        `Run bun run release:prepare -- ${version} (or fix the version surfaces) and re-run this release.`,
    };
  }

  const signal = AbortSignal.timeout(timeoutMs);
  const probes = await Promise.all(
    packages.map(async (pkg) => {
      const url = `${REGISTRY_URL}/${encodeURIComponent(pkg.name)}/${version}`;
      try {
        const { status } = await registryFetch(url, { signal });
        if (status === 200) return { pkg, kind: "skip" as const };
        if (status === 404) return { pkg, kind: "publish" as const };
        return { pkg, kind: "unknown" as const, reason: `HTTP ${status} from ${url}` };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { pkg, kind: "unknown" as const, reason: `${url}: ${detail}` };
      }
    }),
  );

  const unknown = probes.filter((probe) => probe.kind === "unknown");
  if (unknown.length) {
    const facts = unknown.map((probe) => `${probe.pkg.name}: ${probe.reason}`).join("; ");
    return {
      status: "refused",
      message:
        `Cannot determine the registry state for ${version} (${facts}). ` +
        `Refusing to publish: an unknown state may be an already-published version. ` +
        `Confirm https://registry.npmjs.org is reachable and re-run this release.`,
    };
  }

  const skip = probes.filter((p) => p.kind === "skip").map((p) => p.pkg.name);
  const publish = probes.filter((p) => p.kind === "publish").map((p) => p.pkg.name);
  return {
    status: "ready",
    skip,
    publish,
    lines: probes.map((p) =>
      p.kind === "skip"
        ? `skip: ${p.pkg.name}@${version} is already on the registry.`
        : `publish: ${p.pkg.name}@${version} is free.`,
    ),
  };
}

async function main(): Promise<void> {
  const version = process.argv.slice(2).find((a) => a !== "--");
  if (!version || !RELEASE_VERSION_RE.test(version)) {
    console.error("Usage: bun run scripts/release-preflight.ts <X.Y.Z[-prerelease]>");
    process.exit(2);
  }

  const decision = await decidePublishSet(await readPublishablePackages(), version);
  if (decision.status === "refused") {
    console.error(`Release preflight FAILED for ${version}.`);
    console.error(decision.message);
    process.exit(1);
  }

  for (const line of decision.lines) console.log(line);
  console.log(
    `\nPreflight OK for ${version}: ${decision.publish.length} to publish, ${decision.skip.length} already published.`,
  );

  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(output, `skip=${decision.skip.join(" ")}\npublish=${decision.publish.join(" ")}\n`);
  }
}

if (import.meta.main) {
  await main();
}
