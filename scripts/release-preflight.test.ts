/**
 * scripts/release-preflight.ts — the pre-publish publish/skip decision, and the
 * guard that the Release workflow's publish set equals the non-private
 * workspace packages.
 */
import { readFileSync } from "node:fs";
import {
  type PublishablePackage,
  type RegistryFetch,
  decidePublishSet,
  readPublishablePackages,
  versionMismatches,
} from "./release-preflight.ts";
import { publishedPackageNames } from "./prepare-release.ts";
import type { VersionSurface } from "./release-surfaces.ts";

const PKGS: PublishablePackage[] = [
  { name: "@mstar-harness/engine", version: "4.0.0" },
  { name: "@mstar-harness/cli", version: "4.0.0" },
];

/** Status per package name; anything not listed is a thrown/aborted request. */
function statusFetch(byName: Record<string, number | "throw">): RegistryFetch {
  return async (url) => {
    const name = decodeURIComponent(url.split("/").at(-2) ?? "");
    const status = byName[name];
    if (status === undefined || status === "throw") throw new Error(`network down for ${name}`);
    return { status };
  };
}

describe("decidePublishSet (pre-publish classification)", () => {
  test("200 classifies skip and 404 classifies publish", async () => {
    const decision = await decidePublishSet(
      PKGS,
      "4.0.0",
      statusFetch({ "@mstar-harness/engine": 200, "@mstar-harness/cli": 404 }),
    );
    expect(decision.status).toBe("ready");
    if (decision.status !== "ready") return;
    expect(decision.skip).toEqual(["@mstar-harness/engine"]);
    expect(decision.publish).toEqual(["@mstar-harness/cli"]);
    expect(decision.lines[0]).toContain("skip: @mstar-harness/engine@4.0.0");
    expect(decision.lines[1]).toContain("publish: @mstar-harness/cli@4.0.0");
  });

  test("a non-200/404 status refuses instead of publishing", async () => {
    const decision = await decidePublishSet(
      PKGS,
      "4.0.0",
      statusFetch({ "@mstar-harness/engine": 500, "@mstar-harness/cli": 404 }),
    );
    expect(decision.status).toBe("refused");
    if (decision.status !== "refused") return;
    expect(decision.message).toContain("@mstar-harness/engine");
    expect(decision.message).toContain("HTTP 500");
    expect(decision.message).toContain("re-run");
  });

  test("a thrown/aborted request refuses instead of publishing", async () => {
    const decision = await decidePublishSet(
      PKGS,
      "4.0.0",
      statusFetch({ "@mstar-harness/engine": 200, "@mstar-harness/cli": "throw" }),
    );
    expect(decision.status).toBe("refused");
    if (decision.status !== "refused") return;
    expect(decision.message).toContain("network down for @mstar-harness/cli");
  });

  test("a package version that is not the release version refuses", async () => {
    const decision = await decidePublishSet(
      [{ name: "@mstar-harness/cli", version: "3.11.2" }],
      "4.0.0",
      statusFetch({ "@mstar-harness/cli": 404 }),
    );
    expect(decision.status).toBe("refused");
    if (decision.status !== "refused") return;
    expect(decision.message).toContain("not prepared for 4.0.0");
  });

  test("versionMismatches reports the package and its actual version", () => {
    expect(versionMismatches([{ name: "a", version: "" }, { name: "b", version: "4.0.0" }], "4.0.0")).toEqual([
      "a (has <missing>)",
    ]);
  });
});

describe("readPublishablePackages (reuses publishedPackageNames selection)", () => {
  test("selected names come from the shared rule, with their manifest versions", async () => {
    const surfaces: VersionSurface[] = [
      { label: "root", path: "package.json" },
      { label: "engine", path: "packages/engine/package.json" },
      { label: "commands", path: "packages/commands/package.json" },
    ];
    const names = await publishedPackageNames(surfaces);
    const packages = await readPublishablePackages(surfaces);
    expect(packages.map((p) => p.name)).toEqual(names);
    expect(packages.every((p) => p.version === "4.0.0")).toBe(true);
  });

  test("the real workspace excludes the private commands package", async () => {
    expect(await publishedPackageNames()).not.toContain("@mstar-harness/commands");
  });
});

describe("Release workflow publish set (incident-class guard)", () => {
  // Fails CI's scripts shard when the workflow publishes a private package or
  // omits a publishable one.
  test("every `npm publish --workspace <name>` equals the non-private workspace packages", async () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    const published = [...workflow.matchAll(/npm publish --workspace (\S+)/g)].map((m) => m[1]);
    expect(published.length).toBeGreaterThan(0);
    expect([...published].sort()).toEqual((await publishedPackageNames()).sort());
  });

  // The release has exactly one entry point: a merged `release vX.Y.Z` PR. A
  // manual dispatch is refused by construction because this publish job holds
  // `id-token: write` + `contents: write`, and a dispatched branch could carry
  // its own copy of the workflow with the guards removed.
  test("the release workflow has no manual entry point", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    expect(workflow).not.toContain("workflow_dispatch");
    expect(workflow).not.toContain("inputs.commit");
    expect(workflow).toContain("github.event.pull_request.merge_commit_sha");
    expect(workflow).toContain("types: [closed]");
  });
});
