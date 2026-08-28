/**
 * scripts/ci-packed-manifest-guard.ts — `workspace:` spec scan semantics.
 */
import { describe, expect, test } from "bun:test";
import { findWorkspaceSpecs } from "./ci-packed-manifest-guard.ts";

describe("findWorkspaceSpecs (packed manifest workspace: guard)", () => {
  test("flags workspace: specs in dependencies, peerDependencies, optionalDependencies", () => {
    const hits = findWorkspaceSpecs({
      dependencies: { "@mstar-harness/engine": "workspace:*" },
      peerDependencies: { zod: "workspace:^" },
      optionalDependencies: { fsevents: "workspace:~1.0.0" },
    });
    expect(hits).toEqual([
      'dependencies["@mstar-harness/engine"] = "workspace:*"',
      'peerDependencies["zod"] = "workspace:^"',
      'optionalDependencies["fsevents"] = "workspace:~1.0.0"',
    ]);
  });

  test("semver ranges and non-workspace protocols pass", () => {
    expect(
      findWorkspaceSpecs({
        dependencies: { "@mstar-harness/engine": "^3.5.0", zod: "^4.0.0" },
        peerDependencies: { react: ">=18" },
        optionalDependencies: { fsevents: "^2.3.3" },
      }),
    ).toEqual([]);
  });

  test("devDependencies are exempt (not shipped)", () => {
    expect(
      findWorkspaceSpecs({
        devDependencies: { "@mstar-harness/engine": "workspace:*" },
      }),
    ).toEqual([]);
  });

  test("missing dependency sections pass", () => {
    expect(findWorkspaceSpecs({})).toEqual([]);
  });
});
