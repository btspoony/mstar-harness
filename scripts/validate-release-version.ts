#!/usr/bin/env bun
/**
 * validate-release-version.ts — gate: every version surface matches the tag.
 *
 * Usage:
 *   bun run release:validate -- v1.8.7
 *   GITHUB_REF_NAME=v1.8.7 bun run release:validate
 *
 * Reads the surface list from `release-surfaces.ts` (same list
 * `prepare-release.ts` bumps), so a release can never pass a surface it
 * failed to bump.
 *
 * Pre-bump timing (D7: no intermediate releases): during an iteration,
 * `release:validate -- v2.0.0` intentionally exits 1 with all 12 entries
 * compared (0 MISSING) — every surface still carries the previous version.
 * The bump happens at release-prep AFTER the iteration, so exit 1 with
 * 0 MISSING / all-MISMATCH is the expected pre-release state, not a gate
 * failure.
 */
import { INSTALL_REF, RELEASE_VERSION_RE, VERSION_SURFACES, isPrereleaseVersion } from "./release-surfaces.ts";

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

if (!tag) {
  console.error("Usage: bun run scripts/validate-release-version.ts <tag>");
  console.error("       GITHUB_REF_NAME=v1.0.2 bun run scripts/validate-release-version.ts");
  process.exit(1);
}

const version = tag.startsWith("v") ? tag.slice(1) : tag;

if (!RELEASE_VERSION_RE.test(version)) {
  console.error(`Invalid release tag "${tag}". Expected format: vX.Y.Z or vX.Y.Z-<prerelease>`);
  process.exit(1);
}

const installVersionRe = /"version"\s*:\s*"(\d+\.\d+\.\d+)"/;
let failed = false;

for (const { label, path } of VERSION_SURFACES) {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`MISSING ${path}`);
    failed = true;
    continue;
  }
  const json = (await file.json()) as { version?: string };
  if (json.version !== version) {
    console.error(
      `MISMATCH ${label} (${path}): tag ${tag} => ${version}, file has ${json.version ?? "<missing>"}`,
    );
    failed = true;
  } else {
    console.log(`OK ${label}: ${json.version}`);
  }
}

// Prereleases skip it — INSTALL.md stays on the last stable release.
if (isPrereleaseVersion(version)) {
  console.log(`SKIP INSTALL.md (prerelease)`);
} else {
  const install = await Bun.file(INSTALL_REF.path).text();
  const installMatch = install.match(installVersionRe);
  const installVersion = installMatch?.[1];
  if (installVersion !== version) {
    console.error(
      `MISMATCH INSTALL.md (${INSTALL_REF.path}): expected ${version}, found ${installVersion ?? "<missing>"}`,
    );
    failed = true;
  } else {
    console.log(`OK INSTALL.md ZCode marketplace example: ${installVersion}`);
  }
}

// The root manifest is what git/hosted installs (`omp plugin install
// github:…`, `bun add github:…`) resolve, so its runtime engine dependency
// must be the plain semver range `^<version>` — never `workspace:*`, which is
// unresolvable outside the declaring workspace. The engine version itself is
// a VERSION_SURFACES entry (packages/engine/package.json) checked above, so
// the root range must track the release tag.
const rootPkg = (await Bun.file("package.json").json()) as {
  dependencies?: Record<string, string>;
};
const engineSpec = rootPkg.dependencies?.["@mstar-harness/engine"];
const expectedSpec = `^${version}`;
if (engineSpec !== expectedSpec) {
  console.error(
    `MISMATCH root engine dependency (package.json): expected dependencies["@mstar-harness/engine"] = "${expectedSpec}", found ${engineSpec ?? "<missing>"}`,
  );
  failed = true;
} else {
  console.log(`OK root engine dependency: ${engineSpec}`);
}

if (failed) {
  console.error(`\nRelease tag ${tag} does not match all surface versions.`);
  process.exit(1);
}

console.log(`\nAll surfaces aligned at ${version}.`);
