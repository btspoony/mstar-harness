#!/usr/bin/env bun

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

if (!tag) {
  console.error("Usage: bun run scripts/validate-release-version.ts <tag>");
  console.error("       GITHUB_REF_NAME=v1.0.2 bun run scripts/validate-release-version.ts");
  process.exit(1);
}

const version = tag.startsWith("v") ? tag.slice(1) : tag;

if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`Invalid release tag "${tag}". Expected format: vX.Y.Z`);
  process.exit(1);
}

const surfaces: Array<{ label: string; path: string }> = [
  { label: "root package.json", path: "package.json" },
  { label: "@mstar-harness/cli", path: "packages/cli/package.json" },
  { label: "@mstar-harness/opencode", path: "packages/opencode/package.json" },
  { label: "Cursor plugin", path: ".cursor-plugin/plugin.json" },
  { label: "Codex plugin", path: ".codex-plugin/plugin.json" },
];

let failed = false;

for (const { label, path } of surfaces) {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`MISSING ${path}`);
    failed = true;
    continue;
  }

  const json = (await file.json()) as { version?: string };
  const fileVersion = json.version;

  if (fileVersion !== version) {
    console.error(
      `MISMATCH ${label} (${path}): tag ${tag} => ${version}, file has ${fileVersion ?? "<missing>"}`,
    );
    failed = true;
  } else {
    console.log(`OK ${label}: ${fileVersion}`);
  }
}

if (failed) {
  console.error(`\nRelease tag ${tag} does not match all surface versions.`);
  process.exit(1);
}

console.log(`\nAll surfaces aligned at ${version}.`);
