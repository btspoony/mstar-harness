#!/usr/bin/env bun
/**
 * Release-time helper: rewrite the internal `@mstar-harness/engine` dependency
 * spec from `workspace:*` to the concrete release version in the manifests
 * that get PUBLISHED (packages/cli, packages/opencode). npm publish does not
 * understand the workspace protocol, so the published package.json must carry
 * a real semver spec (engine is published first in release.yml, so the spec
 * resolves from the registry at consumer-install time).
 *
 * The checked-in manifests intentionally keep `workspace:*` so bun install
 * always resolves the engine from the monorepo workspace (no registry round
 * trip, no version-skew 404s). Only the publish-time copies are rewritten.
 */
import { readFileSync, writeFileSync } from "node:fs";

const engineVersion = JSON.parse(
  readFileSync(new URL("../packages/engine/package.json", import.meta.url), "utf8"),
).version;

const targets = ["../packages/cli/package.json", "../packages/opencode/package.json"];

for (const rel of targets) {
  const p = new URL(rel, import.meta.url);
  const manifest = JSON.parse(readFileSync(p, "utf8"));
  if (manifest.dependencies?.["@mstar-harness/engine"] === "workspace:*") {
    manifest.dependencies["@mstar-harness/engine"] = engineVersion;
    writeFileSync(p, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log(`${rel} -> @mstar-harness/engine@${manifest.dependencies["@mstar-harness/engine"]}`);
}
